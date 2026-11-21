import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { isServableVersion, uuidv7 } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import { ObjectStoreUnavailableError } from '../../common/storage/storage.module.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { DEFAULT_TEXT_LIMITS, extractText, textMimeTypes } from './file-text-extractors.js';
import type { ExtractedText, TextLimits } from './file-text-extractors.js';
import type { FileText, FileTextsRepository } from './file-texts.repository.js';
import type { IsolatedTextExtractor } from './file-text-isolation.js';
import { VersionStore } from './provider-objects.js';
import type { ProviderObjectSources, StoredVersion } from './provider-objects.js';
import { describeFailure } from './upload-session-sweeper.js';

/**
 * 62-23 (plan 62 §4.5, §9 row) — the text job: the plain text of each scan-clean file version,
 * once per distinct content hash in the workspace, into `ai_file_texts` for the AI knowledge
 * layer (62-24 chunks and embeds it). Nothing leaves the server and no model is called here.
 *
 * Where it runs: the preview job's shape (`preview-job.ts`), in the one Hostinger process — off
 * unless the process runs background work (`WORKER_INPROCESS=1`, or `FILE_TEXT_INPROCESS=1` for a
 * local API); once shortly after boot, then on an interval. Not in `apps/worker`: the worker holds
 * no object-store or Drive/OneDrive access, and the bytes must be read where they are served
 * from. Two processes are safe: every row is taken by a conditional claim (PART I-5's rule).
 *
 * One pass, per workspace (IP-17: a typed report and one log line; AS-6: bounded batches):
 *
 * 1. **Plan.** Each content hash held by a servable version of a type the job reads, with no row
 *    yet, gets one `pending` row (unique on workspace + hash, so the same bytes uploaded twice
 *    are planned and extracted once).
 * 2. **Extract.** Pending rows nobody holds are claimed one at a time. A servable version holding
 *    the hash is found and re-checked with `isServableVersion` (AR-8) before a byte is read; none
 *    left → `unsupported` `not_servable`. Over `maxInputBytes` → `unsupported_too_large`, not
 *    read. Otherwise the bytes are read once and {@link extractText} applies the page, character
 *    and time caps (ST-1). A store fault counts an attempt (`failed` after three); a file's own
 *    fault is final at once.
 * 3. **Forget.** Rows whose hash no live version holds any more (the file deleted, purged or
 *    rejected) are deleted, so a removed file's text goes with it.
 *
 * Bounded: one file in memory at a time; the pass stops after `passBudgetMs` or above
 * `rssCeilingBytes`, and the rest waits for the next tick.
 */
export const FILE_TEXT_JOB = Symbol.for('tmanage.FileTextJob');

export const FILE_TEXT_POLICY_VERSION = 'file-text';

export const FILE_TEXT_DISCOVERY_REASON =
  'finding which organizations hold scan-clean file versions with no extracted text yet, ' +
  'pending text rows, or text rows whose file is gone, so each can be worked under its own ' +
  'service context (62-23)';

export interface FileTextJobOptions {
  readonly bootDelayMs: number;
  readonly intervalMs: number;
  readonly planBatchSize: number;
  readonly extractBatchSize: number;
  readonly orphanBatchSize: number;
  readonly claimStaleMs: number;
  readonly rssCeilingBytes: number;
  readonly passBudgetMs: number;
  readonly limits: TextLimits;
  readonly log: (line: string) => void;
}

export const DEFAULT_FILE_TEXT_JOB_OPTIONS: FileTextJobOptions = {
  bootDelayMs: 20_000,
  intervalMs: 5 * 60_000,
  planBatchSize: 100,
  extractBatchSize: 20,
  orphanBatchSize: 200,
  claimStaleMs: 15 * 60_000,
  rssCeilingBytes: 700 * 1024 * 1024,
  passBudgetMs: 120_000,
  limits: DEFAULT_TEXT_LIMITS,
  log: (line) => console.warn(line),
};

export function fileTextJobEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WORKER_INPROCESS'] === '1' || env['FILE_TEXT_INPROCESS'] === '1';
}

export interface FileTextReport {
  readonly organizations: number;
  readonly planned: number;
  readonly ready: number;
  readonly unsupported: number;
  readonly failed: number;
  readonly retrying: number;
  readonly skipped: number;
  readonly forgotten: number;
  readonly stoppedBy: 'memory' | 'budget' | null;
}

