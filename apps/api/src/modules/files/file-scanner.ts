import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { uuidv7 } from '@tmanage/domain';
import type { AuditMetadata } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore, Promotion } from '@tmanage/storage';
import { ObjectStoreUnavailableError } from '../../common/storage/storage.module.js';
import { ScanError, ScannerUnavailableError } from '../../common/scan/malware-scanner.js';
import type { MalwareScanner, ScanResult } from '../../common/scan/malware-scanner.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { FileAssetTransitionError } from './file-assets.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { describeFailure } from './upload-session-sweeper.js';

/**
 * FILE-002, slice B — the scan pass: `23-ERD` §10's `scanning → ready | rejected`,
 * `03-ARCHITECTURE` §108's "malware scan … asset becomes available", `49` §4's promotion
 * out of quarantine.
 *
 * A verified asset is an object in quarantine whose bytes have a digest and a detected type
 * on the version, and a row that says `scanning`. This pass finds every such asset in every
 * organization and, for each, reads the object **once more and only once**: the same
 * stream feeds the SHA-256 digest (held to the verified `content_hash` — an object that
 * changed under a sealed version is an error, never a verdict), the scanner, and the
 * promotion's sink in the private zone. Then, in one transaction, it records the verdict
 * on the version, moves the asset, writes the audit row and appends the event. What lands
 * in `private` is therefore, by construction, the bytes the scanner cleared: promotion is
 * not a copy (`ObjectStore`'s header; the fleet's first refutation of this slice).
 *
 * ## The claim, the bound, and why a failed row waits
 *
 * `scanning` has no sub-state in the machine, so the claim is a column: `scan_claimed_at`,
 * taken conditionally on the row's `version` ({@link FileAssetsRepository.claimForScan}).
 * A claim older than {@link STALE_SCAN_CLAIM_MS} (decision 13, the verifier's bound)
 * belongs to a pass that died and is retried. A claim is **left standing on failure**: the
 * row waits out the bound before its next try, so one object a scanner times out on
 * cannot fill every batch in its organization and starve the rest (the fleet's finding
 * against a claimless pass). Two passes that overlap on a stale claim both read the object;
 * the final transaction decides, as in the verifier, and a private object the loser sealed
 * is withdrawn unless the row is by then `ready` — in which case it is the same bytes.
 *
 * ## The three verdicts, and the one that is not
 *
 * - **clean** — the promotion is committed (the private object exists), then one
 *   transaction: `recordScan` (`clean`, the time, the scanner, `trust_zone = private`),
 *   `scanning → ready`, `file_asset.scanned` (`allowed`), `file.ready.v1`. The order is
 *   deliberate: a row that says `private` and `ready` with no object behind it could
 *   never be repaired (`ready` is terminal), while an object with no row saying so is
 *   withdrawn on the next conclusion. 0019's trigger refuses `ready` at the engine
 *   unless the latest version is clean and promoted.
 * - **infected** — the promotion is aborted, then one transaction: `recordScan`
 *   (`infected`), `scanning → rejected` with `rejection_code: malware_detected`,
 *   `file_asset.rejected` (`denied`), `file.rejected.v1`; then any private object under
 *   the key — a crashed earlier run's — is withdrawn. The engine's detection name goes to
 *   stderr with the asset id and the correlation id, and nowhere else (`24` §7; the audit
 *   value rule). The quarantine object stays and stays counted (decision F4).
 * - **unscanned** — the `none` driver (decision F3): no object is opened; the version is
 *   recorded `unscanned` with the time and `none`, one `file_asset.scan_failed` row says
 *   `no_scanner`, and the asset stays `scanning`. Recorded once: the selection skips a
 *   version already `unscanned` until a real scanner is configured, which then replaces
 *   it — the one verdict the trigger lets a later scan replace.
 * - **failed** — the object is missing, its size or digest is not the version's, the
 *   scanner timed out or answered something that is not a verdict: nothing moves, the
 *   claim stands, `file_asset.scan_failed` (`error`) is the trace. A verdict that already
 *   stands and differs from this scan's is `file_asset.scan_disputed` — the loudest row
 *   this pass can write, a signature update or an overlap that would have changed a
 *   decision — and the standing verdict holds.
 *
 * A scanner that cannot be reached at all is probed **before** anything is claimed and
 * stops the pass with one line; a store that is not wired stops it at the first asset, as
 * the verifier's does. {@link MAX_CONSECUTIVE_FAILURES} per-asset failures in a row stop
 * it too: an engine that accepts and hangs is an outage, not fifty timeouts.
 */

