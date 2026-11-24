import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { uuidv7 } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore } from '@tmanage/storage';
import { ObjectStoreUnavailableError } from '../../common/storage/storage.module.js';
import { ScannerUnavailableError } from '../../common/scan/malware-scanner.js';
import type { EngineVersion, MalwareScanner } from '../../common/scan/malware-scanner.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { FileAssetTransitionError } from './file-assets.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { FileBlockNotifier } from './file-block-notifier.js';
import { engineVersionOf, MALWARE_REJECTION_CODE, scannerContextFor } from './file-scanner.js';
import { describeFailure } from './upload-session-sweeper.js';

/**
 * QA-FIX S1 (2026-11-20) — the re-check pass: clean files are checked again when the engine's
 * signatures move on. Rules: AS-6 (bounded pass), AS-1/AS-2 (effects in the transaction, deduped),
 * DA-1 (conditional writes), RT-3 (two instances), IP-17 (typed report), QM-2 (security first).
 *
 * ## Why
 *
 * A verdict is write-once (0019) and the scan pass only ever looked at `scanning` rows, so a file
 * an engine cleared stayed "Virus-scanned" for ever, whatever the signatures learned later. The
 * security pass of 2026-11-20 (finding S1) asked for the practice signature-based scanning needs:
 * keep the engine and signature version with the verdict, re-check stored files when it changes,
 * block what is newly detected and tell the uploader. ClamAV publishes new signature databases
 * several times a day (`freshclam.conf(5)`, `Checks`); a new signature protects only the files it
 * is run on.
 *
 * ## What one pass does
 *
 * 1. Probe the engine and ask its version (`MalwareScanner.version`, clamd `VERSION`). No version,
 *    no pass: without a signature number there is nothing to compare, and the pass never guesses.
 * 2. Select the `clean`, promoted, locally held versions of `ready` assets whose
 *    `checked_signature_version` is older than the engine's or unknown (every verdict before 0386),
 *    least recently checked first ({@link FileAssetsRepository.listAwaitingRecheck}).
 * 3. For each, within a per-pass budget of {@link RESCAN_BATCH_SIZE} files and
 *    {@link RESCAN_MAX_BYTES_PER_PASS} bytes: read the private object once, feeding the digest and
 *    the engine. The digest must equal the version's `content_hash`: bytes that changed under a
 *    sealed version are an error, never a verdict.
 *    - `clean`: `checked_signature_version`/`checked_at` move forward (conditional, so overlapping
 *      instances write once and an older engine never moves them back).
 *    - `infected`: one transaction moves the asset `ready → rejected` (`malware_detected`), records
 *      the check, notifies the uploader, writes `file_asset.rejected` (`denied`, `rescan: true`) and
 *      appends `file.rejected.v1`. The private object is then withdrawn, as the scan pass does for
 *      any rejected asset; the quarantine copy stays as evidence until the retention purge. The
 *      version's own verdict stays `clean`: it is what that signature set said, and the audit row
 *      says what the newer one found.
 *
 * ## Rate and placement
 *
 * Run by `FileScanJob` after its verify-then-scan pass, at most once per
 * {@link RESCAN_MIN_INTERVAL_MS}: on boot (the job's first pass) and within minutes of a signature
 * change. Two overlapping instances may both read one file; the conditional writes and the
 * status-guarded transition decide once.
 */

export interface RescanReport {
  /** The engine's signature number this pass compared against; `null` = no pass ran. */
  readonly signatureVersion: number | null;
  readonly organizations: number;
  readonly checked: number;
  readonly stillClean: number;
  readonly blocked: number;
  readonly skipped: number;
  readonly failed: number;
  /** True when the pass stopped on its file or byte budget with work possibly left. */
  readonly budgetReached: boolean;
}

/** The DI token (a local one: `FileScanJob` is the only consumer). */
export const FILE_RESCANNER = Symbol.for('tmanage.FileRescanner');

export const RESCAN_BATCH_SIZE = 20;
export const RESCAN_MAX_BYTES_PER_PASS = 256 * 1024 * 1024;
export const RESCAN_MIN_INTERVAL_MS = 10 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;