export function describeFileTextPass(report: FileTextReport): string {
  const parts = [
    `${String(report.organizations)} organization(s)`,
    `planned ${String(report.planned)}`,
    `ready ${String(report.ready)}`,
    `unsupported ${String(report.unsupported)}`,
    `failed ${String(report.failed)}`,
    `retrying ${String(report.retrying)}`,
    `skipped ${String(report.skipped)}`,
    `forgotten ${String(report.forgotten)}`,
  ];
  if (report.stoppedBy) parts.push(`stopped by ${report.stoppedBy}`);
  return parts.join(', ');
}

export function fileTextContextFor(organizationId: string, correlationId: string): TenantContext {
  return createServiceContext({
    organizationId,
    correlationId,
    policyVersion: FILE_TEXT_POLICY_VERSION,
  });
}

class StopPass extends Error {
  constructor(readonly reason: 'memory' | 'budget') {
    super(`text pass stopped: ${reason}`);
    this.name = 'StopPass';
  }
}

/** The file could not be read for a reason that is the store's, not the bytes'. */
class TextReadError extends Error {
  constructor(readonly code: string) {
    super(`text read failed: ${code}`);
    this.name = 'TextReadError';
  }
}

type Tally = {
  -readonly [K in Exclude<keyof FileTextReport, 'organizations' | 'stoppedBy'>]: number;
};

export class FileTextJob implements OnApplicationBootstrap, OnModuleDestroy {
  private running: Promise<void> | null = null;
  private interval: NodeJS.Timeout | null = null;
  private pending: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly versions: VersionStore;