export interface ScanReport {
  readonly organizations: number;
  readonly scanned: number;
  /** Assets this pass promoted and moved to `ready`. */
  readonly ready: number;
  /** Assets this pass moved to `rejected` on an infected verdict. */
  readonly rejected: number;
  /** Versions recorded `unscanned` under the `none` driver. */
  readonly unscanned: number;
  /** Rows another pass held or concluded first. */
  readonly skipped: number;
  /** Assets the pass could not judge. Named on stderr; the claim stands. */
  readonly failed: number;
  /** Stale claims this pass took over (decision 13). */
  readonly reran: number;
}

export const SCAN_POLICY_VERSION = 'file-scan';
export const SCAN_BATCH_SIZE = 50;
const MAX_BATCHES_PER_ORGANIZATION = 100;
/** Consecutive per-asset failures that end the pass: an engine that hangs is an outage. */
export const MAX_CONSECUTIVE_FAILURES = 5;
/** Decision 13, the verifier's bound. */
export const STALE_SCAN_CLAIM_MS = 15 * 60_000;

export function staleScanClaimCutoff(now: Date): Date {
  return new Date(now.getTime() - STALE_SCAN_CLAIM_MS);
}

export const SCAN_SCAN_REASON =
  'finding which organizations hold verified file assets awaiting a malware scan, or scan ' +
  'claims gone stale, so each can be judged under its own service context (FILE-002)';

export function scannerContextFor(organizationId: string, correlationId: string): TenantContext {
  return createServiceContext({
    organizationId,
    correlationId,
    policyVersion: SCAN_POLICY_VERSION,
  });
}

/** The token `file_assets.rejection_code` carries for an infected verdict. */
export const MALWARE_REJECTION_CODE = 'malware_detected';

type FailureCause =
  | 'object_not_found'
  | 'store_error'
  | 'size_mismatch'
  | 'hash_mismatch'
  | 'no_version'
  | 'not_verified'
  | 'no_scanner'
  | 'timeout'
  | 'engine_error'
  | 'protocol_error'
  | 'stream_error'
  | 'unexpected';

class ScanFailure extends Error {
  constructor(readonly failure: FailureCause) {
    super(`scan failed: ${failure}`);
    this.name = 'ScanFailure';
  }
}

class ScanDisputed extends Error {
  constructor(
    readonly standing: string,
    readonly reached: string,
  ) {
    super(`scan disputed: ${standing} stands, ${reached} reached`);
    this.name = 'ScanDisputed';
  }
}

