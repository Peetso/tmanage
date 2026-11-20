import { createHash } from 'node:crypto';
import { uuidv7 } from '@tmanage/domain';
import type { AuditMetadata } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore } from '@tmanage/storage';
import { ObjectStoreUnavailableError } from '../../common/storage/storage.module.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type {
  FileAssetRow,
  FileVersionRow,
  UploadSessionRow,
} from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { inspectStoredArchive, ZIP_FAMILY_TOKENS } from './archive-inspection.js';
import type { ArchiveRefusal, ArchiveRejectionCode } from './archive-inspection.js';
import { SIGNATURE_WINDOW_BYTES, TextualCheck, judgeContentType } from './content-signature.js';
import type { DetectedTypeToken, RejectionCode } from './content-signature.js';
import { FileAssetTransitionError } from './file-assets.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { UploadSessionsRepository } from './upload-sessions.repository.js';
import type { FileBlockNotifier } from './file-block-notifier.js';
import { describeFailure } from './upload-session-sweeper.js';

/** The ZIP-family types that are Office Open XML (a `vbaProject.bin` there is a macro). */
const OFFICE_TOKENS: ReadonlySet<string> = new Set(['docx', 'xlsx', 'pptx']);

/**
 * FILE-002, slice A — the verification pass: `23-ERD` §10's `uploaded → verifying →
 * scanning | rejected`, `03-ARCHITECTURE` §108's "worker verifies checksum, MIME, size".
 *
 * An upload that completed is an object in quarantine and a row that says `uploaded`.
 * Until this pass has looked at it, nothing has: the size the provider counted is the only
 * fact about the bytes, the declared type is a label the client chose, and
 * `declared_content_hash` has been stored and compared to nothing. One pass finds every
 * such asset in every organization and, for each, reads the object **once** — the SHA-256
 * digest, the first bytes' signature and the whole-object text check in the same stream —
 * and then, in one transaction, records what it read on the version, moves the asset, and
 * writes the audit row (and, for a rejection, `file.rejected.v1`). Nothing here promotes
 * an object, and nothing reaches `ready`: that needs a scan verdict (slice B).
 *
 * ## Why it is a pass in the API and not a consumer in the worker (decision F2)
 *
 * Hashing a file is a stream over the object store and a scanner will be a network call;
 * neither belongs inside the relay's batch transaction (row locks held across the read) nor
 * in its at-most-once `afterCommit`. The split the ticket asks for runs along the
 * transaction boundary: the state moves are transactional and conditional, and the work
 * runs outside them, in the sweeper's shape — `verify:once` beside `sweep:once` on the
 * same external tick (USAGE-001 decision 10), under `tmanage_app`, which holds the one new
 * grant this needs (`UPDATE` on `file_versions`, `users.sql`). `49` §73's separate
 * quarantine identity is the paid-beta follow-up, recorded.
 *
 * ## The claim is the machine's own move, and the guard is the last transaction
 *
 * `uploaded → verifying` is taken per asset in its own short transaction before the object
 * is opened, so two passes cannot both start on a fresh row. A pass that dies mid-object
 * leaves the row `verifying`; a later pass re-runs it once it is older than
 * {@link STALE_VERIFYING_MS} (decision 13, below) — with no claim of its own, since the
 * machine has no `verifying → verifying`. Two passes may therefore overlap on a stale row
 * and both read the object; only the final transaction decides, because its move is
 * conditional on the status it leaves and the audit and outbox rows live inside it. The
 * loser sees `FileAssetTransitionError` and counts the row `skipped`, and no second audit
 * row exists. The version's facts are written conditionally on NULL; a loser that finds
 * them already written compares — an equal digest is a redelivery, a different one is an
 * object that changed under a sealed version, which is an error and never a rewrite.
 *
 * ## What each outcome means
 *
 * - **verified** — the digest matches the declaration when one was given, the declared
 *   type is in the allowlist and the bytes carry its signature: the version gets
 *   `content_hash` and `detected_mime_type`, the asset goes `verifying → scanning`, and
 *   `file_asset.verified` (`allowed`) is recorded.
 * - **rejected** — `hash_mismatch`, `type_not_allowed` or `type_mismatch`
 *   (`content-signature.ts`), or — for a ZIP-family object (`zip`, `docx`, `xlsx`, `pptx`) whose
 *   type passed — what its central directory holds (`archive-inspection.ts`, security review
 *   FIX5 M2/L3: `macro_office`, `archive_contains_blocked`, `archive_nested`,
 *   `archive_encrypted` for the client door, `archive_unreadable`). The directory is read with
 *   ranged reads of the object's tail after the main read; nothing is inflated. Member and
 *   client uploads take the same path; the session's `client_organization_id` tells the door
 *   apart. The version gets `content_hash` (the bytes are evidence) and
 *   no detected type, the asset goes `verifying → rejected` with `rejection_code`,
 *   `file_asset.rejected` (`denied`) is recorded and `file.rejected.v1` is appended. The
 *   object stays in quarantine, is never promoted, and its bytes **stay counted** until
 *   FILE-003's deletion confirms otherwise (`49` §5 and §108; decision F4).
 * - **failed** — the pass could not judge: the store is down, the object is missing, the
 *   size on disk is not the row's, a verdict already stands and differs. Nothing moves; the
 *   row stays `verifying` for a re-run (`27` REL-05: "file remains quarantined and
 *   retryable"), and `file_asset.scan_failed` (`error`) is the trace, written in its own
 *   best-effort transaction so a failed store never hides why.
 *
 * A store that is not wired at all (`ObjectStoreUnavailableError` — `STORAGE_DRIVER=s3`
 * before FILE-003) stops the pass at the first asset rather than recording one error per
 * asset in every tenant; the process exits non-zero and the rows wait.
 *
 * ## Decision 13 — the stale bound
 *
 * {@link STALE_VERIFYING_MS} is fifteen minutes, the sweeper's `STALE_CLAIM_MS`. A live pass
 * moves its row again within one object's read; a row older than this belongs to a pass
 * that died. Too short and a slow read of a large object is shadowed by a second pass
 * (wasted I/O, no incorrect state); too long and a dead pass's asset waits. Peter's to
 * change — one edit here.
 */

