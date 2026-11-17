import { createHash } from 'node:crypto';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore } from '@tmanage/storage';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { StorageMigrationJobRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  ProviderHashMismatchError,
  ProviderObjectUnavailableError,
  VersionStore,
} from '../files/provider-objects.js';
import type { ProviderObjectSources } from '../files/provider-objects.js';
import {
  STORAGE_BYTES_METRIC,
  UsageCountersRepository,
} from '../files/usage-counters.repository.js';
import { USAGE_LEDGER_REASON, UsageLedgerRepository } from '../files/usage-ledger.repository.js';
import { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { StorageHandoverRepository } from './storage-handover.repository.js';
import { live } from './storage-handover.service.js';
import { StorageMoveRepository } from './storage-move.repository.js';
import type { MoveCandidate } from './storage-move.repository.js';
import type { StorageMoveRequester } from './storage-move.service.js';
import { integrationOnForJob } from '../platform-admin/settings/integration-switch.js';

/**
 * 57-13b. The "Move to Drive" job: the background half of `storage-move.service.ts`.
 *
 * A pass finds the companies with a live job (a `bootstrapRead` over `storage_migration_jobs`,
 * organization ids only), and for each, under its own service context, claims the job and moves
 * up to {@link MoveOptions.batch} files, pausing {@link MoveOptions.pauseMs} between them so one
 * company's move never floods its provider or TManage's disk. Per file, in this order:
 *
 * 1. read the local private object and require its SHA-256 to be the version's `content_hash`;
 * 2. upload it into the connection's own TManage folder and read the copy back
 *    (`VersionStore.copyToProvider`): a different SHA-256 removes the copy, and the file stays
 *    local, counted `failed`;
 * 3. one transaction flips the version to the provider (only while it is still `local`), gives
 *    its bytes back on `storage.bytes` with the ledger row its `file.moved_to_provider.v1` event
 *    sources, advances the job's cursor and counts, and names the object in `pending_object_key`;
 * 4. only after that commit is the local copy deleted, and `pending_object_key` cleared.
 *
 * Never deletes on doubt: a hash that differs, a read that fails, a version flipped by someone
 * else, or any error before the commit leaves the local copy where it is. A crash between 3 and 4
 * is repaired first thing on the next pass (the delete is idempotent). A revoked grant, a
 * connection that changed, or an unreachable provider stops the job cleanly (`stopped`, `error`)
 * with everything already moved still readable; the owner can start again, and the cursor plus
 * the `local`-only flip make every pass resumable and idempotent. Files over
 * {@link MAX_MOVE_FILE_BYTES} stay local (`skipped`): a copy is read whole into memory.
 *
 * Runs in-process (the single Hostinger app has no cron), off unless `WORKER_INPROCESS=1` or
 * `STORAGE_MOVE_INPROCESS=1`, like the privacy job; it runs in the API because the token vault
 * and the Drive/Graph transports live there, so the worker needs no provider access.
 */
export const STORAGE_MOVE_JOB = Symbol.for('tmanage.StorageMoveJob');

export const MAX_MOVE_FILE_BYTES = 100 * 1024 * 1024;
export const STALE_CLAIM_MS = 15 * 60_000;
const POLICY_VERSION = 'storage-move-job';
const FIND_JOBS_REASON =
  'finding which organizations have a "Move to Drive" job waiting, so each is worked under its ' +
  'own service context (57-13b)';

export interface MoveOptions {
  readonly batch: number;
  readonly pauseMs: number;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
}

export const DEFAULT_MOVE_OPTIONS: MoveOptions = {
  batch: 10,
  pauseMs: 500,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.warn(line),
};

export function storageMoveJobEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WORKER_INPROCESS'] === '1' || env['STORAGE_MOVE_INPROCESS'] === '1';
}

export interface StorageMovePassReport {
  readonly moved: number;
  readonly failed: number;
  readonly skipped: number;
  readonly finished: number;
}