  constructor(
    private readonly database: TenantDatabase,
    private readonly texts: FileTextsRepository,
    private readonly assets: Pick<FileAssetsRepository, 'findById' | 'findVersionById'>,
    store: Pick<ObjectStore, 'openObject'>,
    private readonly enabled: boolean,
    private readonly options: FileTextJobOptions = DEFAULT_FILE_TEXT_JOB_OPTIONS,
    private readonly now: () => Date = () => new Date(),
    private readonly rss: () => number = () => process.memoryUsage().rss,
    providers: ProviderObjectSources = {},
    /** 62-A0: big files are read in a capped child process (`file-text-isolation.ts`). */
    private readonly isolated: IsolatedTextExtractor | null = null,
  ) {
    this.versions = new VersionStore(store, providers);
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.runNow();
    }, this.options.bootDelayMs);
    this.pending.unref();
    this.interval = setInterval(() => void this.runNow(), this.options.intervalMs);
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

  /** One pass now unless one is running; never throws (the next tick retries). */
  async runNow(): Promise<void> {
    if (this.running || this.stopped) return this.running ?? undefined;
    this.running = this.pass()
      .then((report) => {
        if (
          report.planned + report.ready + report.unsupported + report.failed + report.forgotten >
          0
        )
          this.options.log(`[file-text] pass: ${describeFileTextPass(report)}`);
      })
      .catch((error: unknown) => {
        this.options.log(`[file-text] pass failed: ${JSON.stringify(describeFailure(error))}`);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** One plan, extract and forget pass over every workspace with work. */
  async pass(): Promise<FileTextReport> {
    const started = Date.now();
    const correlationId = uuidv7();
    const mimeTypes = textMimeTypes();
    const staleBefore = new Date(this.now().getTime() - this.options.claimStaleMs);
    const tally: Tally = {
      planned: 0,
      ready: 0,
      unsupported: 0,
      failed: 0,
      retrying: 0,
      skipped: 0,
      forgotten: 0,
    };
    const organizations = await this.database.bootstrapRead(
      {
        correlationId,
        reason: FILE_TEXT_DISCOVERY_REASON,
        tables: ['file_versions', 'file_assets', 'ai_file_texts'],
      },
      (db) => this.texts.organizationsWithWork(db, mimeTypes, staleBefore),
    );
    let stoppedBy: FileTextReport['stoppedBy'] = null;
    try {
      for (const organizationId of organizations) {
        const context = fileTextContextFor(organizationId, correlationId);
        tally.forgotten += await this.database.transaction(context, (tx) =>
          this.texts.deleteOrphans(tx, context, this.options.orphanBatchSize),
        );
        tally.planned += await this.plan(context, mimeTypes);
        await this.extractOrganization(context, staleBefore, started, tally);
      }
    } catch (error) {
      if (!(error instanceof StopPass)) throw error;
      stoppedBy = error.reason;
    }
    return { organizations: organizations.length, ...tally, stoppedBy };
  }

  private async plan(context: TenantContext, mimeTypes: readonly string[]): Promise<number> {
    const hashes = await this.database.read(context, (db) =>
      this.texts.listHashesNeedingText(db, context, mimeTypes, this.options.planBatchSize),
    );
    for (const hash of hashes) {
      await this.database.transaction(context, (tx) =>
        this.texts.ensurePending(tx, context, hash, this.now()),
      );
    }
    return hashes.length;
  }

  private async extractOrganization(
    context: TenantContext,
    staleBefore: Date,
    started: number,
    tally: Tally,
  ): Promise<void> {
    const rows = await this.database.read(context, (db) =>
      this.texts.listClaimable(db, context, staleBefore, this.options.extractBatchSize),
    );
    for (const row of rows) {
      if (Date.now() - started > this.options.passBudgetMs) throw new StopPass('budget');
      if (this.rss() > this.options.rssCeilingBytes) throw new StopPass('memory');
      const took = await this.database.transaction(context, (tx) =>
        this.texts.claim(tx, context, row, this.now(), staleBefore),
      );
      if (!took) {
        tally.skipped += 1;
        continue;
      }
      await this.extractOne(context, row, tally);
    }
  }

  private async extractOne(context: TenantContext, row: FileText, tally: Tally): Promise<void> {
    const found = await this.database.read(context, async (db) => {
      const ref = await this.texts.findVersionForHash(db, context, row.contentHash);
      if (ref === null) return null;
      return {
        asset: await this.assets.findById(db, context, ref.fileAssetId),
        version: await this.assets.findVersionById(db, context, ref.fileVersionId),
      };
    });
    const asset = found?.asset ?? null;
    const version = found?.version ?? null;
    // AR-8: the one servable rule, again, on the rows about to be read.
    if (
      asset === null ||
      version === null ||
      asset.deletedAt !== null ||
      version.contentHash !== row.contentHash ||
      !isServableVersion({
        status: asset.status,
        scanVerdict: version.scanVerdict,
        trustZone: version.trustZone,
      })
    ) {
      await this.conclude(context, row, unsupported('not_servable'), tally);
      return;
    }
    const mimeType = version.detectedMimeType ?? row.mimeType;
    if (version.sizeBytes > this.options.limits.maxInputBytes) {
      await this.conclude(context, row, unsupported('unsupported_too_large'), tally);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.read(context, version);
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) throw error;
      const code = error instanceof TextReadError ? error.code : 'store_error';
      const result = await this.database.transaction(context, (tx) =>
        this.texts.recordAttempt(tx, context, row, code, this.now()),
      );
      if (result === 'not_pending') tally.skipped += 1;
      else tally[result] += 1;
      return;
    }
    // 62-A0: a big file is read in the child, so this process keeps answering web requests.
    const outcome =
      this.isolated !== null && this.isolated.takes(bytes.byteLength)
        ? await this.isolated.extract(bytes, mimeType, this.options.limits)
        : await extractText(bytes, mimeType, this.options.limits);
    await this.conclude(context, row, outcome, tally);
  }

  private async read(context: TenantContext, version: StoredVersion): Promise<Uint8Array> {
    const opened = await this.versions.open(context, version, 'private').catch((error: unknown) => {
      if (error instanceof ObjectStoreUnavailableError) throw error;
      throw new TextReadError('object_unreadable');
    });
    if (opened.sizeBytes !== version.sizeBytes) throw new TextReadError('size_mismatch');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const piece of opened.stream) {
      const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
      total += chunk.length;
      if (total > version.sizeBytes) throw new TextReadError('size_mismatch');
      chunks.push(chunk);
    }
    if (total !== version.sizeBytes) throw new TextReadError('size_mismatch');
    return new Uint8Array(Buffer.concat(chunks, total));
  }

  private async conclude(
    context: TenantContext,
    row: FileText,
    outcome: ExtractedText,
    tally: Tally,
  ): Promise<void> {
    const done = await this.database.transaction(context, (tx) =>
      this.texts.conclude(
        tx,
        context,
        row.id,
        outcome.status === 'ready'
          ? {
              status: 'ready',
              reasonCode: null,
              extractor: outcome.extractor,
              body: outcome.text,
              pageCount: outcome.pages,
              truncated: outcome.truncated,
            }
          : {
              status: outcome.status,
              reasonCode: outcome.code,
              extractor: outcome.extractor,
              body: null,
              pageCount: null,
              truncated: false,
            },
        this.now(),
      ),
    );
    if (!done) tally.skipped += 1;
    else tally[outcome.status] += 1;
  }
}

function unsupported(code: string): ExtractedText {
  return { status: 'unsupported', code, extractor: null };
}