export interface VerifyReport {
  /** Organizations that held at least one asset to look at when the pass began. */
  readonly organizations: number;
  /** Rows the per-organization batches selected, over the whole pass. */
  readonly scanned: number;
  /** Assets this pass moved to `scanning`. */
  readonly verified: number;
  /** Assets this pass moved to `rejected`. */
  readonly rejected: number;
  /** Rows another pass moved first, or that had left `uploaded`/`verifying` meanwhile. */
  readonly skipped: number;
  /** Assets the pass could not judge. Named on stderr; the row stays `verifying`. */
  readonly failed: number;
  /** Stale `verifying` rows this pass re-ran (decision 13). */
  readonly reran: number;
}

/** The `policyVersion` every verifier context carries — a literal no resolved context can produce. */
export const VERIFY_POLICY_VERSION = 'file-verification';

/** Rows per organization per batch. */
export const VERIFY_BATCH_SIZE = 50;

/** A ceiling on batches per organization per pass, so a row that fails every time cannot loop forever. */
const MAX_BATCHES_PER_ORGANIZATION = 100;

/** Decision 13 (see the header). */
export const STALE_VERIFYING_MS = 15 * 60_000;

export function staleVerifyingCutoff(now: Date): Date {
  return new Date(now.getTime() - STALE_VERIFYING_MS);
}

/** The reason string the bootstrap read records on every guard event it raises. */
export const VERIFY_SCAN_REASON =
  'finding which organizations hold uploaded file assets awaiting verification, or ' +
  'verifications gone stale, so each can be judged under its own service context (FILE-002)';

export function verifierContextFor(organizationId: string, correlationId: string): TenantContext {
  return createServiceContext({
    organizationId,
    correlationId,
    policyVersion: VERIFY_POLICY_VERSION,
  });
}

/** What one read of the object established. */
interface Reading {
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly head: Buffer;
  readonly textual: TextualCheck;
}

/** Why a pass could not judge an asset — a token, for the audit row. */
type FailureCause =
  | 'object_not_found'
  | 'store_error'
  | 'size_mismatch'
  | 'verdict_conflict'
  | 'no_version'
  | 'no_session';