type FileOutcome = 'moved' | 'failed' | 'skipped' | { readonly stop: string };

/** Why a provider failure stops the job instead of skipping one file. */
function stopReason(error: ProviderObjectUnavailableError): string | null {
  if (error.reason === 'too_large') return null;
  return error.reason === 'not_connected' ? 'not_connected' : 'provider_unavailable';
}

export class StorageMovePass {
  private readonly versions: VersionStore;

  constructor(
    private readonly database: TenantDatabase,
    private readonly store: Pick<ObjectStore, 'openObject' | 'remove'>,
    providers: ProviderObjectSources,
    private readonly audit: Pick<AuditService, 'record'> | undefined,
    private readonly options: MoveOptions = DEFAULT_MOVE_OPTIONS,
    private readonly jobs: StorageMoveRepository = new StorageMoveRepository(),
    private readonly connections: Pick<
      StorageHandoverRepository,
      'findConnection'
    > = new StorageHandoverRepository(),
    private readonly outbox: Pick<OutboxEventsRepository, 'append'> = new OutboxEventsRepository(),
    private readonly counters: Pick<
      UsageCountersRepository,
      'releaseUsed'
    > = new UsageCountersRepository(),
    private readonly ledger: Pick<UsageLedgerRepository, 'record'> = new UsageLedgerRepository(),
  ) {
    this.versions = new VersionStore(store, providers);
  }

  async run(): Promise<StorageMovePassReport> {
    const correlationId = uuidv7();
    const staleBefore = new Date(this.options.now().getTime() - STALE_CLAIM_MS);
    const organizations = await this.database.bootstrapRead(
      { correlationId, reason: FIND_JOBS_REASON, tables: ['storage_migration_jobs'] },
      (db) => this.jobs.organizationsWithLiveJobs(db, staleBefore),
    );
    const report = { moved: 0, failed: 0, skipped: 0, finished: 0 };
    for (const organizationId of organizations) {
      const context = createServiceContext({
        organizationId,
        correlationId: uuidv7(),
        policyVersion: POLICY_VERSION,
      });
      const job = await this.database.read(context, (runner) =>
        this.jobs.findActive(runner, context),
      );
      if (!job) continue;
      // The service is switched off for the platform: leave the job untouched until it is on.
      if (!(await integrationOnForJob(this.database, job.backend, correlationId))) continue;
      const claimed = await this.database.transaction(context, (tx) =>
        this.jobs.claim(tx, context, job.id, this.options.now(), staleBefore),
      );
      if (!claimed) continue;
      try {
        if (await this.work(context, job, report)) report.finished += 1;
        else
          await this.database.transaction(context, (tx) =>
            this.jobs.release(tx, context, job.id, this.options.now()),
          );
      } catch (error) {
        // Unexpected: the claim lapses after STALE_CLAIM_MS and a later pass resumes the job.
        this.options.log(`storage-move: job ${job.id} pass failed: ${describe(error)}`);
      }
    }
    return report;
  }

  /** One pass over one job. Answers whether the job finished (done or stopped). */
  private async work(
    context: TenantContext,
    job: StorageMigrationJobRow,
    report: { moved: number; failed: number; skipped: number },
  ): Promise<boolean> {
    if (job.pendingObjectKey !== null) {
      // A crash after a flip and before its delete: finish that delete before anything else.
      if (!(await this.removeLocal(context, job.id, job.pendingObjectKey))) return false;
    }
    const connection = live(
      await this.database.read(context, (runner) =>
        this.connections.findConnection(runner, context, job.backend),
      ),
    );
    if (!connection || connection.id !== job.storageConnectionId) {
      return this.finish(
        context,
        job,
        'stopped',
        connection ? 'connection_changed' : 'not_connected',
      );
    }
    const candidates = await this.database.read(context, (runner) =>
      this.jobs.nextCandidates(runner, context, job.cursorVersionId ?? '', this.options.batch),
    );
    if (candidates.length === 0) return this.finish(context, job, 'done', null);
    for (const [index, candidate] of candidates.entries()) {
      if (index > 0) await this.options.sleep(this.options.pauseMs);
      const outcome = await this.moveOne(context, job, candidate);
      if (typeof outcome === 'object') return this.finish(context, job, 'stopped', outcome.stop);
      report[outcome] += 1;
    }
    return false;
  }