export const RESCAN_REASON =
  'finding which organizations hold clean file versions last checked against older malware ' +
  'signatures, so each can be re-checked under its own service context (QA-FIX S1)';

class RecheckFailure extends Error {
  constructor(readonly failure: string) {
    super(`re-check failed: ${failure}`);
    this.name = 'RecheckFailure';
  }
}

const NO_PASS: RescanReport = {
  signatureVersion: null,
  organizations: 0,
  checked: 0,
  stillClean: 0,
  blocked: 0,
  skipped: 0,
  failed: 0,
  budgetReached: false,
};

export interface RescanBudget {
  readonly files: number;
  readonly bytes: number;
}

export const DEFAULT_RESCAN_BUDGET: RescanBudget = {
  files: RESCAN_BATCH_SIZE,
  bytes: RESCAN_MAX_BYTES_PER_PASS,
};

export class FileRescanner {
  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
    private readonly store: ObjectStore,
    private readonly scanner: MalwareScanner,
    private readonly audit: AuditService | null,
    private readonly outbox: OutboxEventsRepository | null,
    private readonly notifier: FileBlockNotifier | null,
    private readonly now: () => Date = () => new Date(),
    private readonly budget: RescanBudget = DEFAULT_RESCAN_BUDGET,
    private readonly onFailure: (fileAssetId: string, error: unknown) => void = (id, error) =>
      console.error(`[rescanner] re-checking file asset ${id} failed`, describeFailure(error)),
    private readonly onDetection: (fileAssetId: string, detection: string) => void = (
      id,
      detection,
    ) => console.error(`[rescanner] file asset ${id} blocked on re-check: ${detection}`),
  ) {}

  async rescan(): Promise<RescanReport> {
    if (this.scanner.kind !== 'engine') return NO_PASS;
    await this.scanner.probe();
    const engine = await engineVersionOf(this.scanner);
    if (engine === null) return NO_PASS;

    const correlationId = uuidv7();
    const organizations = await this.database.bootstrapRead(
      { correlationId, reason: RESCAN_REASON, tables: ['file_assets', 'file_versions'] },
      (db) => this.assets.organizationsAwaitingRecheck(db, engine.signatureVersion),
    );

    let checked = 0;
    let stillClean = 0;
    let blocked = 0;
    let skipped = 0;
    let failed = 0;
    let bytes = 0;
    let consecutiveFailures = 0;
    let budgetReached = false;

    outer: for (const organizationId of organizations) {
      if (checked >= this.budget.files) {
        budgetReached = true;
        break;
      }
      const listContext = scannerContextFor(organizationId, correlationId);
      const rows = await this.database.read(listContext, (db) =>
        this.assets.listAwaitingRecheck(
          db,
          listContext,
          engine.signatureVersion,
          this.budget.files - checked,
        ),
      );
      for (const { asset, version } of rows) {
        // A file larger than the whole byte budget still gets its turn when it comes first.
        if (checked > 0 && bytes + version.sizeBytes > this.budget.bytes) {
          budgetReached = true;
          break outer;
        }
        checked += 1;
        bytes += version.sizeBytes;
        const context = scannerContextFor(organizationId, uuidv7());
        try {
          const outcome = await this.checkOne(context, asset, version, engine);
          if (outcome === 'clean') stillClean += 1;
          else if (outcome === 'blocked') blocked += 1;
          else skipped += 1;
          consecutiveFailures = 0;
        } catch (error) {
          if (error instanceof ObjectStoreUnavailableError) throw error;
          if (error instanceof ScannerUnavailableError) throw error;
          failed += 1;
          consecutiveFailures += 1;
          this.onFailure(asset.id, error);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            throw new ScannerUnavailableError(
              `${consecutiveFailures} consecutive re-check failures; the pass stops`,
            );
          }
        }
      }
      if (checked >= this.budget.files) budgetReached = true;
    }

    return {
      signatureVersion: engine.signatureVersion,
      organizations: organizations.length,
      checked,
      stillClean,
      blocked,
      skipped,
      failed,
      budgetReached,
    };
  }

  private async checkOne(
    context: TenantContext,
    asset: FileAssetRow,
    version: FileVersionRow,
    engine: EngineVersion,
  ): Promise<'clean' | 'blocked' | 'skipped'> {
    if (version.contentHash === null) throw new RecheckFailure('not_verified');
    let opened;
    try {
      opened = await this.store.openObject({ zone: 'private', objectKey: version.objectKey });
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) throw error;
      if (error instanceof ObjectNotFoundError) throw new RecheckFailure('object_not_found');
      throw new RecheckFailure('store_error');
    }
    if (opened.sizeBytes !== version.sizeBytes) {
      destroy(opened.stream);
      throw new RecheckFailure('size_mismatch');
    }

    // One read: the same chunks feed the digest and the engine.
    const hash = createHash('sha256');
    const toScanner = new PassThrough();
    const source = opened.stream;
    source.on('data', (chunk: Buffer | string) => {
      hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    source.on('error', (error: Error) => toScanner.destroy(error));
    source.pipe(toScanner);
    let result;
    try {
      result = await this.scanner.scan({ stream: toScanner, sizeBytes: version.sizeBytes });
    } catch (error) {
      destroy(source);
      destroy(toScanner);
      throw error;
    }
    if (hash.digest('hex') !== version.contentHash) throw new RecheckFailure('hash_mismatch');

    const checkedAt = this.now();
    if (result.verdict === 'clean') {
      await this.database.transaction(context, (tx) =>
        this.assets.recordRecheck(tx, context, version.id, engine.signatureVersion, checkedAt),
      );
      return 'clean';
    }

    let outcome: 'blocked' | 'skipped';
    try {
      outcome = await this.database.transaction(context, async (tx) => {
        await this.assets.transition(tx, context, asset.id, 'rejected', {
          rejectionCode: MALWARE_REJECTION_CODE,
        });
        await this.assets.recordRecheck(
          tx,
          context,
          version.id,
          engine.signatureVersion,
          checkedAt,
        );
        await this.notifier?.blocked(tx, context, asset);
        await this.audit?.record(tx, context, {
          action: 'file_asset.rejected',
          objectId: asset.id,
          result: 'denied',
          actorUserId: null,
          metadata: {
            project_id: asset.projectId,
            purpose: asset.purpose,
            file_version_id: version.id,
            size_bytes: version.sizeBytes,
            scanner: this.scanner.name,
            verdict: 'infected',
            rejection_code: MALWARE_REJECTION_CODE,
            rescan: true,
            definitions_version: engine.signatureVersion,
          },
        });
        await this.outbox?.append(tx, context, {
          type: 'file.rejected.v1',
          aggregateId: asset.id,
          payload: {
            fileAssetId: asset.id,
            fileVersionId: version.id,
            projectId: asset.projectId,
            purpose: asset.purpose,
            objectId: asset.objectId,
            rejectionCode: MALWARE_REJECTION_CODE,
          },
        });
        return 'blocked' as const;
      });
    } catch (error) {
      // Another instance blocked it first: nothing left for this pass to do.
      if (!(error instanceof FileAssetTransitionError)) throw error;
      outcome = 'skipped';
    }
    if (outcome === 'blocked') {
      await this.withdrawQuietly(version.objectKey);
      this.onDetection(asset.id, result.detection ?? 'unnamed');
    }
    return outcome;
  }

  private async withdrawQuietly(objectKey: string): Promise<void> {
    try {
      await this.store.withdraw({ objectKey });
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) throw error;
      console.error(`[rescanner] withdrawing a private object failed`, describeFailure(error));
    }
  }
}

function destroy(stream: NodeJS.ReadableStream | NodeJS.WritableStream): void {
  const candidate = stream as { destroy?: () => void; destroyed?: boolean };
  if (typeof candidate.destroy === 'function' && !candidate.destroyed) candidate.destroy();
}

/** The one line a pass prints: `[rescanner] pass: …` on stderr. */
export function describeRescan(report: RescanReport): string {
  if (report.signatureVersion === null) return 'skipped (no engine version)';
  return (
    `signatures ${report.signatureVersion}: checked ${report.checked}, clean ${report.stillClean}, ` +
    `blocked ${report.blocked}, skipped ${report.skipped}, failed ${report.failed}` +
    (report.budgetReached ? ', budget reached' : '') +
    ` (${report.organizations} organization(s))`
  );
}
