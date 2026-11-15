import { randomUUID } from 'node:crypto';
import { authorize, clientRequestStateMachine } from '@tmanage/domain';
import type { Audience, AuditMetadata, ClientRequestState, Principal } from '@tmanage/domain';
import {
  MissingPartError,
  MultipartUploadNotFoundError,
  PartEtagMismatchError,
  SizeMismatchError,
  uploadObjectKey,
} from '@tmanage/storage';
import type { ObjectStore, StoredObject } from '@tmanage/storage';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type {
  FileAssetRow,
  FileVersionRow,
  UploadPurpose,
  UploadSessionRow,
  UploadSessionStatus,
} from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { ScanRequester } from './file-scan-job.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import { FileAssetTransitionError, type FileAssetsRepository } from './file-assets.repository.js';
import {
  OPEN_STATUSES,
  UploadSessionKeyTakenError,
  UploadSessionNotFoundError,
  type UploadSessionsRepository,
} from './upload-sessions.repository.js';
import { STORAGE_BYTES_METRIC, type UsageCountersRepository } from './usage-counters.repository.js';
import { USAGE_LEDGER_REASON, type UsageLedgerRepository } from './usage-ledger.repository.js';
import type { UsageThresholdEvaluator } from './usage-thresholds.js';
import { mayUploadFor, objectTableFor } from './purpose-policy.js';
import type { ParsedPart, ParsedUploadBody } from './upload-input.js';
import {
  CLIENT_DAILY_UPLOAD_LIMIT,
  classifyUpload,
  DEFAULT_PRESETS,
  resolveScanSource,
  safetyChip,
} from './file-safety.js';
import type { SafetyChip, ScanSource } from './file-safety.js';
import { ARCHIVE_REJECTION_CODES, inspectStoredArchive } from './archive-inspection.js';
import { DailyUploadCountRepository, startOfUtcDay } from './daily-upload-count.repository.js';
import type { FileSafetySettingsSource } from '../tenancy/file-safety-settings.js';
import { usableScanStatus } from './file-download.service.js';
import { effectiveDownloadScanPolicyOn } from '../tenancy/download-scan-policy.js';
import type { ScannerPresence } from '../tenancy/download-scan-policy.js';

/**
 * FILE-001's application service — the upload session, from reservation to a file version.
 *
 * `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY` §6's seven steps, in the order they are
 * written, with one deliberate change of sequence: the provider is asked to open the
 * multipart upload **before** the reservation transaction rather than inside it. A row
 * lock held across a network call to a bucket is how a slow provider becomes a stall for
 * every upload in the tenant; opening first costs a begin-then-abort when the quota then
 * refuses, and that is the cheaper failure.
 *
 * ## Two doors, one aggregate
 *
 * The studio's methods take an internal principal and the client's take a client principal,
 * and each refuses the other kind outright — `ClientRequestsService`'s shape, for
 * `25-AUTH-AND-TENANT-ISOLATION` §7's reason. The views the two doors answer are the same
 * type, because there is nothing in an upload session a client may not see about their own
 * upload: the object key, the one internal fact, is on no view at all.
 *
 * ## What the single read would refuse, the list omits
 *
 * `mayUpload` is `authorize()` over `file.upload` with the row's project, audience and
 * client organization, and the opener's identity on top. `get` refuses with 404; `list`
 * filters. Both are the same predicate. One door is wider: a principal with
 * organization-wide scope may list the studio's sessions and cancel a reserved one —
 * never complete it — so that a leaver's reservation is somebody's to release.
 */