  private async moveOne(
    context: TenantContext,
    job: StorageMigrationJobRow,
    file: MoveCandidate,
  ): Promise<FileOutcome> {
    // The query is tenant-scoped; a row of any other company is never read, copied or deleted.
    if (file.organizationId !== context.organizationId)
      return this.count(context, job, file, 'skipped');
    if (file.sizeBytes > MAX_MOVE_FILE_BYTES) return this.count(context, job, file, 'skipped');
    const bytes = await this.readLocal(file);
    if (bytes === null) return this.count(context, job, file, 'failed');
    let ref;
    try {
      ref = await this.versions.copyToProvider(context, job.backend, {
        name: file.name,
        mimeType: file.mimeType,
        bytes,
      });
    } catch (error) {
      if (error instanceof ProviderHashMismatchError)
        return this.count(context, job, file, 'failed');
      if (error instanceof ProviderObjectUnavailableError) {
        const stop = stopReason(error);
        return stop === null ? this.count(context, job, file, 'skipped') : { stop };
      }
      throw error;
    }
    if (ref.connectionId !== job.storageConnectionId) {
      await this.versions.removeFromProvider(context, job.backend, ref);
      return { stop: 'connection_changed' };
    }
    const now = this.options.now();
    const flipped = await this.database.transaction(context, async (tx) => {
      if (!(await this.jobs.flip(tx, context, file.id, job.backend, ref))) return false;
      const moved = await this.counters.releaseUsed(
        tx,
        context,
        STORAGE_BYTES_METRIC,
        file.sizeBytes,
      );
      const eventId = await this.outbox.append(tx, context, {
        type: 'file.moved_to_provider.v1',
        aggregateId: file.fileAssetId,
        payload: {
          fileAssetId: file.fileAssetId,
          fileVersionId: file.id,
          backend: job.backend,
          storageMigrationJobId: job.id,
          metricKey: STORAGE_BYTES_METRIC,
          deltaBytes: file.sizeBytes,
        },
      });
      // As the purge does: a drifted counter that refused the move records no ledger row.
      if (moved) {
        await this.ledger.record(tx, context, {
          uploadSessionId: file.id,
          counter: 'used',
          deltaBytes: -file.sizeBytes,
          reason: USAGE_LEDGER_REASON.movedToProvider,
          sourceEventId: eventId,
        });
      }
      await this.jobs.advance(
        tx,
        context,
        job.id,
        {
          moved: 1,
          failed: 0,
          skipped: 0,
          movedBytes: file.sizeBytes,
          cursorVersionId: file.id,
          pendingObjectKey: file.objectKey,
        },
        now,
      );
      return true;
    });
    if (!flipped) {
      // Moved meanwhile by another pass: this copy is a spare; the local object is not ours to delete.
      await this.versions.removeFromProvider(context, job.backend, ref);
      return this.count(context, job, file, 'skipped');
    }
    await this.removeLocal(context, job.id, file.objectKey);
    return 'moved';
  }

  /** The local bytes, only when they are whole and hash to the version's own `content_hash`. */
  private async readLocal(file: MoveCandidate): Promise<Buffer | null> {
    try {
      const opened = await this.store.openObject({ zone: 'private', objectKey: file.objectKey });
      const bytes = await readCapped(opened.stream, file.sizeBytes);
      if (bytes === null || bytes.length !== file.sizeBytes) return null;
      const digest = createHash('sha256').update(bytes).digest('hex');
      return digest === file.contentHash.toLowerCase() ? bytes : null;
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return null;
      throw error;
    }
  }

