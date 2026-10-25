import { PassThrough } from 'node:stream';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PrivacyDeletionRequestRow, PrivacyExportRow } from '../../common/database/schema.js';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import { ScannerUnavailableError } from '../../common/scan/malware-scanner.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { PrivacyArchiveBuilder, packArchive } from './privacy-archive.repository.js';
import type { ArchiveDocument, ArchiveHeader } from './privacy-archive.repository.js';
import { EXPORT_LINK_DAYS, addDays, privacyExportObjectKey } from './privacy-policy.js';
import { PrivacyRepository } from './privacy.repository.js';
import type { PrivacyJobRequester } from './privacy.service.js';

/**
 * D5 (Figma F5) — the privacy job: the background half of the data-rights workflow.
 *
 * One pass does three things, each cross-tenant only in *finding* work (a `bootstrapRead` over the
 * two privacy tables) and tenant-scoped in *doing* it (a service context per organization):
 *
 * 1. **Build exports.** A `preparing` export is claimed (conditional on its version, so two passes
 *    never build one archive twice; a claim older than {@link STALE_CLAIM_MS} is retaken), its
 *    sections are read with progress written as it goes, and the packed archive is written into the
 *    store's private zone **through the malware scanner** — the scan pass's tee: the same bytes feed
 *    the scanner and the staging sink, and the sink is committed only on `clean`. Without a scanner
 *    (`MALWARE_SCAN_DRIVER=none`) the archive is committed `not_scanned`, and the download route then
 *    applies the owner's "downloads before a virus scan" policy exactly as it does to a file. The row
 *    becomes `ready` with a link that works for {@link EXPORT_LINK_DAYS} days, or `failed`.
 * 2. **Expire exports.** A ready archive whose link date has passed has its bytes removed.
 * 3. **Carry out deletions.** A `scheduled` deletion whose grace period has ended is executed: an
 *    account deletion offboards that membership (the person's shared work stays, shown as a former
 *    member); a company deletion closes the organization (archived + suspended, which every member's
 *    and client's sign-in refuses) and removes its export archives. Each is audited and announced on
 *    the outbox. A last owner's account is not removed — that request waits, and says so on stderr.
 *
 * Runs in-process (the single Hostinger app has no cron), off unless `WORKER_INPROCESS=1` or
 * `PRIVACY_JOBS_INPROCESS=1`, exactly like the file scan job, so a suite never races a pass.
 */
export const PRIVACY_JOB = Symbol.for('tmanage.PrivacyJob');

export const STALE_CLAIM_MS = 30 * 60_000;
const EXPORT_BATCH = 5;
const POLICY_VERSION = 'privacy-job';

const FIND_EXPORTS_REASON =
  'finding which organizations hold data-export requests waiting to be built or expired, so each ' +
  'is handled under its own service context (D5, 33-LEGAL §8)';
const FIND_DELETIONS_REASON =
  'finding which organizations hold deletion requests whose grace period has ended, so each is ' +
  'carried out under its own service context (D5, 33-LEGAL §8)';

export interface PrivacyJobOptions {
  readonly debounceMs: number;
  readonly bootDelayMs: number;
  readonly intervalMs: number;
  readonly log: (line: string) => void;
}

export const DEFAULT_PRIVACY_JOB_OPTIONS: PrivacyJobOptions = {
  debounceMs: 2_000,
  bootDelayMs: 15_000,
  intervalMs: 10 * 60_000,
  log: (line) => console.warn(line),
};

export function privacyJobEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WORKER_INPROCESS'] === '1' || env['PRIVACY_JOBS_INPROCESS'] === '1';
}

export interface PrivacyPassReport {
  readonly built: number;
  readonly failed: number;
  readonly purged: number;
  readonly deletionsExecuted: number;
  readonly deletionsWaiting: number;
}

/** The scanner fact and call the job needs. */
type Scanner = Pick<MalwareScanner, 'kind' | 'probe' | 'scan'>;