export interface UploadSessionView {
  readonly id: string;
  readonly fileAssetId: string;
  readonly projectId: string;
  readonly purpose: UploadPurpose;
  readonly status: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly partSizeBytes: number;
  readonly partCount: number;
  /** `openapi.yaml` `UploadSession.reservedBytes`: what the quota holds for this session. */
  readonly reservedBytes: number;
  readonly uploadUrls: readonly { readonly partNumber: number; readonly url: string }[];
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** `openapi.yaml` `FileAsset`, plus what DEL-001 and TM-15 need (recorded superset). */
export interface FileAssetView {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly purpose: UploadPurpose;
  readonly projectId: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly fileVersionId: string;
  readonly versionNo: number;
  readonly createdAt: string;
  /**
   * FILE-002 slice C. Why a `rejected` asset was rejected — `12-PERMISSION-MATRIX` §39 makes
   * it security metadata, so the studio sees it (TM-15, `22` :153) and a client never does:
   * the client's projection is {@link ClientFileAssetView}, and `35` :100 fixes their copy.
   */
  readonly rejectionCode: string | null;
  /**
   * Security review FIX5 M2. For a ZIP or OOXML file the verifier refused for what it carries
   * (`archive_contains_blocked`, `archive_nested`, `archive_encrypted`, `macro_office`): the
   * offending entry's path, at most 200 characters, so the uploader is told which one. Read again
   * from the quarantined object's directory when the answer is made (the name is content and is
   * stored nowhere); absent otherwise, and never in the client's projection.
   */
  readonly rejectedEntry?: string;
  /** 56-06 (R19-e). Who judged the latest version's bytes (`tmanage` | `provider` | `none`). */
  readonly scanSource: ScanSource;
  /** 56-06 (R19-e). The chip key the file row shows; the web translates it. */
  readonly safetyChip: SafetyChip;
  /**
   * FIX4 item 1b. Whether the file may be used now (attached, shown, listed): `ready`, or verified
   * and waiting for a scan under the owner's "Allow, marked Not scanned" — always the case when
   * no scanner is configured. A browser waits for this, not for `ready`.
   */
  readonly usable: boolean;
}

/** The client's projection of a file asset: everything but the security metadata. */
export type ClientFileAssetView = Omit<FileAssetView, 'rejectionCode' | 'rejectedEntry'>;

export function clientFileAssetView(view: FileAssetView): ClientFileAssetView {
  return {
    id: view.id,
    name: view.name,
    status: view.status,
    purpose: view.purpose,
    projectId: view.projectId,
    mimeType: view.mimeType,
    sizeBytes: view.sizeBytes,
    fileVersionId: view.fileVersionId,
    versionNo: view.versionNo,
    createdAt: view.createdAt,
    scanSource: view.scanSource,
    safetyChip: view.safetyChip,
    usable: view.usable,
  };
}

export interface CreateUploadInput extends ParsedUploadBody {
  readonly idempotencyKey: string;
}

/**
 * FILE-001b. The provider refusals a completion may answer, and what each does to the
 * session (decision 11). A part that is missing or whose etag does not match leaves the
 * upload intact at the provider — S3 keeps a multipart upload open on `InvalidPart`, and
 * the filesystem driver keeps its staging directory — so the session stays `reserved`: the
 * client re-sends the part and completes again, and one mistyped etag on a thirteen-part
 * upload does not cost twelve parts. An upload the provider no longer holds cannot be
 * finished by anything the client does, so that one fails the session and gives the bytes
 * back. `MultipartUploadMismatchError` and `UnsafeObjectPathError` are not here: both mean
 * this service named a zone or key it did not open, which is a bug, and a bug is a 500.
 * `ApiErrorCode` is closed, so the cause travels as `auditCode` and the caller sees one
 * 422 on `parts`.
 */
function completionRefusal(
  error: unknown,
): { message: string; auditCode: string; releases: boolean } | null {
  if (error instanceof MultipartUploadNotFoundError) {
    return {
      message: 'the provider no longer holds this upload',
      auditCode: 'upload_not_found',
      releases: true,
    };
  }
  if (error instanceof MissingPartError) {
    return {
      message: `part ${error.partNumber} was never uploaded`,
      auditCode: 'part_missing',
      releases: false,
    };
  }
  if (error instanceof PartEtagMismatchError) {
    return {
      message: `part ${error.partNumber} does not match the etag presented for it`,
      auditCode: 'part_etag_mismatch',
      releases: false,
    };
  }
  if (error instanceof SizeMismatchError) {
    // The provider refused before any object existed (security review, 2026-09-04). The
    // declaration is fixed on the row, so nothing the client re-sends can make the bytes
    // add up: the session fails and the bytes go back, as the post-completion size check
    // below already decided for a provider that reports rather than refuses.
    return {
      message: 'the uploaded size does not match the declared size',
      auditCode: 'size_mismatch',
      releases: true,
    };
  }
  return null;
}

function toView(row: UploadSessionRow, principal: Principal): UploadSessionView {
  return {
    id: row.id,
    fileAssetId: row.fileAssetId,
    projectId: row.projectId,
    purpose: row.purpose,
    status: row.status,
    fileName: row.declaredName,
    mimeType: row.declaredMimeType,
    sizeBytes: row.declaredBytes,
    partSizeBytes: row.partSizeBytes,
    partCount: row.partCount,
    // A claim still holds the bytes; only the part targets stop with it (below).
    reservedBytes: (OPEN_STATUSES as readonly string[]).includes(row.status)
      ? row.declaredBytes
      : 0,
    // Targets are served only while the session can still use them, and only to the person
    // who opened it. Against S3 a cancelled upload's URLs fail anyway; against a
    // token-authorized local transport they would not. And since FILE-001b a target is a
    // bearer credential for a write: the organization-wide list, which exists so an owner
    // can find and release a colleague's reservation, names the session and never its
    // targets (amended decision 7 — the wide scope may never read its parts).
    uploadUrls:
      row.status === 'reserved' && row.actorUserId === principal.userId
        ? row.uploadTargetsJson.map((t) => ({ partNumber: t.partNumber, url: t.url }))
        : [],
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toFileAssetView(
  asset: FileAssetRow,
  version: FileVersionRow,
  session: UploadSessionRow,
  usable: boolean = asset.status === 'ready',
): FileAssetView {
  return {
    id: asset.id,
    name: asset.name,
    status: asset.status,
    purpose: asset.purpose,
    projectId: asset.projectId,
    // The verifier's detected type once it has one (FILE-002 slice A); the declaration
    // only until then. A view never says a type the bytes' signature did not.
    mimeType: version.detectedMimeType ?? session.declaredMimeType,
    sizeBytes: version.sizeBytes,
    fileVersionId: version.id,
    versionNo: version.versionNo,
    createdAt: asset.createdAt.toISOString(),
    rejectionCode: asset.rejectionCode,
    scanSource: scanSourceOf(version),
    safetyChip: safetyChip(version),
    usable,
  };
}

/** 56-06. The stored source, or (a pre-0307 row) the resolver's answer from the scanner name. */
function scanSourceOf(version: FileVersionRow): ScanSource {
  const stored = version.scanSource;
  if (stored === 'tmanage' || stored === 'provider' || stored === 'none') return stored;
  return resolveScanSource({ scanner: version.scanner, storedAt: version.objectKey });
}

/** FIX6 C1. The provider handle of a session the server wrote itself: no multipart upload exists. */
export const SERVER_IMPORT_UPLOAD_ID = 'server-import';

/** FIX6 C1. A file the server fetched with the company's own connection. */
export interface ImportFetchedInput {
  readonly projectId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
  /** The deliverable the file is for, or `null` (a work item's file). */
  readonly objectId: string | null;
}

export interface ImportedFileView {
  readonly file: FileAssetView;
  /** The completed session, which the browser asks for the checks' outcome like an upload's. */
  readonly uploadSessionId: string;
}

interface Draft {
  readonly context: TenantContext;
  readonly principal: Principal;
  readonly clientOrganizationId: string | null;
  readonly audience: Audience;
  readonly input: CreateUploadInput;
}

/** FILE-003. What {@link FilesService.purge} did to one rejected object. */
export interface PurgeOutcome {
  /** `false` when the row had already been purged (a concurrent pass) — nothing was touched. */
  readonly purged: boolean;
  /** Meaningful only when purged. `false` is the counter drift the audit row records. */
  readonly counterMoved: boolean;
}

/** USAGE-001. What {@link FilesService.expire} did to one session. */
export interface ExpiryOutcome {
  /** `false` when the session had already left `reserved` — nothing was touched. */
  readonly released: boolean;
  /** Meaningful only when released. `false` is the counter drift the audit row records. */
  readonly counterMoved: boolean;
  /** The provider refused to abandon the upload; the reservation was released regardless. */
  readonly abortFailed: boolean;
}

export class FilesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly sessions: UploadSessionsRepository,
    private readonly assets: FileAssetsRepository,
    private readonly counters: UsageCountersRepository,
    private readonly ledger: UsageLedgerRepository | null,
    private readonly projects: ProjectsRepository,
    private readonly requests: ClientRequestsRepository,
    private readonly store: ObjectStore,
    private readonly config: ApiConfig,
    private readonly audit: AuditService | null,
    private readonly outbox: OutboxEventsRepository | null,
    /**
     * USAGE-001 slice 4. Re-evaluates the storage threshold band inside the reserve and commit
     * transactions — the two counter moves that can raise usage — and emits
     * `usage.threshold_reached.v1` on a rising crossing. Nullable for the same reason the outbox
     * beside it is: a copy built without it moves a counter across a threshold nobody is told of.
     */
    private readonly thresholds: UsageThresholdEvaluator | null,
    /** CQ-09. Asked for a verify-then-scan pass once an upload commits; absent = cron-driven. */
    private readonly scanJob: ScanRequester | null = null,
    /**
     * 56-06 (R19-e). The organization's file-safety settings (type presets, the plan's per-file
     * cap). Absent: the default presets and the configured upload ceiling — never no rule at all.
     */
    private readonly safety: FileSafetySettingsSource | null = null,
    private readonly dailyUploads: DailyUploadCountRepository = new DailyUploadCountRepository(),
    /** FIX4 item 1b. The configured scanner; absent reads as none (`allow_labeled`). */
    private readonly scanner?: ScannerPresence,
  ) {}

  // ── The studio's door ──────────────────────────────────────────────────────

  async create(
    context: TenantContext,
    principal: Principal,
    input: CreateUploadInput,
  ): Promise<UploadSessionView> {
    if (principal.kind !== 'internal') {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'not_an_internal_principal',
      );
    }
    return this.createSession({
      context,
      principal,
      clientOrganizationId: null,
      audience: input.audience,
      input,
    });
  }