export class FileScanner {
  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
    private readonly store: ObjectStore,
    private readonly scanner: MalwareScanner,
    private readonly audit: AuditService | null,
    private readonly outbox: OutboxEventsRepository | null,
    private readonly now: () => Date = () => new Date(),
    private readonly onFailure: (fileAssetId: string, error: unknown) => void = (id, error) =>
      console.error(`[scanner] scanning file asset ${id} failed`, describeFailure(error)),
    /** The one place the engine's detection name is written: stderr, for an operator. */
    private readonly onDetection: (
      fileAssetId: string,
      correlationId: string,
      detection: string,
    ) => void = (id, correlationId, detection) =>
      console.error(`[scanner] file asset ${id} rejected: ${detection} (${correlationId})`),
  ) {}

  /** One pass over every organization. Safe to run again at once: a second pass finds nothing. */
  async scan(): Promise<ScanReport> {
    // Before a single row is claimed: an unreachable engine is one line, not a claim on
    // every row that then waits out the bound for nothing.
    await this.scanner.probe();

    const correlationId = uuidv7();
    const now = this.now();
    const options = {
      staleBefore: staleScanClaimCutoff(now),
      rescanUnscanned: this.scanner.kind === 'engine',
    };
    const organizations = await this.database.bootstrapRead(
      { correlationId, reason: SCAN_SCAN_REASON, tables: ['file_assets', 'file_versions'] },
      (db) => this.assets.organizationsAwaitingScan(db, options),
    );

    let scanned = 0;
    let ready = 0;
    let rejected = 0;
    let unscanned = 0;
    let skipped = 0;
    let failed = 0;
    let reran = 0;
    let consecutiveFailures = 0;

    for (const organizationId of organizations) {
      const listContext = scannerContextFor(organizationId, correlationId);
      for (let batch = 0; batch < MAX_BATCHES_PER_ORGANIZATION; batch += 1) {
        const rows = await this.database.read(listContext, (db) =>
          this.assets.listAwaitingScan(db, listContext, options, SCAN_BATCH_SIZE),
        );
        scanned += rows.length;
        let movedInBatch = 0;
        for (const row of rows) {
          if (row.scanClaimedAt !== null) reran += 1;
          // One correlation id per asset: the audit row and the outbox row it produces
          // share it, and `35` :100's copy can name it to the uploader.
          const context = scannerContextFor(organizationId, uuidv7());
          try {
            const outcome = await this.scanOne(context, row, options.staleBefore);
            if (outcome === 'ready') ready += 1;
            else if (outcome === 'rejected') rejected += 1;
            else if (outcome === 'unscanned') unscanned += 1;
            else skipped += 1;
            if (outcome !== 'skipped') movedInBatch += 1;
            consecutiveFailures = 0;
          } catch (error) {
            if (error instanceof ObjectStoreUnavailableError) throw error;
            if (error instanceof ScannerUnavailableError) throw error;
            failed += 1;
            consecutiveFailures += 1;
            this.onFailure(row.id, error);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              throw new ScannerUnavailableError(
                `${consecutiveFailures} consecutive failures; the pass stops`,
              );
            }
          }
        }
        if (rows.length < SCAN_BATCH_SIZE || movedInBatch === 0) break;
      }
    }

    return {
      organizations: organizations.length,
      scanned,
      ready,
      rejected,
      unscanned,
      skipped,
      failed,
      reran,
    };
  }

  private async scanOne(
    context: TenantContext,
    row: FileAssetRow,
    staleBefore: Date,
  ): Promise<'ready' | 'rejected' | 'unscanned' | 'skipped'> {
    // The `none` driver claims nothing: it opens no object, its one write is conditional,
    // and a version it parks must be a real scanner's the moment one is configured — not
    // after a claim's bound.
    if (this.scanner.kind === 'engine') {
      const claimed = await this.database.transaction(context, (tx) =>
        this.assets.claimForScan(tx, context, row, this.now(), staleBefore),
      );
      if (!claimed) return 'skipped';
    }

    const version = await this.database.read(context, (db) =>
      this.assets.findLatestVersion(db, context, row.id),
    );
    try {
      if (!version) throw new ScanFailure('no_version');
      if (version.contentHash === null) throw new ScanFailure('not_verified');
      if (this.scanner.kind === 'none') return await this.recordUnscanned(context, row, version);
      return await this.judge(context, row, version);
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) throw error;
      if (error instanceof ScannerUnavailableError) throw error;
      if (error instanceof ScanDisputed) {
        await this.recordDisputed(context, row, version, error);
        throw error;
      }
      await this.recordFailure(context, row, version, error);
      throw error;
    }
  }

  /** The `none` driver: the truth on the row, once, and nothing opened. */
  private async recordUnscanned(
    context: TenantContext,
    row: FileAssetRow,
    version: FileVersionRow,
  ): Promise<'unscanned' | 'skipped'> {
    const scannedAt = this.now();
    return this.database.transaction(context, async (tx) => {
      const recorded = await this.assets.recordScan(tx, context, version.id, {
        scanVerdict: 'unscanned',
        scannedAt,
        scanner: this.scanner.name,
      });
      // A verdict of any kind already stands — another pass got here first.
      if (!recorded) return 'skipped' as const;
      await this.audit?.record(tx, context, {
        action: 'file_asset.scan_failed',
        objectId: row.id,
        result: 'error',
        actorUserId: null,
        metadata: {
          project_id: row.projectId,
          purpose: row.purpose,
          file_version_id: version.id,
          scanner: this.scanner.name,
          cause: 'no_scanner',
        },
      });
      return 'unscanned' as const;
    });
  }

  /** The one read: digest, scanner and promotion sink from the same stream. */
  private async judge(
    context: TenantContext,
    row: FileAssetRow,
    version: FileVersionRow,
  ): Promise<'ready' | 'rejected' | 'skipped'> {
    let opened;
    try {
      opened = await this.store.openObject({ zone: 'quarantine', objectKey: version.objectKey });
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) throw error;
      if (error instanceof ObjectNotFoundError) throw new ScanFailure('object_not_found');
      throw new ScanFailure('store_error');
    }
    if (opened.sizeBytes !== version.sizeBytes) {
      destroy(opened.stream);
      throw new ScanFailure('size_mismatch');
    }

    let promotion: Promotion;
    try {
      promotion = await this.store.promote({
        objectKey: version.objectKey,
        sizeBytes: version.sizeBytes,
      });
    } catch (error) {
      destroy(opened.stream);
      if (error instanceof ObjectStoreUnavailableError) throw error;
      throw new ScanFailure('store_error');
    }

    const toScanner = new PassThrough();
    const scanning = this.scanner.scan({ stream: toScanner, sizeBytes: version.sizeBytes });
    // Settled either way below; an early engine reply must not be an unhandled rejection.
    scanning.catch(() => undefined);
    const hash = createHash('sha256');
    let result: ScanResult;
    let sizeBytes = 0;
    try {
      try {
        for await (const piece of opened.stream) {
          const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
          sizeBytes += chunk.length;
          if (sizeBytes > version.sizeBytes) throw new ScanFailure('size_mismatch');
          hash.update(chunk);
          await writeTo(promotion.sink, chunk);
          await writeTo(toScanner, chunk);
        }
        toScanner.end();
        result = await scanning;
      } catch (error) {
        // The scanner's own failure is the more precise one when both sides broke.
        const scanFailure = await scanning.then(
          () => null,
          (failure: unknown) => failure,
        );
        if (scanFailure instanceof ScanError) throw new ScanFailure(scanFailure.failure);
        if (error instanceof ScanFailure) throw error;
        if (error instanceof ScanError) throw new ScanFailure(error.failure);
        throw new ScanFailure('stream_error');
      }
      if (sizeBytes !== version.sizeBytes) throw new ScanFailure('size_mismatch');
      const digest = hash.digest('hex');
      if (digest !== version.contentHash) throw new ScanFailure('hash_mismatch');
    } catch (error) {
      destroy(opened.stream);
      destroy(toScanner);
      await promotion.abort();
      throw error;
    }

    if (result.verdict === 'infected') {
      await promotion.abort();
      return this.reject(context, row, version, result.detection ?? 'unnamed');
    }
    return this.promote(context, row, version, promotion);
  }

  private async promote(
    context: TenantContext,
    row: FileAssetRow,
    version: FileVersionRow,
    promotion: Promotion,
  ): Promise<'ready' | 'skipped'> {
    try {
      await promotion.commit();
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) throw error;
      throw new ScanFailure('store_error');
    }
    const scannedAt = this.now();
    const metadata: AuditMetadata = {
      project_id: row.projectId,
      purpose: row.purpose,
      file_version_id: version.id,
      size_bytes: version.sizeBytes,
      scanner: this.scanner.name,
      verdict: 'clean',
      trust_zone: 'private',
    };
    try {
      return await this.database.transaction(context, async (tx) => {
        await this.recordVerdict(tx, context, version, 'clean', scannedAt);
        await this.assets.transition(tx, context, row.id, 'ready', {
          scanVerdict: 'clean',
          scannedAt,
        });
        await this.audit?.record(tx, context, {
          action: 'file_asset.scanned',
          objectId: row.id,
          result: 'allowed',
          actorUserId: null,
          metadata,
        });
        await this.outbox?.append(tx, context, {
          type: 'file.ready.v1',
          aggregateId: row.id,
          payload: {
            fileAssetId: row.id,
            fileVersionId: version.id,
            projectId: row.projectId,
            purpose: row.purpose,
            objectId: row.objectId,
            sizeBytes: version.sizeBytes,
          },
        });
        return 'ready' as const;
      });
    } catch (error) {
      if (error instanceof FileAssetTransitionError) {
        // Another pass concluded the row first. If it is `ready`, the object we sealed is
        // the same bytes and stays; anything else must not keep a private object.
        const current = await this.database.read(context, (db) =>
          this.assets.findById(db, context, row.id),
        );
        if (current?.status !== 'ready') await this.withdrawQuietly(version.objectKey);
        return 'skipped';
      }
      if (!(error instanceof ScanDisputed)) await this.withdrawQuietly(version.objectKey);
      else if (error.standing !== 'clean') await this.withdrawQuietly(version.objectKey);
      throw error;
    }
  }

  private async reject(
    context: TenantContext,
    row: FileAssetRow,
    version: FileVersionRow,
    detection: string,
  ): Promise<'rejected' | 'skipped'> {
    const scannedAt = this.now();
    const metadata: AuditMetadata = {
      project_id: row.projectId,
      purpose: row.purpose,
      file_version_id: version.id,
      size_bytes: version.sizeBytes,
      scanner: this.scanner.name,
      verdict: 'infected',
      rejection_code: MALWARE_REJECTION_CODE,
    };
    let outcome: 'rejected' | 'skipped';
    try {
      outcome = await this.database.transaction(context, async (tx) => {
        await this.recordVerdict(tx, context, version, 'infected', scannedAt);
        await this.assets.transition(tx, context, row.id, 'rejected', {
          rejectionCode: MALWARE_REJECTION_CODE,
        });
        await this.audit?.record(tx, context, {
          action: 'file_asset.rejected',
          objectId: row.id,
          result: 'denied',
          actorUserId: null,
          metadata,
        });
        await this.outbox?.append(tx, context, {
          type: 'file.rejected.v1',
          aggregateId: row.id,
          payload: {
            fileAssetId: row.id,
            fileVersionId: version.id,
            projectId: row.projectId,
            purpose: row.purpose,
            objectId: row.objectId,
            rejectionCode: MALWARE_REJECTION_CODE,
          },
        });
        return 'rejected' as const;
      });
    } catch (error) {
      if (!(error instanceof FileAssetTransitionError)) throw error;
      outcome = 'skipped';
    }
    // A crashed earlier run may have sealed this version's bytes in private; a rejected
    // asset keeps no private object. Never when the row went `ready` under another pass —
    // that is the disputed case above, and the standing verdict holds.
    const current = await this.database.read(context, (db) =>
      this.assets.findById(db, context, row.id),
    );
    if (current?.status !== 'ready') await this.withdrawQuietly(version.objectKey);
    if (outcome === 'rejected') this.onDetection(row.id, context.correlationId, detection);
    return outcome;
  }

  /** `recordScan`, conditional; a standing final verdict that differs is disputed. */
  private async recordVerdict(
    tx: TenantQueryRunner,
    context: TenantContext,
    version: FileVersionRow,
    verdict: 'clean' | 'infected',
    scannedAt: Date,
  ): Promise<void> {
    const recorded = await this.assets.recordScan(tx, context, version.id, {
      scanVerdict: verdict,
      scannedAt,
      scanner: this.scanner.name,
    });
    if (recorded) return;
    const standing = await this.assets.findVersionById(tx, context, version.id);
    if (standing?.scanVerdict !== verdict) {
      throw new ScanDisputed(standing?.scanVerdict ?? 'none', verdict);
    }
    // Equal: a redelivery. The move below decides whether anything is left to do.
  }

  private async recordFailure(
    context: TenantContext,
    row: FileAssetRow,
    version: FileVersionRow | null,
    error: unknown,
  ): Promise<void> {
    if (!this.audit) return;
    const cause: FailureCause = error instanceof ScanFailure ? error.failure : 'unexpected';
    const audit = this.audit;
    try {
      await this.database.transaction(context, (tx: TenantQueryRunner) =>
        audit.record(tx, context, {
          action: 'file_asset.scan_failed',
          objectId: row.id,
          result: 'error',
          actorUserId: null,
          metadata: {
            project_id: row.projectId,
            purpose: row.purpose,
            ...(version ? { file_version_id: version.id } : {}),
            scanner: this.scanner.name,
            cause,
            ...(error instanceof Error && cause === 'unexpected' ? { error_name: error.name } : {}),
          },
        }),
      );
    } catch {
      // Deliberately swallowed: the caller's `onFailure` line still names the row.
    }
  }

  private async recordDisputed(
    context: TenantContext,
    row: FileAssetRow,
    version: FileVersionRow | null,
    dispute: ScanDisputed,
  ): Promise<void> {
    if (!this.audit) return;
    const audit = this.audit;
    try {
      await this.database.transaction(context, (tx: TenantQueryRunner) =>
        audit.record(tx, context, {
          action: 'file_asset.scan_disputed',
          objectId: row.id,
          result: 'error',
          actorUserId: null,
          metadata: {
            project_id: row.projectId,
            purpose: row.purpose,
            ...(version ? { file_version_id: version.id } : {}),
            scanner: this.scanner.name,
            standing_verdict: dispute.standing,
            new_verdict: dispute.reached,
          },
        }),
      );
    } catch {
      // Deliberately swallowed, as above.
    }
  }

  private async withdrawQuietly(objectKey: string): Promise<void> {
    try {
      await this.store.withdraw({ objectKey });
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) throw error;
      // The next conclusion on this row withdraws again; the row says `quarantine`.
      console.error(`[scanner] withdrawing a private object failed`, describeFailure(error));
    }
  }
}

function writeTo(sink: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sink.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

function destroy(stream: NodeJS.ReadableStream | NodeJS.WritableStream): void {
  const candidate = stream as { destroy?: () => void; destroyed?: boolean };
  if (typeof candidate.destroy === 'function' && !candidate.destroyed) candidate.destroy();
}

/** The one line a pass prints — `[scanner] pass: …` on stderr. */
export function describeScan(report: ScanReport): string {
  return (
    `scanned ${report.scanned}, ready ${report.ready}, rejected ${report.rejected}, ` +
    `unscanned ${report.unscanned}, skipped ${report.skipped}, failed ${report.failed}` +
    (report.reran > 0 ? `, ${report.reran} re-run` : '') +
    ` (${report.organizations} organization(s))`
  );
}
