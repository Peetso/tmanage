import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import { ObjectNotFoundError, derivativeObjectKey } from '@tmanage/storage';
import type { ObjectStore } from '@tmanage/storage';
import { ObjectStoreUnavailableError } from '../../common/storage/storage.module.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { PREVIEW_MAX_ATTEMPTS } from './file-previews.repository.js';
import type { FilePreview, FilePreviewsRepository } from './file-previews.repository.js';
import {
  DEFAULT_PREVIEW_LIMITS,
  PREVIEW_GENERATORS,
  generatorFor,
  previewMimeTypes,
  previewPlanFor,
} from './preview-generators/index.js';
import type {
  PreviewGenerator,
  PreviewLimits,
  PreviewOutcome,
} from './preview-generators/index.js';
import { describeFailure } from './upload-session-sweeper.js';

/**
 * R4 slice 3 — the preview job: TManage's own derivatives of an uploaded file (SPEC R4 §3.5).
 *
 * The scan job's shape (`file-scan-job.ts`), on Hostinger's one Node process: off unless this
 * process runs background work (`WORKER_INPROCESS=1`, or `FILE_PREVIEW_INPROCESS=1` for a local
 * API); once shortly after boot; on an interval; and on request (the scan job asks after a pass
 * that made files ready, so a fresh upload's thumbnail follows within seconds, not minutes).
 * `preview:once` (`src/preview.ts`) runs one {@link PreviewJob.pass} from a CLI.
 *
 * One pass, in two steps:
 *
 * 1. **Plan.** Every promoted, clean version of a type a generator reads, whose asset is `ready`
 *    and that has no derivative row yet, gets its starting rows (`ensurePending`, idempotent).
 *    Discovery rather than an outbox consumer: it needs no worker wiring, and the first pass
 *    after a deploy plans the files uploaded before the job existed.
 * 2. **Draw.** Pending rows nobody holds are taken a batch at a time and grouped by version.
 *    Each version's private object is read **once** and handed, with every row it still needs,
 *    to its one generator; each answer is recorded on its own row:
 *    - ready → the bytes go to the `derived` zone under the row's own key, then `markReady`
 *      (plus any follow-up rows the answer named, in the same transaction);
 *    - unsupported → `markUnsupported` with its code, no retry;
 *    - failed (the file's bytes would not decode) → `failed` at once; the viewer's "Try again"
 *      (slice 4) resets it;
 *    - a thrown fault that is not the file's (the store, the codec runtime) → one attempt
 *      counted, the claim kept until the stale bound, `failed` after {@link PREVIEW_MAX_ATTEMPTS}.
 *
 * **Bounded on purpose** (SPEC R4 §6.1): one version at a time; a version whose object is larger
 * than `maxInputBytes` is `unsupported_too_large` without being read; a resident set above
 * `rssCeilingBytes` ends the pass before the next decode, and the rows wait for the next tick; a
 * pass stops after `passBudgetMs`. A store that is not reachable stops the pass at once, as the
 * scan pass's does.
 *
 * Deferred (slice 4 / later): counting derivative bytes against the organization's storage
 * quota through the usage ledger, `file.preview_ready.v1`, and the orphan-derivative sweep.
 */
export const PREVIEW_JOB = Symbol.for('tmanage.PreviewJob');

export const PREVIEW_POLICY_VERSION = 'file-preview';

export const PREVIEW_PLAN_REASON =
  'finding which organizations hold ready file versions that have no preview rows yet, so ' +
  'each can be planned under its own service context (R4 slice 3)';

export const PREVIEW_DRAW_REASON =
  'finding which organizations hold pending preview rows, or preview claims gone stale, so ' +
  'each can be drawn under its own service context (R4 slice 3)';

export interface PreviewJobOptions {
  readonly bootDelayMs: number;
  readonly intervalMs: number;
  readonly debounceMs: number;
  /** Rows taken per batch (SPEC: 10). */
  readonly batchSize: number;
  /** Versions planned per organization per pass. */
  readonly planBatchSize: number;
  readonly maxBatchesPerOrganization: number;
  /** A claim older than this belongs to a pass that died (SPEC: 15 min). */
  readonly claimStaleMs: number;
  readonly maxInputBytes: number;
  readonly rssCeilingBytes: number;
  readonly passBudgetMs: number;
  readonly limits: PreviewLimits;
  readonly log: (line: string) => void;
}