export class PrivacyPass {
  constructor(
    private readonly database: TenantDatabase,
    private readonly store: ObjectStore,
    private readonly scanner: Scanner | undefined,
    private readonly audit: AuditService | undefined,
    private readonly outbox: OutboxEventsRepository | undefined,
    private readonly repository: PrivacyRepository = new PrivacyRepository(),
    private readonly builder: Pick<PrivacyArchiveBuilder, 'build'> = new PrivacyArchiveBuilder(
      database,
    ),
    private readonly now: () => Date = () => new Date(),
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  async run(): Promise<PrivacyPassReport> {
    const correlationId = uuidv7();
    const now = this.now();
    const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
    let built = 0;
    let failed = 0;
    let purged = 0;
    let deletionsExecuted = 0;
    let deletionsWaiting = 0;

    const tables = ['privacy_exports'];
    const preparing = await this.database.bootstrapRead(
      { correlationId, reason: FIND_EXPORTS_REASON, tables },
      (db) => this.repository.organizationsWithPreparingExports(db, staleBefore),
    );
    for (const organizationId of preparing) {
      const context = serviceContext(organizationId, correlationId);
      const rows = await this.database.read(context, (runner) =>
        this.repository.listClaimableExports(runner, context, staleBefore, EXPORT_BATCH),
      );
      for (const row of rows) {
        const outcome = await this.buildOne(serviceContext(organizationId, uuidv7()), row);
        if (outcome === 'ready') built += 1;
        else if (outcome === 'failed') failed += 1;
      }
    }

    const expired = await this.database.bootstrapRead(
      { correlationId, reason: FIND_EXPORTS_REASON, tables },
      (db) => this.repository.organizationsWithExpiredExports(db, now),
    );
    for (const organizationId of expired) {
      purged += await this.purge(serviceContext(organizationId, correlationId), false);
    }

    const due = await this.database.bootstrapRead(
      { correlationId, reason: FIND_DELETIONS_REASON, tables: ['privacy_deletion_requests'] },
      (db) => this.repository.organizationsWithDueDeletions(db, now),
    );
    for (const organizationId of due) {
      const context = serviceContext(organizationId, correlationId);
      const rows = await this.database.read(context, (runner) =>
        this.repository.listDueDeletions(runner, context, now),
      );
      for (const row of rows) {
        const done = await this.executeDeletion(serviceContext(organizationId, uuidv7()), row);
        if (done) deletionsExecuted += 1;
        else deletionsWaiting += 1;
      }
    }

    return { built, failed, purged, deletionsExecuted, deletionsWaiting };
  }

  /** Claim, build, scan, store, record. */
  async buildOne(
    context: TenantContext,
    row: PrivacyExportRow,
  ): Promise<'ready' | 'failed' | 'skipped'> {
    const claimed = await this.database.transaction(context, (tx) =>
      this.repository.claimExport(tx, context, row, this.now()),
    );
    if (!claimed) return 'skipped';

    let document: ArchiveDocument;
    try {
      const org = await this.database.read(context, (runner) =>
        this.repository.organization(runner, context),
      );
      if (!org) return this.fail(context, row, 'organization_missing');
      const header: ArchiveHeader = {
        format: 'tmanage-data-export',
        formatVersion: 1,
        kind: row.kind,
        organization: { id: org.id, name: org.name },
        subjectUserId: row.subjectUserId,
        generatedAt: this.now().toISOString(),
      };
      document = await this.builder.build(context, header, async (share) => {
        await this.database.transaction(context, (tx) =>
          this.repository.setProgress(tx, context, row.id, 5 + share * 85, this.now()),
        );
      });
    } catch (error) {
      this.log(`[privacy] export ${row.id} could not be read: ${describe(error)}`);
      return this.fail(context, row, 'read_failed');
    }

    const bytes = packArchive(document);
    const objectKey = privacyExportObjectKey(context.organizationId, row.id);
    let scanStatus: 'clean' | 'not_scanned';
    try {
      const verdict = await this.storeThroughScanner(objectKey, bytes);
      if (verdict === 'infected') return this.fail(context, row, 'malware_detected');
      scanStatus = verdict;
    } catch (error) {
      if (error instanceof ScannerUnavailableError) {
        // The engine is down: the claim stands and the export is retried after the claim's bound.
        this.log(`[privacy] export ${row.id} waits for the scanner: ${error.message}`);
        return 'skipped';
      }
      this.log(`[privacy] export ${row.id} could not be stored: ${describe(error)}`);
      return this.fail(context, row, 'store_failed');
    }

    const now = this.now();
    const expiresAt = addDays(now, EXPORT_LINK_DAYS);
    await this.database.transaction(context, async (tx) => {
      const moved = await this.repository.markExportReady(tx, context, row.id, {
        objectKey,
        sizeBytes: bytes.length,
        scanStatus,
        now,
        expiresAt,
      });
      if (!moved) return;
      await this.audit?.record(tx, context, {
        action: 'privacy_export.ready',
        objectId: row.id,
        result: 'allowed',
        actorUserId: null,
        metadata: { kind: row.kind, size_bytes: bytes.length, scan_status: scanStatus },
      });
      await this.outbox?.append(tx, context, {
        type: 'privacy_export.ready.v1',
        aggregateId: row.id,
        payload: {
          exportId: row.id,
          kind: row.kind,
          requestedByUserId: row.requestedByUserId,
          subjectUserId: row.subjectUserId,
        },
      });
    });
    return 'ready';
  }

  /**
   * The archive's one write into the private zone, as the scan pass writes a file: one promotion
   * whose sink and the scanner read the same bytes; commit on `clean` (or with no scanner), abort on
   * `infected` or any error, so a rejected archive never leaves a servable object behind.
   */
  async storeThroughScanner(
    objectKey: string,
    bytes: Buffer,
  ): Promise<'clean' | 'not_scanned' | 'infected'> {
    const engine = this.scanner !== undefined && this.scanner.kind === 'engine';
    if (engine) await this.scanner?.probe();
    const promotion = await this.store.promote({ objectKey, sizeBytes: bytes.length });
    try {
      if (!engine || !this.scanner) {
        promotion.sink.write(bytes);
        await promotion.commit();
        return 'not_scanned';
      }
      const feed = new PassThrough();
      const verdict = this.scanner.scan({ stream: feed, sizeBytes: bytes.length });
      promotion.sink.write(bytes);
      feed.end(bytes);
      const result = await verdict;
      if (result.verdict !== 'clean') {
        await promotion.abort();
        return 'infected';
      }
      await promotion.commit();
      return 'clean';
    } catch (error) {
      await promotion.abort().catch(() => undefined);
      throw error;
    }
  }

  private async fail(
    context: TenantContext,
    row: PrivacyExportRow,
    failureCode: string,
  ): Promise<'failed'> {
    await this.database.transaction(context, async (tx) => {
      const moved = await this.repository.markExportFailed(
        tx,
        context,
        row.id,
        failureCode,
        this.now(),
      );
      if (!moved) return;
      await this.audit?.record(tx, context, {
        action: 'privacy_export.failed',
        objectId: row.id,
        result: 'allowed',
        actorUserId: null,
        metadata: { kind: row.kind, failure: failureCode },
      });
    });
    return 'failed';
  }

  /** Remove expired (or, for a closed company, all) archives' bytes. Returns how many. */
  async purge(context: TenantContext, all: boolean): Promise<number> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.listPurgeableExports(runner, context, this.now(), all),
    );
    let count = 0;
    for (const row of rows) {
      if (row.objectKey !== null) {
        await this.store.remove({ zone: 'private', objectKey: row.objectKey });
      }
      await this.database.transaction(context, (tx) =>
        this.repository.markExportPurged(tx, context, row.id, this.now()),
      );
      count += 1;
    }
    return count;
  }

  /** Carry out one due deletion. False when it must wait (the last owner's account). */
  async executeDeletion(context: TenantContext, row: PrivacyDeletionRequestRow): Promise<boolean> {
    const now = this.now();
    const done = await this.database.transaction(context, async (tx) => {
      await this.repository.lockOrganization(tx, context);
      if (row.kind === 'account') {
        if (row.subjectUserId === null) return false;
        const owners = await this.repository.activeOwnerCount(tx, context);
        const members = await this.repository.activeMembers(tx, context);
        const subject = members.find((member) => member.userId === row.subjectUserId);
        if (subject?.role === 'owner' && owners <= 1) {
          this.log(`[privacy] account deletion ${row.id} waits: the person is the only owner`);
          return false;
        }
        await this.repository.offboardMember(tx, context, row.subjectUserId, now);
      } else {
        await this.repository.closeOrganization(tx, context, now);
      }
      const moved = await this.repository.markDeletionExecuted(tx, context, row, now);
      if (!moved) return false;
      await this.audit?.record(tx, context, {
        action: 'privacy_deletion.executed',
        objectId: row.id,
        result: 'allowed',
        actorUserId: null,
        metadata: { kind: row.kind },
      });
      await this.outbox?.append(tx, context, {
        type: 'privacy_deletion.changed.v1',
        aggregateId: row.id,
        payload: {
          requestId: row.id,
          kind: row.kind,
          status: 'executed',
          actorUserId: row.requestedByUserId,
          subjectUserId: row.subjectUserId,
          scheduledFor: row.scheduledFor.toISOString(),
        },
      });
      return true;
    });
    if (done && row.kind === 'company') await this.purge(context, true);
    return done;
  }
}