  async get(
    context: TenantContext,
    principal: Principal,
    uploadSessionId: string,
  ): Promise<UploadSessionView> {
    if (principal.kind !== 'internal') {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'not_an_internal_principal',
      );
    }
    return toView(await this.readOr404(context, principal, uploadSessionId), principal);
  }

  /**
   * The caller's own sessions, or — `scope: 'organization'`, for a principal with
   * organization-wide scope — every session in the studio, which is how an owner finds the
   * reservation a leaver left behind. Anyone else asking for the wider scope is refused with
   * 403 rather than quietly given their own list, so a screen cannot mistake one for the other.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId?: string; readonly scope?: 'own' | 'organization' } = {},
  ): Promise<readonly UploadSessionView[]> {
    if (principal.kind !== 'internal') {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'not_an_internal_principal',
      );
    }
    const wide = options.scope === 'organization';
    if (wide && !principal.hasOrgWideScope) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'scope_not_org_wide');
    }
    const filters = { ...(options.projectId ? { projectId: options.projectId } : {}) };
    const rows = await this.database.read(context, (runner) =>
      this.sessions.list(
        runner,
        context,
        wide ? filters : { ...filters, actorUserId: principal.userId },
      ),
    );
    return rows
      .filter((row) => (wide ? this.mayRelease : this.mayUpload)(principal, row))
      .map((row) => toView(row, principal));
  }

  async complete(
    context: TenantContext,
    principal: Principal,
    uploadSessionId: string,
    parts: readonly ParsedPart[],
  ): Promise<FileAssetView> {
    if (principal.kind !== 'internal') {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'not_an_internal_principal',
      );
    }
    return this.completeSession(context, principal, uploadSessionId, parts);
  }

  async cancel(
    context: TenantContext,
    principal: Principal,
    uploadSessionId: string,
  ): Promise<UploadSessionView> {
    if (principal.kind !== 'internal') {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'not_an_internal_principal',
      );
    }
    return this.cancelSession(context, principal, uploadSessionId);
  }

  // ── The client's door ──────────────────────────────────────────────────────

  /**
   * A client uploads into their own request, and nowhere else. The audience is
   * `client_visible` by construction — `authorize()` rule 8 would refuse a client principal
   * on an internal-audience resource, and a client cannot put a file in the studio's private
   * space by asking for it. The request named by `objectId` must be theirs; a sibling
   * client's request answers 404, the same as one that does not exist.
   */
  async createForClient(
    context: TenantContext,
    principal: Principal,
    input: CreateUploadInput,
  ): Promise<UploadSessionView> {
    const clientOrganizationId = this.requireClient(principal);
    return this.createSession({
      context,
      principal,
      clientOrganizationId,
      audience: 'client_visible',
      input: { ...input, audience: 'client_visible' },
    });
  }

  async listForClient(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly UploadSessionView[]> {
    const clientOrganizationId = this.requireClient(principal);
    const rows = await this.database.read(context, (runner) =>
      this.sessions.list(runner, context, { clientOrganizationId, actorUserId: principal.userId }),
    );
    return rows
      .filter((row) => this.mayUpload(principal, row))
      .map((row) => toView(row, principal));
  }

  async completeForClient(
    context: TenantContext,
    principal: Principal,
    uploadSessionId: string,
    parts: readonly ParsedPart[],
  ): Promise<ClientFileAssetView> {
    this.requireClient(principal);
    return clientFileAssetView(
      await this.completeSession(context, principal, uploadSessionId, parts),
    );
  }

  async cancelForClient(
    context: TenantContext,
    principal: Principal,
    uploadSessionId: string,
  ): Promise<UploadSessionView> {
    this.requireClient(principal);
    return this.cancelSession(context, principal, uploadSessionId);
  }

  // ── The aggregate ──────────────────────────────────────────────────────────

  private async createSession(draft: Draft): Promise<UploadSessionView> {
    const { context, principal, input } = draft;

    if (!mayUploadFor(principal.kind, input.purpose)) {
      throw new ApiError(
        422,
        'validation_failed',
        'The request body is invalid',
        [{ field: 'purpose', message: `${input.purpose} is not an upload this account may make` }],
        'purpose_not_permitted',
      );
    }

    // 56-06: the one file-safety rule (`file-safety.ts`), before anything is reserved or opened.
    await this.requireFileSafety(context, draft);

    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, input.projectId),
    );
    if (!project || project.archivedAt !== null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const verdict = authorize({
      principal,
      capability: 'file.upload',
      resource: {
        organizationId: context.organizationId,
        projectId: input.projectId,
        audience: draft.audience,
        clientOrganizationId: draft.clientOrganizationId,
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, verdict.code);
    }

    await this.requireObject(context, draft, input);

    // A replay. The same person, the same key: the session they already have, and the
    // quota untouched. Somebody else's key is a conflict rather than their session.
    const existing = await this.database.read(context, (runner) =>
      this.sessions.findByIdempotencyKey(runner, context, input.idempotencyKey),
    );
    if (existing) return this.replay(existing, principal, input);

    // 56-06: a client user starts at most 20 uploads per UTC day (one COUNT). A replay above is
    // not a new upload, so it is answered before this.
    if (principal.kind === 'client') await this.requireDailyAllowance(context, draft);

    // The open-upload cap (security review 2026-09-04): the quota bounds the bytes, this
    // bounds the count. Read here so a person at the cap costs no provider upload; read
    // again inside the reservation, after the counter's row lock, so two requests arriving
    // together cannot both be the twentieth.
    const cap = this.config.uploadMaxOpenSessionsPerUser;
    const openBefore = await this.database.read(context, (runner) =>
      this.sessions.countOpenFor(runner, context, principal.userId),
    );
    if (openBefore >= cap) throw await this.refuseOpenUploads(context, draft, openBefore, cap);

    const id = this.sessions.nextId();
    const objectKey = uploadObjectKey({
      organizationId: context.organizationId,
      projectId: input.projectId,
      uploadId: id,
    });
    const partSizeBytes = this.config.uploadPartSizeBytes;
    const partCount = Math.max(1, Math.ceil(input.sizeBytes / partSizeBytes));
    const upload = await this.store.beginMultipart({
      zone: 'quarantine',
      objectKey,
      partCount,
      declaredBytes: input.sizeBytes,
      expiresInSeconds: this.config.uploadUrlTtlSeconds,
    });
    const expiresAt = new Date(Date.now() + this.config.uploadUrlTtlSeconds * 1_000);
    const limitBytes = this.storageLimitsFor();

    let created: UploadSessionRow;
    try {
      created = await this.database.transaction(context, async (tx) => {
        await this.counters.ensure(tx, context, STORAGE_BYTES_METRIC);
        const reserved = await this.counters.reserve(
          tx,
          context,
          STORAGE_BYTES_METRIC,
          input.sizeBytes,
          limitBytes,
        );
        if (!reserved) throw new QuotaExhausted();
        // Reversal: drop this second count and two simultaneous requests can both land
        // as the cap-th session; the sequential case above is what the suite can see.
        const open = await this.sessions.countOpenFor(tx, context, principal.userId);
        if (open >= cap) throw new TooManyOpenUploads(open);

        const asset = await this.assets.create(tx, context, {
          projectId: input.projectId,
          clientOrganizationId: draft.clientOrganizationId,
          ownerUserId: principal.userId,
          name: input.fileName,
          purpose: input.purpose,
          objectId: input.objectId,
          audience: draft.audience,
        });
        const row = await this.sessions.create(tx, context, {
          id,
          projectId: input.projectId,
          clientOrganizationId: draft.clientOrganizationId,
          actorUserId: principal.userId,
          fileAssetId: asset.id,
          idempotencyKey: input.idempotencyKey,
          purpose: input.purpose,
          objectId: input.objectId,
          declaredName: input.fileName,
          declaredMimeType: input.mimeType,
          declaredBytes: input.sizeBytes,
          declaredContentHash: input.contentHash,
          partSizeBytes,
          partCount,
          objectKey,
          providerUploadId: upload.providerUploadId,
          uploadTargets: upload.parts,
          expiresAt,
        });
        await this.recordReservation(tx, context, row.id, input.sizeBytes, limitBytes);
        return row;
      });
    } catch (error) {
      // Whatever refused, the provider upload opened above is not going to be used. The abort
      // is best-effort: the reservation has already rolled back, and a provider that refuses
      // to abandon the upload must not turn the refusal below into a 500 with no audit row.
      // An upload left open is what lifecycle-abort (50-BOOTSTRAP §4) exists for.
      try {
        await this.store.abortMultipart({
          zone: 'quarantine',
          objectKey,
          providerUploadId: upload.providerUploadId,
        });
      } catch (abortError) {
        // Swallowed for the caller — the original error is what they need — and recorded
        // for the operator: the provider holds an upload no row names, and until this row
        // nothing said which (security review 2026-09-04).
        await this.recordAbortFailure(context, draft, upload.providerUploadId, error, abortError);
      }
      if (error instanceof TooManyOpenUploads) {
        throw await this.refuseOpenUploads(context, draft, error.open, cap);
      }
      if (error instanceof QuotaExhausted)
        throw await this.quotaRefusal(context, draft, limitBytes);
      if (error instanceof UploadSessionKeyTakenError) {
        // Two requests with one key arrived together; the other won. Answer its session.
        const winner = await this.database.read(context, (runner) =>
          this.sessions.findByIdempotencyKey(runner, context, input.idempotencyKey),
        );
        if (winner) return this.replay(winner, principal, input);
      }
      throw error;
    }

    return toView(created, principal);
  }

  /**
   * The rows beside a reservation, in its transaction: the reserved event, its ledger row (a
   * counter move without one is impossible, USAGE-001 slice 2) and the band re-evaluation
   * (slice 4: a rising crossing emits one `usage.threshold_reached.v1`).
   */
  private async recordReservation(
    tx: TenantQueryRunner,
    context: TenantContext,
    uploadSessionId: string,
    sizeBytes: number,
    limitBytes: number,
  ): Promise<void> {
    const reservedEventId = await this.outbox?.append(tx, context, {
      type: 'usage.storage_reserved.v1',
      aggregateId: uploadSessionId,
      payload: { uploadSessionId, metricKey: STORAGE_BYTES_METRIC, deltaBytes: sizeBytes },
    });
    if (reservedEventId) {
      await this.ledger?.record(tx, context, {
        uploadSessionId,
        counter: 'reserved',
        deltaBytes: sizeBytes,
        reason: USAGE_LEDGER_REASON.reserve,
        sourceEventId: reservedEventId,
      });
    }
    await this.thresholds?.evaluate(tx, context, STORAGE_BYTES_METRIC, limitBytes);
  }

  /** The organization's storage is full: one refused row, and the 422 the browser explains. */
  private async quotaRefusal(
    context: TenantContext,
    draft: Draft,
    limitBytes: number,
  ): Promise<ApiError> {
    await this.recordRefusal(context, draft, {
      denial_code: 'storage_quota_exhausted',
      limit_bytes: limitBytes,
    });
    return new ApiError(
      422,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'sizeBytes', message: 'exceeds the storage available to this organization' }],
      'storage_quota_exhausted',
    );
  }

  // ── The server's import door (FIX6 C1) ─────────────────────────────────────

  /**
   * Before anything is fetched from a drive: the person may add a file to this project, and the
   * largest file the organization allows, which is the cap the download is read under.
   */
  async preflightImport(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<{ readonly maxBytes: number }> {
    await this.requireImportTarget(context, principal, projectId);
    const settings = this.safety ? await this.safety.read(context) : null;
    return { maxBytes: settings?.maxFileBytes ?? this.config.uploadMaxBytes };
  }

  /**
   * FIX6 C1. Bytes the server fetched itself (a picked Drive or OneDrive file) become a TManage
   * file by the upload's own path: the same file-safety rule, permission, quota reservation and
   * ledger, then the bytes written once into quarantine and the same commit as a completed upload,
   * so the verifier, the scanner and the preview pass treat the copy exactly as an upload. The
   * session is created and claimed in one transaction, so no cancel or sweep sees it half made.
   */
  async importFetched(
    context: TenantContext,
    principal: Principal,
    input: ImportFetchedInput,
  ): Promise<ImportedFileView> {
    const draft: Draft = {
      context,
      principal,
      clientOrganizationId: null,
      audience: 'internal',
      input: {
        projectId: input.projectId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.byteLength,
        contentHash: null,
        purpose: 'deliverable',
        objectId: input.objectId,
        audience: 'internal',
        idempotencyKey: `import-${randomUUID()}`,
      },
    };
    await this.requireImportTarget(context, principal, input.projectId);
    await this.requireFileSafety(context, draft);

    const id = this.sessions.nextId();
    const objectKey = uploadObjectKey({
      organizationId: context.organizationId,
      projectId: input.projectId,
      uploadId: id,
    });
    const sizeBytes = draft.input.sizeBytes;
    const limitBytes = this.storageLimitsFor();
    let session: UploadSessionRow;
    try {
      session = await this.writing(() =>
        this.database.transaction(context, async (tx) => {
          await this.counters.ensure(tx, context, STORAGE_BYTES_METRIC);
          const reserved = await this.counters.reserve(
            tx,
            context,
            STORAGE_BYTES_METRIC,
            sizeBytes,
            limitBytes,
          );
          if (!reserved) throw new QuotaExhausted();
          const asset = await this.assets.create(tx, context, {
            projectId: input.projectId,
            clientOrganizationId: null,
            ownerUserId: principal.userId,
            name: input.fileName,
            purpose: 'deliverable',
            objectId: input.objectId,
            audience: 'internal',
          });
          const row = await this.sessions.create(tx, context, {
            id,
            projectId: input.projectId,
            clientOrganizationId: null,
            actorUserId: principal.userId,
            fileAssetId: asset.id,
            idempotencyKey: draft.input.idempotencyKey,
            purpose: 'deliverable',
            objectId: input.objectId,
            declaredName: input.fileName,
            declaredMimeType: input.mimeType,
            declaredBytes: sizeBytes,
            declaredContentHash: null,
            partSizeBytes: this.config.uploadPartSizeBytes,
            partCount: 1,
            objectKey,
            providerUploadId: SERVER_IMPORT_UPLOAD_ID,
            uploadTargets: [],
            expiresAt: new Date(Date.now() + this.config.uploadUrlTtlSeconds * 1_000),
          });
          await this.recordReservation(tx, context, row.id, sizeBytes, limitBytes);
          await this.sessions.transition(tx, context, row.id, ['reserved'], 'completing');
          return row;
        }),
      );
    } catch (error) {
      if (error instanceof QuotaExhausted)
        throw await this.quotaRefusal(context, draft, limitBytes);
      throw error;
    }

    // Every exit settles the reservation: committed on success, given back otherwise.
    let settled = false;
    try {
      const stored = await this.store.putQuarantine({ objectKey, body: input.bytes });
      const result = await this.commitCompletion(context, session, stored);
      if (result === null) throw new Error('the import session left completing before its commit');
      settled = true;
      this.scanJob?.request();
      return {
        file: toFileAssetView(result.asset, result.version, session),
        uploadSessionId: session.id,
      };
    } finally {
      if (!settled) {
        await this.releaseInTransaction(context, session, 'failed', ['completing', 'reserved']);
      }
    }
  }

  /** The import door's gate: an internal person who may add files to this live project. */
  private async requireImportTarget(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    if (principal.kind !== 'internal') {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'not_an_internal_principal',
      );
    }
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project || project.archivedAt !== null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    const verdict = authorize({
      principal,
      capability: 'file.upload',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        clientOrganizationId: null,
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, verdict.code);
    }
  }

  private async completeSession(
    context: TenantContext,
    principal: Principal,
    uploadSessionId: string,
    parts: readonly ParsedPart[],
  ): Promise<FileAssetView> {
    const session = await this.readOr404(context, principal, uploadSessionId);

    if (session.status === 'completed') return this.completedView(context, session);
    if (session.status === 'completing') throw this.inFlight();
    if (session.status !== 'reserved') {
      throw this.illegal(`a ${session.status} upload cannot be completed`);
    }
    if (session.expiresAt.getTime() < Date.now()) {
      await this.releaseAs(context, session, 'expired');
      throw new ApiError(
        422,
        'validation_failed',
        'The request body is invalid',
        [{ field: 'parts', message: 'the upload session has expired' }],
        'session_expired',
      );
    }

    const numbers = new Set(parts.map((p) => p.partNumber));
    const complete =
      numbers.size === session.partCount &&
      parts.length === session.partCount &&
      [...numbers].every((n) => n >= 1 && n <= session.partCount);
    if (!complete) {
      throw new ApiError(
        422,
        'validation_failed',
        'The request body is invalid',
        [
          {
            field: 'parts',
            message: `must name each of the ${session.partCount} parts exactly once`,
          },
        ],
        'part_count_mismatch',
      );
    }

    // The claim (migration 0017): `reserved → completing` in its own short transaction,
    // before the provider is asked, so that for the whole provider call this request is
    // the one thing that can move the row. A cancel arriving now is refused (409) rather
    // than aborting an upload the provider is assembling; a sweep never selects the row;
    // a second completion of the same session finds the claim and is told to wait. Lost
    // the claim: somebody moved it first, and what they made is the answer.
    const claimed = await this.writing(() =>
      this.database.transaction(context, (tx) =>
        this.sessions.transition(tx, context, session.id, ['reserved'], 'completing'),
      ),
    );
    if (!claimed) {
      const fresh = await this.readOr404(context, principal, uploadSessionId);
      if (fresh.status === 'completed') return this.completedView(context, fresh);
      if (fresh.status === 'completing') throw this.inFlight();
      throw this.illegal(`a ${fresh.status} upload cannot be completed`);
    }

    // From here every exit settles the claim: `completed` on success, `failed` when the
    // provider has lost the upload or the size is wrong (the bytes go back), and back to
    // `reserved` for everything else — a part the client can re-send (FILE-001b decision
    // 11), a provider outage, a refused abort, a commit that did not go through. The
    // `finally` is what makes a claim never outlive its request; only a process that dies
    // mid-flight leaves one, and the sweeper's reclaim (`STALE_CLAIM_MS`) is for that.
    let settled = false;
    try {
      // §6 step 6: the provider's count, not the declaration. Outside any transaction —
      // no lock across the network call. A refusal the provider makes about the parts
      // themselves (FILE-001b) is answered as `completionRefusal` says: the upload stays
      // open for a part that is missing or mismatched, and fails only when the provider no
      // longer holds it.
      let stored: StoredObject;
      try {
        stored = await this.store.completeMultipart({
          zone: 'quarantine',
          objectKey: session.objectKey,
          providerUploadId: session.providerUploadId,
          parts: [...parts].sort((a, b) => a.partNumber - b.partNumber),
        });
      } catch (error) {
        const refusal = completionRefusal(error);
        if (!refusal) throw error;
        // The abort is best-effort here, as on the create path: the refusal below is the
        // answer, and a provider that will not abandon an upload it has already lost must
        // not turn it into a 500 with the bytes held. A refused abort is recorded, as the
        // create path records it, so the upload the provider still holds has a row naming it.
        if (refusal.releases) {
          settled = await this.releaseAs(context, session, 'failed', {
            abort: 'best-effort',
            from: ['completing'],
            refusal: error,
          });
        }
        throw new ApiError(
          422,
          'validation_failed',
          'The request body is invalid',
          [{ field: 'parts', message: refusal.message }],
          refusal.auditCode,
        );
      }
      if (stored.sizeBytes !== session.declaredBytes) {
        settled = await this.releaseAs(context, session, 'failed', { from: ['completing'] });
        throw new ApiError(
          422,
          'validation_failed',
          'The request body is invalid',
          [{ field: 'parts', message: 'the uploaded size does not match the declared size' }],
          'size_mismatch',
        );
      }

      const result = await this.commitCompletion(context, session, stored);
      settled = result !== null;
      if (result === null) {
        // Somebody else flipped it first. Answer what they made.
        const fresh = await this.readOr404(context, principal, uploadSessionId);
        if (fresh.status === 'completed') return this.completedView(context, fresh);
        throw this.illegal(`a ${fresh.status} upload cannot be completed`);
      }
      this.scanJob?.request();
      return toFileAssetView(result.asset, result.version, session);
    } finally {
      if (!settled) await this.unclaim(context, session);
    }
  }

  /**
   * The claim given back: `completing → reserved`, bumping `version`. For a completion
   * that ends without settling the row — the client can re-send a part, the provider was
   * down, the commit failed. `false` when the row had already left `completing`, which
   * only a reclaim (a stale claim the sweeper returned) can have done.
   */
  private unclaim(context: TenantContext, session: UploadSessionRow): Promise<boolean> {
    return this.writing(() =>
      this.database.transaction(context, (tx) =>
        this.sessions.transition(tx, context, session.id, ['completing'], 'reserved'),
      ),
    );
  }

  /**
   * USAGE-001 decision 12, the sweeper's other door: a claim a dead process left behind is
   * returned to `reserved`, from which every exit is the proven one. Nothing is released
   * here — the reservation stands until `expire` takes it on the same pass or the next, or
   * the opener completes or cancels it. Bound to its context as {@link expire} is.
   */
  async reclaim(context: TenantContext, session: UploadSessionRow): Promise<boolean> {
    if (session.organizationId !== context.organizationId) {
      throw new SessionOutsideContextError(session.id);
    }
    return this.unclaim(context, session);
  }

  /** The commit transaction of a completion: `completing → completed` and everything beside it. */
  private commitCompletion(
    context: TenantContext,
    session: UploadSessionRow,
    stored: StoredObject,
  ): Promise<{ asset: FileAssetRow; version: FileVersionRow } | null> {
    return this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const moved = await this.sessions.transition(
          tx,
          context,
          session.id,
          ['completing'],
          'completed',
          { committedBytes: stored.sizeBytes },
        );
        if (!moved) return null;

        const counterCommitted = await this.counters.commit(
          tx,
          context,
          STORAGE_BYTES_METRIC,
          session.declaredBytes,
          stored.sizeBytes,
        );
        await this.assets.transition(tx, context, session.fileAssetId, 'uploading');
        const asset = await this.assets.transition(tx, context, session.fileAssetId, 'uploaded', {
          byteSize: stored.sizeBytes,
        });
        const version = await this.assets.createVersion(tx, context, {
          fileAssetId: asset.id,
          objectKey: session.objectKey,
          sizeBytes: stored.sizeBytes,
          declaredMimeType: session.declaredMimeType,
          etag: stored.etag,
        });

        await this.audit?.record(tx, context, {
          action: 'file_asset.uploaded',
          objectId: asset.id,
          result: 'allowed',
          metadata: {
            project_id: asset.projectId,
            purpose: asset.purpose,
            size_bytes: version.sizeBytes,
            part_count: session.partCount,
            file_version_id: version.id,
            upload_session_id: session.id,
          },
        });
        await this.outbox?.append(tx, context, {
          type: 'upload.completed.v1',
          aggregateId: session.id,
          payload: {
            uploadSessionId: session.id,
            fileAssetId: asset.id,
            fileVersionId: version.id,
            projectId: asset.projectId,
            purpose: asset.purpose,
            objectId: asset.objectId,
            sizeBytes: version.sizeBytes,
          },
        });
        const committedEventId = await this.outbox?.append(tx, context, {
          type: 'usage.storage_committed.v1',
          aggregateId: session.id,
          payload: {
            uploadSessionId: session.id,
            fileVersionId: version.id,
            metricKey: STORAGE_BYTES_METRIC,
            deltaBytes: version.sizeBytes,
            reservedBytes: session.declaredBytes,
          },
        });
        // Completion is two counter moves: the reservation retired and the used bytes added
        // (the counter's `commit` UPDATE changes both columns). Each is its own ledger row,
        // both citing the one committed event, so summing `delta` per counter still holds.
        // Guarded on `counterCommitted` exactly as the release path guards on `counterMoved`:
        // a drifted reservation that refused the commit (`counterCommitted === false`) moved
        // neither column, so no ledger row is written and the per-counter sum still equals the
        // counter.
        if (committedEventId && counterCommitted) {
          await this.ledger?.record(tx, context, {
            uploadSessionId: session.id,
            counter: 'reserved',
            deltaBytes: -session.declaredBytes,
            reason: USAGE_LEDGER_REASON.commitRelease,
            sourceEventId: committedEventId,
          });
          await this.ledger?.record(tx, context, {
            uploadSessionId: session.id,
            counter: 'used',
            deltaBytes: version.sizeBytes,
            reason: USAGE_LEDGER_REASON.commit,
            sourceEventId: committedEventId,
          });
        }
        // Commit can raise used + reserved when the provider's count exceeds the declaration
        // (USAGE-001 slice 4, acceptance §2). Re-evaluate the band in the commit transaction.
        await this.thresholds?.evaluate(tx, context, STORAGE_BYTES_METRIC, this.storageLimitsFor());
        return { asset, version };
      }),
    );
  }

  /**
   * Cancel is the one move that is not the opener's alone: a principal with organization-wide
   * scope may release a reserved session anybody in the studio opened. Without that, five
   * abandoned reservations by one person — or a leaver's one — hold the studio's whole
   * allowance until an expiry sweep that does not exist yet, and nobody can give them back.
   */
  private async cancelSession(
    context: TenantContext,
    principal: Principal,
    uploadSessionId: string,
  ): Promise<UploadSessionView> {
    const session = await this.readOr404(context, principal, uploadSessionId, 'release');
    if (session.status === 'cancelled') return toView(session, principal);
    // A claim is refused here, before `releaseAs` can ask the provider to abandon an upload
    // a completion is assembling: the abort runs ahead of the status guard on that path.
    if (session.status === 'completing') throw this.inFlight();
    if (session.status !== 'reserved') {
      throw this.illegal(`a ${session.status} upload cannot be cancelled`);
    }
    const released = await this.releaseAs(context, session, 'cancelled');
    if (!released) {
      const fresh = await this.readOr404(context, principal, uploadSessionId, 'release');
      if (fresh.status === 'cancelled') return toView(fresh, principal);
      if (fresh.status === 'completing') throw this.inFlight();
      throw this.illegal(`a ${fresh.status} upload cannot be cancelled`);
    }
    return toView(await this.readOr404(context, principal, uploadSessionId, 'release'), principal);
  }

  /**
   * §6 step 7: the bytes go back and the provider upload is abandoned. The abort runs first:
   * if the provider refuses, the reservation stands and the caller may try again, which is
   * better than a released reservation over an upload the provider still holds open.
   * `best-effort` is for a completion the provider has already refused as lost, where a
   * failing abort must not hide the refusal — and is then recorded as
   * `upload_session.abort_failed`, as the create path records its own, because an upload
   * the provider holds that no row names is a fact only the log can carry. `from` is the
   * status the release leaves: `['reserved']` for a cancel and an expiry, `['completing']`
   * for a completion that fails after its claim. `false` when the session had already left
   * it.
   */
  private async releaseAs(
    context: TenantContext,
    session: UploadSessionRow,
    cause: 'cancelled' | 'expired' | 'failed',
    options: {
      readonly abort?: 'required' | 'best-effort';
      readonly from?: readonly UploadSessionStatus[];
      /** The provider's refusal the release answers, named on the audit row if the abort fails. */
      readonly refusal?: unknown;
    } = {},
  ): Promise<boolean> {
    const aborted = await this.abortUpload(session, options.abort ?? 'required');
    if (!aborted) await this.recordSessionAbortFailure(context, session, cause, options.refusal);
    return this.releaseInTransaction(context, session, cause, options.from ?? ['reserved']);
  }

  // ── The sweeper's door ─────────────────────────────────────────────────────

  /**
   * USAGE-001: expire one abandoned reservation — `49` §6 step 7 for a session nobody
   * completed or cancelled before `expires_at`. Called by `UploadSessionSweeper` under a
   * service context, never by a controller; the caller has already selected the row as
   * past the cutoff, and this method does not re-check the clock — the conditional
   * transition is the gate, so a session that `complete` claimed or finished, or that
   * `cancel` moved in the meantime, answers `released: false` and nothing else happens to
   * it. The abort runs before that gate; a claim never reaches here because the sweeper's
   * select does not return one, and the abort is the reason it must not.
   *
   * The abort is best-effort, as it is for a completion the provider already refused: the
   * reservation is what expiry exists to give back, and an upload the provider would not
   * abandon is what lifecycle-abort (`50-BOOTSTRAP` §4) exists for. Whether it failed is
   * recorded on the audit row rather than lost.
   *
   * One audit row per expired session, `actorUserId: null`, inside the release transaction
   * (§3 step 8) — see `'upload_session.expired'` in the catalog for why. The counter's
   * answer is captured there too: `counters.release` refuses when less than the declared
   * bytes is outstanding, which on this path means the counter drifted from the sessions
   * (a repaired or hand-edited row). Recorded as `counter_drift`, not thrown — a thrown
   * drift would leave every session of that organization un-expirable until someone found
   * it, and the reconciliation slice is what repairs the counter. USAGE-001 decision 3.
   */
  async expire(context: TenantContext, session: UploadSessionRow): Promise<ExpiryOutcome> {
    if (session.organizationId !== context.organizationId) {
      // The caller selected the row under this context, and the release below is bound to
      // it by the tenant guard; the abort above the transaction is not. One line, so a row
      // from anywhere else is refused before the provider hears of it (25 §6). Thrown,
      // so a pass counts it `failed` and names it.
      throw new SessionOutsideContextError(session.id);
    }
    const abortFailed = !(await this.abortUpload(session, 'best-effort'));
    let counterMoved = false;
    const released = await this.releaseInTransaction(
      context,
      session,
      'expired',
      ['reserved'],
      async (tx, facts) => {
        counterMoved = facts.counterMoved;
        await this.audit?.record(tx, context, {
          action: 'upload_session.expired',
          objectId: session.id,
          result: 'allowed',
          actorUserId: null,
          metadata: {
            project_id: session.projectId,
            purpose: session.purpose,
            declared_bytes: session.declaredBytes,
            expired_at: session.expiresAt.toISOString(),
            opened_by_user_id: session.actorUserId,
            counter_drift: !facts.counterMoved,
            abort_failed: abortFailed,
            // The handle the provider still holds, so the upload nobody names can be found.
            ...(abortFailed ? { provider_upload_id: session.providerUploadId } : {}),
          },
        });
      },
    );
    return { released, counterMoved, abortFailed };
  }

  /**
   * FILE-003 — purge one rejected/quarantined object: delete its provider bytes, then give the
   * counted bytes back. `49-PRICING` §6 step 8's order is the whole point of the method: the
   * provider delete is confirmed *before* the transaction that reduces usage, so a crash
   * between the two re-deletes an object already gone (idempotent) on the next pass and only
   * then reduces the counter, and a delete that fails reduces nothing (the caller records the
   * failure and the row waits — `purged_at` is still NULL).
   *
   * Called by `QuarantineCleanupJob` under a service context bound to the object's
   * organization. The provider delete names the `quarantine` zone: a rejected asset never
   * reached `private`, and {@link FileAssetsRepository.listPurgeable} returns only quarantine
   * versions, so this never removes a promoted object.
   *
   * The transaction claims the row (`purged_at`, conditional on it still being NULL — the
   * idempotency AC), decrements `used`, appends `file.purged.v1`, records the ledger row that
   * keeps the append-only sum equal to the decremented counter, and writes exactly one
   * `file_asset.purged` audit row (`actorUserId: null`, the system case). A drifted counter
   * that refused the decrement (`counterMoved === false`) records the drift on the audit row
   * and writes no ledger row, exactly as the expiry release does.
   */
  async purge(
    context: TenantContext,
    asset: FileAssetRow,
    version: FileVersionRow,
  ): Promise<PurgeOutcome> {
    if (asset.organizationId !== context.organizationId) {
      // The pass selected the row under this context; the delete below is bound to nothing
      // but the key, so a row from anywhere else is refused before the provider hears of it.
      throw new AssetOutsideContextError(asset.id);
    }
    // §6 step 8: provider deletion is confirmed first. Idempotent, so a re-run after a crash
    // between here and the transaction finds the object already gone and carries on.
    await this.store.remove({ zone: 'quarantine', objectKey: version.objectKey });

    let counterMoved = false;
    const purged = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const claimed = await this.assets.claimPurged(tx, context, asset);
        // Already purged by an earlier pass (or a concurrent one): nothing to reduce, and the
        // object is gone. Counted `skipped`, the counter untouched — the idempotency AC.
        if (!claimed) return false;

        counterMoved = await this.counters.releaseUsed(
          tx,
          context,
          STORAGE_BYTES_METRIC,
          version.sizeBytes,
        );
        const purgedEventId = await this.outbox?.append(tx, context, {
          type: 'file.purged.v1',
          aggregateId: asset.id,
          payload: {
            fileAssetId: asset.id,
            fileVersionId: version.id,
            projectId: asset.projectId,
            metricKey: STORAGE_BYTES_METRIC,
            deltaBytes: version.sizeBytes,
          },
        });
        // Only when the counter actually gave the bytes back: a drifted counter that refused
        // records no move, so the ledger records none either and its sum still equals the
        // counter. Keyed on the version — a purge and the session's own moves never collide.
        if (purgedEventId && counterMoved) {
          await this.ledger?.record(tx, context, {
            uploadSessionId: version.id,
            counter: 'used',
            deltaBytes: -version.sizeBytes,
            reason: USAGE_LEDGER_REASON.purged,
            sourceEventId: purgedEventId,
          });
        }
        await this.audit?.record(tx, context, {
          action: 'file_asset.purged',
          objectId: asset.id,
          result: 'allowed',
          actorUserId: null,
          metadata: {
            project_id: asset.projectId,
            file_version_id: version.id,
            purpose: asset.purpose,
            size_bytes: version.sizeBytes,
            // A fixed token, never the rejection_code or any detection name (AC3): the
            // rejection is already on `file_asset.rejected`, and this row is why the *bytes*
            // were removed — the retention window elapsed — not what the file was. The key is
            // `cause` (the codebase's classification-key convention, e.g. file-scanner/verifier):
            // `reason` is a forbidden audit-metadata segment (`assertSafeAuditMetadata`), so the
            // audit row would be refused and the whole purge would throw.
            cause: 'retention_expired',
            counter_drift: !counterMoved,
          },
        });
        return true;
      }),
    );
    return { purged, counterMoved };
  }

  /**
   * Ask the provider to abandon the upload. `true` when it did; `false` only in
   * `best-effort` mode, when it refused and the caller carries on regardless.
   */
  private async abortUpload(
    session: UploadSessionRow,
    abort: 'required' | 'best-effort',
  ): Promise<boolean> {
    try {
      await this.store.abortMultipart({
        zone: 'quarantine',
        objectKey: session.objectKey,
        providerUploadId: session.providerUploadId,
      });
      return true;
    } catch (error) {
      if (abort === 'required') throw error;
      // Deliberately swallowed: the caller is answering a refusal the provider already
      // made, or expiring a session nobody will finish, and an upload left open is what
      // lifecycle-abort (50-BOOTSTRAP §4) exists for.
      return false;
    }
  }

  /**
   * The release itself, in one transaction: the conditional status move out of `from`, the
   * counter, the asset, the event, and whatever the caller must record beside them. `false`
   * when the session had already left `from`, in which case nothing below the transition ran.
   */
  private releaseInTransaction(
    context: TenantContext,
    session: UploadSessionRow,
    cause: 'cancelled' | 'expired' | 'failed',
    from: readonly UploadSessionStatus[],
    then?: (tx: TenantQueryRunner, facts: { readonly counterMoved: boolean }) => Promise<void>,
  ): Promise<boolean> {
    return this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const moved = await this.sessions.transition(tx, context, session.id, from, cause);
        if (!moved) return false;
        const counterMoved = await this.counters.release(
          tx,
          context,
          STORAGE_BYTES_METRIC,
          session.declaredBytes,
        );
        await this.assets.transition(
          tx,
          context,
          session.fileAssetId,
          cause === 'expired' ? 'expired' : 'cancelled',
        );
        const releasedEventId = await this.outbox?.append(tx, context, {
          type: 'usage.storage_released.v1',
          aggregateId: session.id,
          payload: {
            uploadSessionId: session.id,
            metricKey: STORAGE_BYTES_METRIC,
            deltaBytes: session.declaredBytes,
            cause,
          },
        });
        // Only when the counter actually gave the bytes back: a drifted counter that refused
        // the release (`counterMoved === false`) recorded no move, so the ledger records none
        // either and its per-counter sum still equals the counter. `cause` is the reason, so a
        // release and this session's earlier reserve never share an idempotency key.
        if (releasedEventId && counterMoved) {
          await this.ledger?.record(tx, context, {
            uploadSessionId: session.id,
            counter: 'reserved',
            deltaBytes: -session.declaredBytes,
            reason: cause,
            sourceEventId: releasedEventId,
          });
        }
        await then?.(tx, { counterMoved });
        return true;
      }),
    );
  }

  private async completedView(
    context: TenantContext,
    session: UploadSessionRow,
  ): Promise<FileAssetView> {
    const found = await this.database.read(context, async (runner) => {
      const asset = await this.assets.findById(runner, context, session.fileAssetId);
      const version = await this.assets.findLatestVersion(runner, context, session.fileAssetId);
      if (!asset || !version) return null;
      // FIX4 item 1b: a verified file waiting for a scan is usable under "Allow, marked Not scanned".
      const usable =
        asset.status === 'ready' ||
        (asset.status === 'scanning' &&
          usableScanStatus(
            asset.status,
            version,
            await effectiveDownloadScanPolicyOn(runner, context, this.scanner),
          ) !== null);
      return { asset, version, usable };
    });
    if (!found) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const view = toFileAssetView(found.asset, found.version, session, found.usable);
    const entry = await this.rejectedEntryOf(found.asset, found.version, session);
    return entry === null ? view : { ...view, rejectedEntry: entry };
  }

  /**
   * FIX5 M2. The entry a member's refused ZIP was refused for, read again from the quarantined
   * object's directory (`archive-inspection.ts`). Only for the member door (the client's
   * projection drops it) and only for an archive refusal; `null` when the bytes are gone (purged)
   * or cannot be read — the reason token alone still answers.
   */
  private async rejectedEntryOf(
    asset: FileAssetRow,
    version: FileVersionRow,
    session: UploadSessionRow,
  ): Promise<string | null> {
    if (session.clientOrganizationId !== null) return null;
    if (asset.status !== 'rejected' || asset.purgedAt !== null) return null;
    const code = asset.rejectionCode;
    if (code === null || code === 'archive_unreadable' || !ARCHIVE_REJECTION_CODES.has(code)) {
      return null;
    }
    // Only an OOXML document earns `macro_office` here, so the code says which reading to repeat.
    const officeOpenXml = code === 'macro_office';
    try {
      const refusal = await inspectStoredArchive(
        this.store,
        { zone: 'quarantine', objectKey: version.objectKey, sizeBytes: version.sizeBytes },
        { channel: 'member', officeOpenXml },
      );
      return refusal?.entry ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A replay answers the session the key already made — when it is still the same upload.
   * The same key from another person, for another project, or for a session that has since
   * left `reserved` is a conflict: a 201 carrying `reservedBytes: 0` and the URLs of an
   * aborted upload is an answer nobody can act on, and a revoked project member must not be
   * handed a session on a project they can no longer see by re-sending a key they hold.
   */
  private replay(
    existing: UploadSessionRow,
    principal: Principal,
    input: CreateUploadInput,
  ): UploadSessionView {
    const conflict = (message: string) =>
      new ApiError(409, 'conflict', 'This idempotency key belongs to another upload', [
        { field: 'Idempotency-Key', message },
      ]);
    if (existing.actorUserId !== principal.userId) throw conflict('was used by a different person');
    if (existing.projectId !== input.projectId) throw conflict('was used for a different project');
    if (existing.status === 'completing') {
      // Not "use a new key": a second session for a file whose completion is in flight is
      // a second reservation and a second provider upload for the same bytes.
      throw conflict('was used by a session whose completion is in flight; wait for it');
    }
    if (existing.status !== 'reserved') {
      throw conflict(`was used by a session that is now ${existing.status}; use a new key`);
    }
    return toView(existing, principal);
  }

  /**
   * For a purpose that belongs to a row, `objectId` must name one this principal may attach
   * to — for everyone, not only a client: an attachment with no request is a file nothing
   * can ever show. 404 when the row is not theirs, indistinguishable from one that does not
   * exist; 422 when it is theirs and closed, because a declined or withdrawn request is not a
   * place to keep adding files, and each one would reserve against the studio's quota.
   */
  private async requireObject(
    context: TenantContext,
    draft: Draft,
    input: CreateUploadInput,
  ): Promise<void> {
    if (objectTableFor(input.purpose) !== 'client_requests') return;
    if (input.objectId === null) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'objectId', message: 'must name the request the file belongs to' },
      ]);
    }
    const request = await this.database.read(context, (runner) =>
      this.requests.findById(runner, context, input.objectId as string),
    );
    const ownIt =
      request !== null &&
      request.projectId === input.projectId &&
      (draft.clientOrganizationId === null ||
        request.clientOrganizationId === draft.clientOrganizationId);
    if (!ownIt) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    if (
      clientRequestStateMachine.definition.terminal.includes(request.state as ClientRequestState)
    ) {
      throw new ApiError(
        422,
        'validation_failed',
        'The request body is invalid',
        [{ field: 'objectId', message: `names a request that is ${request.state}` }],
        'request_closed',
      );
    }
  }

  /**
   * `upload_session.abort_failed`, `error`, no object id: the reservation was refused and
   * never became a row, and the provider still holds the upload opened for it. Its own
   * transaction, and best-effort itself — a refusal must not become a 500 for want of a
   * row about it. The handle is the one fact an operator needs to abort it by hand.
   */
  private async recordAbortFailure(
    context: TenantContext,
    draft: Draft,
    providerUploadId: string,
    refusal: unknown,
    failure: unknown,
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.database.transaction(context, (tx) =>
        this.audit!.record(tx, context, {
          action: 'upload_session.abort_failed',
          objectId: null,
          result: 'error',
          metadata: {
            provider_upload_id: providerUploadId,
            refusal: refusal instanceof Error ? refusal.name : typeof refusal,
            failure: failure instanceof Error ? failure.name : typeof failure,
            project_id: draft.input.projectId,
            declared_bytes: draft.input.sizeBytes,
            principal_kind: draft.principal.kind,
          },
        }),
      );
    } catch {
      // Reversal: let this throw and a provider outage turns the refusal into a 500.
    }
  }

  /**
   * The same row for a session that exists: the provider refused to abandon an upload a
   * release was giving back. `objectId` is the session, which is what an operator will
   * search by; the handle is still the metadata, because the row does not carry it.
   */
  private async recordSessionAbortFailure(
    context: TenantContext,
    session: UploadSessionRow,
    cause: 'cancelled' | 'expired' | 'failed',
    refusal: unknown,
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.database.transaction(context, (tx) =>
        this.audit!.record(tx, context, {
          action: 'upload_session.abort_failed',
          objectId: session.id,
          result: 'error',
          metadata: {
            provider_upload_id: session.providerUploadId,
            cause,
            refusal: refusal instanceof Error ? refusal.name : typeof refusal,
            project_id: session.projectId,
            declared_bytes: session.declaredBytes,
          },
        }),
      );
    } catch {
      // As above: the refusal being answered is the caller's answer, not this row.
    }
  }

  /** The open-upload cap's refusal: one audit row, one 429 that names no handle. */
  private async refuseOpenUploads(
    context: TenantContext,
    draft: Draft,
    open: number,
    cap: number,
  ): Promise<ApiError> {
    await this.recordRefusal(context, draft, {
      denial_code: 'too_many_open_uploads',
      open_sessions: open,
      limit_sessions: cap,
    });
    return new ApiError(
      429,
      'rate_limited',
      'Too many open uploads. Complete or cancel one and try again',
      undefined,
      'too_many_open_uploads',
    );
  }

  /**
   * `upload_session.refused`, `denied`, no object id: the session never became a row. The
   * facts the refusal turned on come from the caller; what every refusal shares is here.
   */
  private async recordRefusal(
    context: TenantContext,
    draft: Draft,
    facts: AuditMetadata,
  ): Promise<void> {
    if (!this.audit) return;
    // Its own transaction: the reservation's rolled back, and this row must not.
    await this.database.transaction(context, (tx) =>
      this.audit!.record(tx, context, {
        action: 'upload_session.refused',
        objectId: null,
        result: 'denied',
        metadata: {
          ...facts,
          declared_bytes: draft.input.sizeBytes,
          purpose: draft.input.purpose,
          project_id: draft.input.projectId,
          principal_kind: draft.principal.kind,
        },
      }),
    );
  }

  private async readOr404(
    context: TenantContext,
    principal: Principal,
    uploadSessionId: string,
    scope: 'own' | 'release' = 'own',
  ): Promise<UploadSessionRow> {
    const row = await this.database.read(context, (runner) =>
      this.sessions.findById(runner, context, uploadSessionId),
    );
    const may = scope === 'release' ? this.mayRelease : this.mayUpload;
    if (!row || !may(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  /**
   * The per-row rule, and it is stricter than `authorize()` alone: a session is read and
   * completed by the person who opened it. `list` passes the caller's own id and this
   * predicate would refuse anybody else's row regardless; finishing somebody else's upload
   * with parts they did not send is not a thing anybody has a reason to do.
   *
   * `lifecycle` is fixed at `active` on purpose. `authorize()` rule 6 allows an archived
   * resource only for reads and downloads, so the project's true lifecycle here would make a
   * session vanish (404) the moment its project was archived — unfinishable, uncancellable,
   * and its bytes held. `createSession` refuses to *open* a session on an archived project;
   * one opened before the archive may finish or be released.
   */
  private readonly mayUpload = (principal: Principal, row: UploadSessionRow): boolean => {
    if (row.actorUserId !== principal.userId) return false;
    return this.authorizedOn(principal, row);
  };

  /** The opener, or a principal with organization-wide scope — cancel and the wide list only. */
  private readonly mayRelease = (principal: Principal, row: UploadSessionRow): boolean => {
    if (this.mayUpload(principal, row)) return true;
    if (principal.kind !== 'internal' || !principal.hasOrgWideScope) return false;
    return this.authorizedOn(principal, row);
  };

  private authorizedOn(principal: Principal, row: UploadSessionRow): boolean {
    return authorize({
      principal,
      capability: 'file.upload',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: row.clientOrganizationId === null ? 'internal' : 'client_visible',
        clientOrganizationId: row.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
  }

  /**
   * 56-06 (R19-e). Classify the declared upload with the shared rule. A refusal is a 422
   * `file_not_allowed` whose one detail carries the reason token and nothing else — never which
   * magic or which name matched — and an `upload_session.refused` row records the token.
   */
  private async requireFileSafety(context: TenantContext, draft: Draft): Promise<void> {
    const { input, principal } = draft;
    const settings = this.safety ? await this.safety.read(context) : null;
    const result = classifyUpload({
      fileName: input.fileName,
      declaredType: input.mimeType,
      sizeBytes: input.sizeBytes,
      channel: principal.kind === 'client' ? 'client' : 'member',
      presets: settings?.presets ?? DEFAULT_PRESETS,
      maxBytes: settings?.maxFileBytes ?? this.config.uploadMaxBytes,
    });
    if (result.ok) return;
    await this.recordRefusal(context, draft, {
      denial_code: 'file_not_allowed',
      file_safety_code: result.reason,
    });
    throw new ApiError(
      422,
      'file_not_allowed',
      'This file cannot be uploaded',
      [{ field: 'reason', message: result.reason }],
      `file_not_allowed:${result.reason}`,
    );
  }

  /** 56-06 (R19-e). The client's daily upload allowance: the 21st start of a UTC day is a 429. */
  private async requireDailyAllowance(context: TenantContext, draft: Draft): Promise<void> {
    const started = await this.database.read(context, (runner) =>
      this.dailyUploads.countSince(
        runner,
        context,
        draft.principal.userId,
        startOfUtcDay(new Date()),
      ),
    );
    if (started < CLIENT_DAILY_UPLOAD_LIMIT) return;
    await this.recordRefusal(context, draft, {
      denial_code: 'daily_upload_limit',
      limit: CLIENT_DAILY_UPLOAD_LIMIT,
    });
    throw new ApiError(
      429,
      'daily_upload_limit',
      'You have reached the upload limit for today. Try again tomorrow',
      [{ field: 'limit', message: String(CLIENT_DAILY_UPLOAD_LIMIT) }],
      'daily_upload_limit',
    );
  }

  /**
   * The one seam ENT-001 replaces with an entitlement row (`49` §5's effective quota).
   * Named here because two comments elsewhere already send its implementer looking for it.
   */
  private storageLimitsFor(): number {
    return this.config.storageOrgBytesLimit;
  }

  private requireClient(principal: Principal): string {
    const clientOrganizationId = principal.clientOrganizationId;
    if (principal.kind !== 'client' || !clientOrganizationId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_a_client_principal');
    }
    return clientOrganizationId;
  }

  /**
   * A row under a claim: 409 `conflict`, the contract's "state" conflict, without a
   * `version` — the web client treats a 409 as a version conflict only when one is named.
   * Not the illegal-transition 422, because nothing is illegal: the caller is early.
   */
  private inFlight(): ApiError {
    return new ApiError(
      409,
      'conflict',
      'A completion of this upload is in flight',
      [{ field: 'status', message: 'the upload is being completed; wait for it to finish' }],
      'completion_in_flight',
    );
  }

  private illegal(message: string): ApiError {
    return new ApiError(
      422,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'status', message }],
      'illegal_transition',
    );
  }

  private async writing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof UploadSessionNotFoundError) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      if (error instanceof FileAssetTransitionError) {
        throw this.illegal(error.message);
      }
      throw error;
    }
  }
}

/** A row handed to the sweeper's door under a context bound to another organization. */
export class SessionOutsideContextError extends Error {
  constructor(readonly uploadSessionId: string) {
    super(`upload session ${uploadSessionId} does not belong to the organization in context`);
    this.name = 'SessionOutsideContextError';
  }
}

/** FILE-003: an asset handed to the purge under a context bound to another organization. */
export class AssetOutsideContextError extends Error {
  constructor(readonly fileAssetId: string) {
    super(`file asset ${fileAssetId} does not belong to the organization in context`);
    this.name = 'AssetOutsideContextError';
  }
}

/** Internal signal: the opener already holds the cap's worth of `reserved` sessions. */
class TooManyOpenUploads extends Error {
  constructor(readonly open: number) {
    super('too many open uploads');
    this.name = 'TooManyOpenUploads';
  }
}

/** Internal signal: the reservation statement changed no row. */
class QuotaExhausted extends Error {
  constructor() {
    super('quota exhausted');
    this.name = 'QuotaExhausted';
  }
}