  /** Delete a flipped version's local copy, then clear the job's pending key. */
  private async removeLocal(
    context: TenantContext,
    jobId: string,
    objectKey: string,
  ): Promise<boolean> {
    try {
      await this.store.remove({ zone: 'private', objectKey });
    } catch (error) {
      // Kept in `pending_object_key`: the next pass deletes it before moving anything else.
      this.options.log(`storage-move: job ${jobId} local delete deferred: ${describe(error)}`);
      return false;
    }
    await this.database.transaction(context, (tx) =>
      this.jobs.clearPending(tx, context, jobId, this.options.now()),
    );
    return true;
  }

  private async count(
    context: TenantContext,
    job: StorageMigrationJobRow,
    file: MoveCandidate,
    outcome: 'failed' | 'skipped',
  ): Promise<'failed' | 'skipped'> {
    await this.database.transaction(context, (tx) =>
      this.jobs.advance(
        tx,
        context,
        job.id,
        {
          moved: 0,
          failed: outcome === 'failed' ? 1 : 0,
          skipped: outcome === 'skipped' ? 1 : 0,
          movedBytes: 0,
          cursorVersionId: file.id,
          pendingObjectKey: null,
        },
        this.options.now(),
      ),
    );
    return outcome;
  }

  private async finish(
    context: TenantContext,
    job: StorageMigrationJobRow,
    status: 'done' | 'stopped',
    error: string | null,
  ): Promise<true> {
    await this.database.transaction(context, async (tx) => {
      if (!(await this.jobs.finish(tx, context, job.id, status, error, this.options.now()))) return;
      const row = await this.jobs.findById(tx, context, job.id);
      await this.audit?.record(tx, context, {
        action: 'storage_migration.finished',
        result: status === 'done' ? 'allowed' : 'error',
        objectId: job.id,
        metadata: {
          provider: job.backend,
          status,
          reason: error ?? 'none',
          moved: row?.moved ?? 0,
          failed: row?.failed ?? 0,
          skipped: row?.skipped ?? 0,
        },
      });
    });
    return true;
  }
}

async function readCapped(stream: NodeJS.ReadableStream, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > max) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

/** The timer around {@link StorageMovePass}: boot, interval, and a debounced request after a start. */
export class StorageMoveJob
  implements StorageMoveRequester, OnApplicationBootstrap, OnModuleDestroy
{
  private running: Promise<void> | null = null;
  private again = false;
  private pending: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly pass: Pick<StorageMovePass, 'run'>,
    private readonly enabled: boolean,
    private readonly timing: {
      readonly debounceMs: number;
      readonly bootDelayMs: number;
      readonly intervalMs: number;
    } = { debounceMs: 2_000, bootDelayMs: 20_000, intervalMs: 60_000 },
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.schedule(this.timing.bootDelayMs);
    this.interval = setInterval(() => this.request(), this.timing.intervalMs);
    this.interval.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.pending) clearTimeout(this.pending);
    if (this.interval) clearInterval(this.interval);
    this.pending = null;
    this.interval = null;
    await this.running;
  }

  request(): void {
    if (!this.enabled || this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.schedule(this.timing.debounceMs);
  }

  private schedule(delayMs: number): void {
    if (this.pending || this.stopped) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.running = this.runOnce().finally(() => {
        this.running = null;
        if (this.again && !this.stopped) {
          this.again = false;
          this.schedule(this.timing.debounceMs);
        }
      });
    }, delayMs);
    this.pending.unref();
  }

  private async runOnce(): Promise<void> {
    try {
      const report = await this.pass.run();
      if (report.moved + report.failed + report.skipped + report.finished > 0) {
        this.log(
          `storage-move: moved=${report.moved} failed=${report.failed} skipped=${report.skipped} ` +
            `finished=${report.finished}`,
        );
        // More files may be waiting: the next batch follows after the debounce, not the interval.
        if (report.moved + report.failed + report.skipped > 0) this.again = true;
      }
    } catch (error) {
      this.log(`storage-move: pass failed: ${describe(error)}`);
    }
  }
}