class VerificationFailure extends Error {
  constructor(readonly failure: FailureCause) {
    super(`verification failed: ${failure}`);
    this.name = 'VerificationFailure';
  }
}

export class FileVerifier {
  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
    private readonly sessions: UploadSessionsRepository,
    private readonly store: ObjectStore,
    private readonly audit: AuditService | null,
    private readonly outbox: OutboxEventsRepository | null,
    /** Injectable for the suite; the process clock otherwise. */
    private readonly now: () => Date = () => new Date(),
    /** Where a failed asset is reported. The row is named, never its payload. */
    private readonly onFailure: (fileAssetId: string, error: unknown) => void = (id, error) =>
      console.error(`[verifier] verifying file asset ${id} failed`, describeFailure(error)),
    /** QA-FIX S5. Tells the uploader their file was refused; `null` in suites that do not care. */
    private readonly notifier: FileBlockNotifier | null = null,
  ) {}

  /** One pass over every organization. Safe to run again at once: a second pass finds nothing. */
  async verify(): Promise<VerifyReport> {
    const correlationId = uuidv7();
    const staleBefore = staleVerifyingCutoff(this.now());
    const organizations = await this.database.bootstrapRead(
      { correlationId, reason: VERIFY_SCAN_REASON, tables: ['file_assets'] },
      (db) => this.assets.organizationsAwaitingVerification(db, staleBefore),
    );

    let scanned = 0;
    let verified = 0;
    let rejected = 0;
    let skipped = 0;
    let failed = 0;
    let reran = 0;

    for (const organizationId of organizations) {
      const context = verifierContextFor(organizationId, correlationId);
      for (let batch = 0; batch < MAX_BATCHES_PER_ORGANIZATION; batch += 1) {
        const rows = await this.database.read(context, (db) =>
          this.assets.listAwaitingVerification(db, context, staleBefore, VERIFY_BATCH_SIZE),
        );
        scanned += rows.length;
        let movedInBatch = 0;
        for (const row of rows) {
          if (row.status === 'verifying') reran += 1;
          // One correlation id per asset (slice B): the audit row and the outbox row an
          // asset produces share it, so `35` :100's copy can name it to the uploader.
          const assetContext = verifierContextFor(organizationId, uuidv7());
          try {
            const outcome = await this.verifyOne(assetContext, row);
            if (outcome === 'verified') verified += 1;
            else if (outcome === 'rejected') rejected += 1;
            else skipped += 1;
            if (outcome !== 'skipped') movedInBatch += 1;
          } catch (error) {
            // A store that is not wired stops the pass: every asset in every tenant would
            // fail the same way, and one error line says more than a thousand audit rows.
            if (error instanceof ObjectStoreUnavailableError) throw error;
            failed += 1;
            this.onFailure(row.id, error);
          }
        }
        // A batch that moved nothing has only rows that failed or were taken by someone
        // else; selecting again would find the same rows.
        if (rows.length < VERIFY_BATCH_SIZE || movedInBatch === 0) break;
      }
    }

    return {
      organizations: organizations.length,
      scanned,
      verified,
      rejected,
      skipped,
      failed,
      reran,
    };
  }

  /**
   * One asset: the claim, the read, the verdict transaction. Returns what became of the
   * row; throws when it could not be judged (after recording `scan_failed`).
   */
  private async verifyOne(
    context: TenantContext,
    row: FileAssetRow,
  ): Promise<'verified' | 'rejected' | 'skipped'> {
    if (row.status === 'uploaded') {
      const claimed = await this.claim(context, row.id);
      if (!claimed) return 'skipped';
    }

    const version = await this.database.read(context, (db) =>
      this.assets.findLatestVersion(db, context, row.id),
    );
    const session = await this.database.read(context, (db) =>
      this.sessions.findCompletedForAsset(db, context, row.id),
    );
    try {
      if (!version) throw new VerificationFailure('no_version');
      if (!session) throw new VerificationFailure('no_session');
      const reading = await this.read(version);
      const archive = await this.inspectArchive(version, session, reading);
      return await this.conclude(
        context,
        row,
        version,
        session.declaredContentHash,
        reading,
        archive,
      );
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) throw error;
      await this.recordFailure(context, row, version, error);
      throw error;
    }
  }

  /** `uploaded → verifying`, in its own short transaction. `false` when somebody moved it first. */
  private async claim(context: TenantContext, fileAssetId: string): Promise<boolean> {
    try {
      await this.database.transaction(context, (tx) =>
        this.assets.transition(tx, context, fileAssetId, 'verifying'),
      );
      return true;
    } catch (error) {
      if (error instanceof FileAssetTransitionError) return false;
      throw error;
    }
  }

  /**
   * The one read. The digest, the first {@link SIGNATURE_WINDOW_BYTES} and the text check
   * are fed from the same stream; nothing beyond the window is retained. The count is
   * held to the row's `size_bytes` — an object that is not the size the completion
   * recorded is not the object the completion recorded, and is an error, not a verdict.
   */
  private async read(version: FileVersionRow): Promise<Reading> {
    let opened;
    try {
      opened = await this.store.openObject({ zone: 'quarantine', objectKey: version.objectKey });
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) throw error;
      if (error instanceof ObjectNotFoundError) throw new VerificationFailure('object_not_found');
      throw new VerificationFailure('store_error');
    }
    if (opened.sizeBytes !== version.sizeBytes) {
      destroy(opened.stream);
      throw new VerificationFailure('size_mismatch');
    }

    const hash = createHash('sha256');
    const textual = new TextualCheck();
    const window = Buffer.alloc(SIGNATURE_WINDOW_BYTES);
    let windowUsed = 0;
    let sizeBytes = 0;
    try {
      for await (const piece of opened.stream) {
        const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
        hash.update(chunk);
        textual.update(chunk);
        if (windowUsed < window.length) {
          windowUsed += chunk.copy(window, windowUsed, 0, window.length - windowUsed);
        }
        sizeBytes += chunk.length;
        if (sizeBytes > version.sizeBytes) {
          destroy(opened.stream);
          throw new VerificationFailure('size_mismatch');
        }
      }
    } catch (error) {
      if (error instanceof VerificationFailure) throw error;
      throw new VerificationFailure('store_error');
    }
    if (sizeBytes !== version.sizeBytes) throw new VerificationFailure('size_mismatch');
    return {
      contentHash: hash.digest('hex'),
      sizeBytes,
      head: window.subarray(0, windowUsed),
      textual,
    };
  }

  /**
   * FIX5 M2/L3. For an object whose digest and type passed and whose bytes are a ZIP, the
   * refusal its directory earns, or `null`. Any other object is not opened again.
   */
  private async inspectArchive(
    version: FileVersionRow,
    session: UploadSessionRow,
    reading: Reading,
  ): Promise<ArchiveRefusal | null> {
    if (
      session.declaredContentHash !== null &&
      session.declaredContentHash !== reading.contentHash
    ) {
      return null;
    }
    const judgement = judgeContentType(version.declaredMimeType, reading.head, reading.textual);
    if (!judgement.ok || !ZIP_FAMILY_TOKENS.has(judgement.detectedType)) return null;
    try {
      return await inspectStoredArchive(
        this.store,
        { zone: 'quarantine', objectKey: version.objectKey, sizeBytes: reading.sizeBytes },
        {
          channel: session.clientOrganizationId === null ? 'member' : 'client',
          officeOpenXml: OFFICE_TOKENS.has(judgement.detectedType),
          figmaFile: judgement.detectedType === 'fig',
        },
      );
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) throw error;
      if (error instanceof ObjectNotFoundError) throw new VerificationFailure('object_not_found');
      throw new VerificationFailure('store_error');
    }
  }

  /**
   * The verdict, in one transaction: the version's facts (conditional on NULL), the asset's
   * move (conditional on `verifying`), the audit row, and the outbox event for a rejection.
   * The order of checks is the header's: the digest against the declaration first — bytes
   * that are not what the client said they sent are not judged further — then the type.
   */
  private async conclude(
    context: TenantContext,
    row: FileAssetRow,
    version: FileVersionRow,
    declaredContentHash: string | null,
    reading: Reading,
    archive: ArchiveRefusal | null = null,
  ): Promise<'verified' | 'rejected' | 'skipped'> {
    let rejectionCode: RejectionCode | ArchiveRejectionCode | null = null;
    let detectedMimeType: string | null = null;
    let detectedType: DetectedTypeToken | null = null;
    if (declaredContentHash !== null && declaredContentHash !== reading.contentHash) {
      rejectionCode = 'hash_mismatch';
    } else {
      const judgement = judgeContentType(version.declaredMimeType, reading.head, reading.textual);
      if (judgement.ok && archive) {
        // The type is what it says; what it carries is not admitted (FIX5 M2/L3).
        detectedType = judgement.detectedType;
        rejectionCode = archive.code;
      } else if (judgement.ok) {
        detectedMimeType = judgement.detectedMimeType;
        detectedType = judgement.detectedType;
      } else {
        rejectionCode = judgement.rejectionCode;
      }
    }

    const metadata: AuditMetadata = {
      project_id: row.projectId,
      purpose: row.purpose,
      file_version_id: version.id,
      size_bytes: reading.sizeBytes,
      sha256: reading.contentHash,
      declared_hash_present: declaredContentHash !== null,
      ...(detectedType ? { detected_type: detectedType } : {}),
      ...(rejectionCode ? { rejection_code: rejectionCode } : {}),
      // A token for what the entry was — never its name, which is content.
      ...(archive ? { archive_entry_kind: archive.finding } : {}),
    };

    try {
      return await this.database.transaction(context, async (tx) => {
        const recorded = await this.assets.recordVerification(tx, context, version.id, {
          contentHash: reading.contentHash,
          detectedMimeType,
        });
        if (!recorded) {
          // A verdict already stands. Equal: a redelivery, and the move below decides
          // whether anything is left to do. Different: the object changed under a sealed
          // version — an error, never a rewrite (0018's trigger would refuse one anyway).
          const standing = await this.assets.findVersionById(tx, context, version.id);
          if (standing?.contentHash !== reading.contentHash) {
            throw new VerificationFailure('verdict_conflict');
          }
        }
        if (rejectionCode) {
          await this.assets.transition(tx, context, row.id, 'rejected', { rejectionCode });
          await this.notifier?.blocked(tx, context, row);
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
              rejectionCode,
            },
          });
          return 'rejected';
        }
        await this.assets.transition(tx, context, row.id, 'scanning', {
          contentHash: reading.contentHash,
          detectedMimeType,
        });
        await this.audit?.record(tx, context, {
          action: 'file_asset.verified',
          objectId: row.id,
          result: 'allowed',
          actorUserId: null,
          metadata,
        });
        return 'verified';
      });
    } catch (error) {
      // The row left `verifying` between the claim and here: another pass concluded it.
      if (error instanceof FileAssetTransitionError) return 'skipped';
      throw error;
    }
  }

  /**
   * `file_asset.scan_failed`, `error`, in its own best-effort transaction: the row stays
   * `verifying` and this is the only trace of why. Swallowed if the log itself cannot be
   * written — the caller's `onFailure` line still names the row.
   */
  private async recordFailure(
    context: TenantContext,
    row: FileAssetRow,
    version: FileVersionRow | null,
    error: unknown,
  ): Promise<void> {
    if (!this.audit) return;
    const cause: FailureCause | 'unexpected' =
      error instanceof VerificationFailure ? error.failure : 'unexpected';
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
            cause,
            ...(error instanceof Error && cause === 'unexpected' ? { error_name: error.name } : {}),
          },
        }),
      );
    } catch {
      // Deliberately swallowed: see above.
    }
  }
}

function destroy(stream: NodeJS.ReadableStream): void {
  const candidate = stream as { destroy?: () => void };
  if (typeof candidate.destroy === 'function') candidate.destroy();
}

/** The one line a pass prints — `[verifier] pass: …` on stderr, distinct from the sweeper's. */
export function describeVerification(report: VerifyReport): string {
  return (
    `scanned ${report.scanned}, verified ${report.verified}, rejected ${report.rejected}, ` +
    `skipped ${report.skipped}, failed ${report.failed}` +
    (report.reran > 0 ? `, ${report.reran} re-run` : '') +
    ` (${report.organizations} organization(s))`
  );
}