export const DEFAULT_PREVIEW_JOB_OPTIONS: PreviewJobOptions = {
  bootDelayMs: 10_000,
  intervalMs: 2 * 60_000,
  debounceMs: 2_000,
  batchSize: 10,
  planBatchSize: 50,
  maxBatchesPerOrganization: 20,
  claimStaleMs: 15 * 60_000,
  maxInputBytes: 314_572_800,
  rssCeilingBytes: 700 * 1024 * 1024,
  passBudgetMs: 90_000,
  limits: DEFAULT_PREVIEW_LIMITS,
  log: (line) => console.warn(line),
};

export function previewJobEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WORKER_INPROCESS'] === '1' || env['FILE_PREVIEW_INPROCESS'] === '1';
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** The caps SPEC R4 §2 names, from the environment, each falling back to its default. */
export function previewJobOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  base: PreviewJobOptions = DEFAULT_PREVIEW_JOB_OPTIONS,
): PreviewJobOptions {
  return {
    ...base,
    claimStaleMs: positiveInteger(env['PREVIEW_CLAIM_STALE_MS'], base.claimStaleMs),
    maxInputBytes: positiveInteger(env['PREVIEW_MAX_INPUT_BYTES'], base.maxInputBytes),
    rssCeilingBytes: positiveInteger(env['PREVIEW_RSS_CEILING_BYTES'], base.rssCeilingBytes),
    limits: {
      maxPixels: positiveInteger(env['PREVIEW_MAX_PIXELS'], base.limits.maxPixels),
      maxPages: positiveInteger(env['PREVIEW_MAX_TIFF_PAGES'], base.limits.maxPages),
    },
  };
}

export interface PreviewReport {
  readonly organizations: number;
  /** Versions this pass started rows for. */
  readonly planned: number;
  /** Rows this pass made. */
  readonly ready: number;
  readonly unsupported: number;
  /** Rows now `failed` (bad bytes, or the last attempt). */
  readonly failed: number;
  /** Rows that failed an attempt and will be tried again after the stale bound. */
  readonly retrying: number;
  /** Rows another pass held or concluded first. */
  readonly skipped: number;
  /** Why the pass ended early, if it did. */
  readonly stoppedBy: 'memory' | 'budget' | null;
}

export function describePreviewPass(report: PreviewReport): string {
  const parts = [
    `${report.organizations} organization(s)`,
    `planned ${report.planned} version(s)`,
    `ready ${report.ready}`,
    `unsupported ${report.unsupported}`,
    `failed ${report.failed}`,
    `retrying ${report.retrying}`,
    `skipped ${report.skipped}`,
  ];
  if (report.stoppedBy) parts.push(`stopped by ${report.stoppedBy}`);
  return parts.join(', ');
}

export function previewContextFor(organizationId: string, correlationId: string): TenantContext {
  return createServiceContext({
    organizationId,
    correlationId,
    policyVersion: PREVIEW_POLICY_VERSION,
  });
}

/** What the scan job sees: a request for a pass, nothing more. */
export interface PreviewRequester {
  request(): void;
}

class StopPass extends Error {
  constructor(readonly reason: 'memory' | 'budget') {
    super(`preview pass stopped: ${reason}`);
    this.name = 'StopPass';
  }
}

interface Tally {
  planned: number;
  ready: number;
  unsupported: number;
  failed: number;
  retrying: number;
  skipped: number;
}