function serviceContext(organizationId: string, correlationId: string): TenantContext {
  return createServiceContext({ organizationId, correlationId, policyVersion: POLICY_VERSION });
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

/** The timer around {@link PrivacyPass}: boot, interval, and a debounced request after a write. */
export class PrivacyJob implements PrivacyJobRequester, OnApplicationBootstrap, OnModuleDestroy {
  private running: Promise<void> | null = null;
  private again = false;
  private pending: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly pass: Pick<PrivacyPass, 'run'>,
    private readonly enabled: boolean,
    private readonly options: PrivacyJobOptions = DEFAULT_PRIVACY_JOB_OPTIONS,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.schedule(this.options.bootDelayMs);
    this.interval = setInterval(() => this.request(), this.options.intervalMs);
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
    this.schedule(this.options.debounceMs);
  }

  private schedule(delayMs: number): void {
    if (this.pending || this.stopped) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.running = this.runOnce().finally(() => {
        this.running = null;
        if (this.again && !this.stopped) {
          this.again = false;
          this.schedule(this.options.debounceMs);
        }
      });
    }, delayMs);
    this.pending.unref();
  }

  private async runOnce(): Promise<void> {
    try {
      const report = await this.pass.run();
      if (report.built + report.failed + report.purged + report.deletionsExecuted > 0) {
        this.options.log(
          `[privacy] built ${String(report.built)}, failed ${String(report.failed)}, purged ` +
            `${String(report.purged)}, deletions ${String(report.deletionsExecuted)}`,
        );
      }
    } catch (error) {
      this.options.log(`[privacy] pass failed: ${describe(error)}`);
    }
  }
}