export class PreviewJob implements PreviewRequester, OnApplicationBootstrap, OnModuleDestroy {
  private running: Promise<PreviewReport> | null = null;
  private again = false;
  private pending: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly database: TenantDatabase,
    private readonly previews: FilePreviewsRepository,
    private readonly assets: FileAssetsRepository,
    private readonly store: ObjectStore,
    private readonly enabled: boolean,
    private readonly options: PreviewJobOptions = DEFAULT_PREVIEW_JOB_OPTIONS,
    private readonly generators: readonly PreviewGenerator[] = PREVIEW_GENERATORS,
    private readonly now: () => Date = () => new Date(),
    private readonly rss: () => number = () => process.memoryUsage().rss,
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
    await this.running?.catch(() => undefined);
  }

  request(): void {
    if (!this.enabled || this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.schedule(this.options.debounceMs);
  }

  /** Passes now, until no request arrived during the last; never throws (the next tick retries). */
  async runNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      await this.running.catch(() => undefined);
      return;
    }
    do {
      this.again = false;
      this.running = this.pass();
      try {
        const report = await this.running;
        if (this.changed(report))
          this.options.log(`[preview] pass: ${describePreviewPass(report)}`);
      } catch (error) {
        this.options.log(`[preview] pass failed: ${JSON.stringify(describeFailure(error))}`);
      } finally {
        this.running = null;
      }
    } while (this.again && !this.stopped);
  }

  private changed(report: PreviewReport): boolean {
    return (
      report.planned + report.ready + report.unsupported + report.failed + report.retrying > 0 ||
      report.stoppedBy !== null
    );
  }

  private schedule(delayMs: number): void {
    if (this.pending || this.stopped) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.runNow();
    }, delayMs);
    this.pending.unref();
  }

  /** One plan-then-draw pass over every organization. Throws when the store is unreachable. */
  async pass(): Promise<PreviewReport> {
    const started = Date.now();
    const correlationId = uuidv7();
    const mimeTypes = previewMimeTypes(this.generators);
    const tally: Tally = {
      planned: 0,
      ready: 0,
      unsupported: 0,
      failed: 0,
      retrying: 0,
      skipped: 0,
    };
    const organizations = new Set<string>();
    let stoppedBy: PreviewReport['stoppedBy'] = null;

    const toPlan = await this.database.bootstrapRead(
      {
        correlationId,
        reason: PREVIEW_PLAN_REASON,
        tables: ['file_versions', 'file_assets', 'file_previews'],
      },
      (db) => this.previews.organizationsNeedingPreviews(db, mimeTypes),
    );
    for (const organizationId of toPlan) {
      organizations.add(organizationId);
      tally.planned += await this.plan(previewContextFor(organizationId, correlationId), mimeTypes);
    }

    const staleBefore = new Date(this.now().getTime() - this.options.claimStaleMs);
    const toDraw = await this.database.bootstrapRead(
      { correlationId, reason: PREVIEW_DRAW_REASON, tables: ['file_previews'] },
      (db) => this.previews.organizationsWithPending(db, staleBefore),
    );
    try {
      for (const organizationId of toDraw) {
        organizations.add(organizationId);
        await this.drawOrganization(organizationId, correlationId, staleBefore, started, tally);
      }
    } catch (error) {
      if (!(error instanceof StopPass)) throw error;
      stoppedBy = error.reason;
    }
    return { organizations: organizations.size, ...tally, stoppedBy };
  }

  private async plan(context: TenantContext, mimeTypes: readonly string[]): Promise<number> {
    const versions = await this.database.read(context, (db) =>
      this.previews.listVersionsNeedingPreviews(db, context, mimeTypes, this.options.planBatchSize),
    );
    let planned = 0;
    for (const version of versions) {
      const specs = previewPlanFor(version.mimeType, this.generators);
      if (specs.length === 0) continue;
      await this.database.transaction(context, (tx) =>
        this.previews.ensurePending(
          tx,
          context,
          {
            fileAssetId: version.fileAssetId,
            fileVersionId: version.fileVersionId,
            previews: specs,
          },
          this.now(),
        ),
      );
      planned += 1;
    }
    return planned;
  }

  private async drawOrganization(
    organizationId: string,
    correlationId: string,
    staleBefore: Date,
    started: number,
    tally: Tally,
  ): Promise<void> {
    const context = previewContextFor(organizationId, correlationId);
    // A row is looked at once per pass: one another pass holds is not counted again next batch.
    const seen = new Set<string>();
    for (let batch = 0; batch < this.options.maxBatchesPerOrganization; batch += 1) {
      const listed = await this.database.read(context, (db) =>
        this.previews.listPending(db, context, staleBefore, this.options.batchSize),
      );
      const rows = listed.filter((row) => !seen.has(row.id));
      if (rows.length === 0) return;
      for (const row of rows) seen.add(row.id);
      const byVersion = new Map<string, FilePreview[]>();
      for (const row of rows) {
        const group = byVersion.get(row.fileVersionId) ?? [];
        group.push(row);
        byVersion.set(row.fileVersionId, group);
      }
      const before = tally.ready + tally.unsupported + tally.failed + tally.retrying;
      for (const group of byVersion.values()) {
        if (Date.now() - started > this.options.passBudgetMs) throw new StopPass('budget');
        if (this.rss() > this.options.rssCeilingBytes) throw new StopPass('memory');
        await this.drawVersion(context, group, staleBefore, tally);
      }
      const moved = tally.ready + tally.unsupported + tally.failed + tally.retrying - before;
      // Not `rows.length < batchSize`: a page answer may just have added follow-up rows.
      if (moved === 0) return;
    }
  }

  private async drawVersion(
    context: TenantContext,
    rows: readonly FilePreview[],
    staleBefore: Date,
    tally: Tally,
  ): Promise<void> {
    const claimed: FilePreview[] = [];
    for (const row of rows) {
      const took = await this.database.transaction(context, (tx) =>
        this.previews.claim(tx, context, row, this.now(), staleBefore),
      );
      if (took) claimed.push(row);
      else tally.skipped += 1;
    }
    if (claimed.length === 0) return;
    const first = claimed[0]!;

    const loaded = await this.database.read(context, async (db) => ({
      asset: await this.assets.findById(db, context, first.fileAssetId),
      version: await this.assets.findVersionById(db, context, first.fileVersionId),
    }));
    const { asset, version } = loaded;
    // Clean and promoted, or `unscanned` under the `none` driver — the two kinds of version the
    // download door serves (the second labelled "not scanned", still in quarantine).
    const servable =
      asset !== null &&
      version !== null &&
      asset.deletedAt === null &&
      ((asset.status === 'ready' &&
        version.trustZone === 'private' &&
        version.scanVerdict === 'clean') ||
        (version.scanVerdict === 'unscanned' &&
          (asset.status === 'ready' || asset.status === 'scanning')));
    if (!servable) {
      await this.concludeAll(
        context,
        claimed,
        { status: 'unsupported', code: 'not_servable' },
        tally,
      );
      return;
    }
    const generator = generatorFor(version.detectedMimeType, this.generators);
    if (!generator || version.detectedMimeType === null) {
      await this.concludeAll(
        context,
        claimed,
        { status: 'unsupported', code: 'unsupported_type' },
        tally,
      );
      return;
    }
    if (version.sizeBytes > this.options.maxInputBytes) {
      await this.concludeAll(
        context,
        claimed,
        { status: 'unsupported', code: 'unsupported_too_large' },
        tally,
      );
      return;
    }

    let outcomes: readonly PreviewOutcome[];
    try {
      const bytes = await this.readObject(
        version.trustZone === 'private' ? 'private' : 'quarantine',
        version.objectKey,
        version.sizeBytes,
      );
      outcomes = await generator.generate(
        { bytes, mimeType: version.detectedMimeType },
        claimed.map((row) => ({ kind: row.kind, pageNo: row.pageNo })),
        this.options.limits,
      );
      if (outcomes.length !== claimed.length) throw new Error('generator answered the wrong count');
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) throw error;
      const code = error instanceof PreviewReadError ? error.code : 'generator_error';
      this.options.log(
        `[preview] version ${version.id} (${generator.name}) failed: ${JSON.stringify(describeFailure(error))}`,
      );
      for (const row of claimed) await this.countAttempt(context, row, code, tally);
      return;
    }

    for (let index = 0; index < claimed.length; index += 1) {
      const row = claimed[index]!;
      try {
        await this.conclude(context, row, outcomes[index]!, tally);
      } catch (error) {
        if (error instanceof ObjectStoreUnavailableError) throw error;
        this.options.log(
          `[preview] preview ${row.id} could not be stored: ${JSON.stringify(describeFailure(error))}`,
        );
        await this.countAttempt(context, row, 'store_error', tally);
      }
    }
  }

  private async readObject(
    zone: 'private' | 'quarantine',
    objectKey: string,
    sizeBytes: number,
  ): Promise<Uint8Array> {
    let opened;
    try {
      opened = await this.store.openObject({ zone, objectKey });
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) throw error;
      if (error instanceof ObjectNotFoundError) throw new PreviewReadError('object_not_found');
      throw new PreviewReadError('store_error');
    }
    if (opened.sizeBytes !== sizeBytes) {
      destroy(opened.stream);
      throw new PreviewReadError('size_mismatch');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const piece of opened.stream) {
        const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
        total += chunk.length;
        if (total > sizeBytes) throw new PreviewReadError('size_mismatch');
        chunks.push(chunk);
      }
    } catch (error) {
      destroy(opened.stream);
      if (error instanceof PreviewReadError) throw error;
      throw new PreviewReadError('stream_error');
    }
    if (total !== sizeBytes) throw new PreviewReadError('size_mismatch');
    return new Uint8Array(Buffer.concat(chunks, total));
  }

  private async concludeAll(
    context: TenantContext,
    rows: readonly FilePreview[],
    outcome: PreviewOutcome,
    tally: Tally,
  ): Promise<void> {
    for (const row of rows) await this.conclude(context, row, outcome, tally);
  }

  private async conclude(
    context: TenantContext,
    row: FilePreview,
    outcome: PreviewOutcome,
    tally: Tally,
  ): Promise<void> {
    if (outcome.status === 'unsupported') {
      const done = await this.database.transaction(context, (tx) =>
        this.previews.markUnsupported(tx, context, row.id, outcome.code, this.now()),
      );
      if (done) tally.unsupported += 1;
      else tally.skipped += 1;
      return;
    }
    if (outcome.status === 'failed') {
      // The file's own bytes: another try decodes them the same way, so it fails now.
      const result = await this.database.transaction(context, (tx) =>
        this.previews.recordFailure(tx, context, row, outcome.code, this.now(), row.attempts + 1),
      );
      if (result === 'not_pending') tally.skipped += 1;
      else tally.failed += 1;
      return;
    }
    // The key is the row's own: a re-take of a stale claim rewrites the same object. A
    // facts-only answer (media_meta) stores nothing and keeps no key.
    const body = outcome.body;
    const objectKey =
      body === null
        ? null
        : derivativeObjectKey({
            organizationId: context.organizationId,
            fileVersionId: row.fileVersionId,
            previewId: row.id,
          });
    if (body !== null && objectKey !== null) await this.store.putDerivative({ objectKey, body });
    const written = await this.database.transaction(context, async (tx) => {
      const marked = await this.previews.markReady(
        tx,
        context,
        row.id,
        {
          objectKey,
          mimeType: outcome.mimeType,
          sizeBytes: body === null ? 0 : body.byteLength,
          width: outcome.width,
          height: outcome.height,
          meta: outcome.meta,
        },
        this.now(),
      );
      if (marked && outcome.followUps && outcome.followUps.length > 0) {
        await this.previews.ensurePending(
          tx,
          context,
          {
            fileAssetId: row.fileAssetId,
            fileVersionId: row.fileVersionId,
            previews: outcome.followUps,
          },
          this.now(),
        );
      }
      return marked;
    });
    if (written) tally.ready += 1;
    else tally.skipped += 1;
  }

  private async countAttempt(
    context: TenantContext,
    row: FilePreview,
    code: string,
    tally: Tally,
  ): Promise<void> {
    const result = await this.database.transaction(context, (tx) =>
      this.previews.recordFailure(tx, context, row, code, this.now(), PREVIEW_MAX_ATTEMPTS),
    );
    if (result === 'failed') tally.failed += 1;
    else if (result === 'retry') tally.retrying += 1;
    else tally.skipped += 1;
  }
}

class PreviewReadError extends Error {
  constructor(readonly code: string) {
    super(`preview read failed: ${code}`);
    this.name = 'PreviewReadError';
  }
}

function destroy(stream: NodeJS.ReadableStream): void {
  const candidate = stream as NodeJS.ReadableStream & { destroy?: () => void };
  candidate.destroy?.();
}
