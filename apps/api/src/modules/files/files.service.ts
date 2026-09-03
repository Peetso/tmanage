import { authorize, clientRequestStateMachine } from '@tmanage/domain';
import type { Audience, ClientRequestState, Principal } from '@tmanage/domain';
import {
  MissingPartError,
  MultipartUploadNotFoundError,
  PartEtagMismatchError,
  uploadObjectKey,
} from '@tmanage/storage';
import type { ObjectStore, StoredObject } from '@tmanage/storage';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  FileAssetRow,
  FileVersionRow,
  UploadPurpose,
  UploadSessionRow,
} from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import { FileAssetTransitionError, type FileAssetsRepository } from './file-assets.repository.js';
import {
  UploadSessionKeyTakenError,
  UploadSessionNotFoundError,
  type UploadSessionsRepository,
} from './upload-sessions.repository.js';
import { STORAGE_BYTES_METRIC, type UsageCountersRepository } from './usage-counters.repository.js';
import { mayUploadFor, objectTableFor } from './purpose-policy.js';
import type { ParsedPart, ParsedUploadBody } from './upload-input.js';

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
    reservedBytes: row.status === 'reserved' ? row.declaredBytes : 0,
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
): FileAssetView {
  return {
    id: asset.id,
    name: asset.name,
    status: asset.status,
    purpose: asset.purpose,
    projectId: asset.projectId,
    mimeType: session.declaredMimeType,
    sizeBytes: version.sizeBytes,
    fileVersionId: version.id,
    versionNo: version.versionNo,
    createdAt: asset.createdAt.toISOString(),
  };
}

interface Draft {
  readonly context: TenantContext;
  readonly principal: Principal;
  readonly clientOrganizationId: string | null;
  readonly audience: Audience;
  readonly input: CreateUploadInput;
}

export class FilesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly sessions: UploadSessionsRepository,
    private readonly assets: FileAssetsRepository,
    private readonly counters: UsageCountersRepository,
    private readonly projects: ProjectsRepository,
    private readonly requests: ClientRequestsRepository,
    private readonly store: ObjectStore,
    private readonly config: ApiConfig,
    private readonly audit: AuditService | null,
    private readonly outbox: OutboxEventsRepository | null,
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
  ): Promise<FileAssetView> {
    this.requireClient(principal);
    return this.completeSession(context, principal, uploadSessionId, parts);
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
        await this.outbox?.append(tx, context, {
          type: 'usage.storage_reserved.v1',
          aggregateId: row.id,
          payload: {
            uploadSessionId: row.id,
            metricKey: STORAGE_BYTES_METRIC,
            deltaBytes: input.sizeBytes,
          },
        });
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
      } catch {
        // Deliberately swallowed; the original error is what the caller needs.
      }
      if (error instanceof QuotaExhausted) {
        await this.recordRefusal(context, draft, limitBytes);
        throw new ApiError(
          422,
          'validation_failed',
          'The request body is invalid',
          [{ field: 'sizeBytes', message: 'exceeds the storage available to this organization' }],
          'storage_quota_exhausted',
        );
      }
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

  private async completeSession(
    context: TenantContext,
    principal: Principal,
    uploadSessionId: string,
    parts: readonly ParsedPart[],
  ): Promise<FileAssetView> {
    const session = await this.readOr404(context, principal, uploadSessionId);

    if (session.status === 'completed') return this.completedView(context, session);
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

    // §6 step 6: the provider's count, not the declaration. Outside the transaction —
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
      // not turn it into a 500 with the bytes held.
      if (refusal.releases) await this.releaseAs(context, session, 'failed', 'best-effort');
      throw new ApiError(
        422,
        'validation_failed',
        'The request body is invalid',
        [{ field: 'parts', message: refusal.message }],
        refusal.auditCode,
      );
    }
    if (stored.sizeBytes !== session.declaredBytes) {
      await this.releaseAs(context, session, 'failed');
      throw new ApiError(
        422,
        'validation_failed',
        'The request body is invalid',
        [{ field: 'parts', message: 'the uploaded size does not match the declared size' }],
        'size_mismatch',
      );
    }

    const result = await this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const moved = await this.sessions.transition(
          tx,
          context,
          session.id,
          ['reserved'],
          'completed',
          { committedBytes: stored.sizeBytes },
        );
        if (!moved) return null;

        await this.counters.commit(
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
        await this.outbox?.append(tx, context, {
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
        return { asset, version };
      }),
    );

    if (result === null) {
      // Somebody else flipped it first. Answer what they made.
      const fresh = await this.readOr404(context, principal, uploadSessionId);
      if (fresh.status === 'completed') return this.completedView(context, fresh);
      throw this.illegal(`a ${fresh.status} upload cannot be completed`);
    }
    return toFileAssetView(result.asset, result.version, session);
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
    if (session.status !== 'reserved') {
      throw this.illegal(`a ${session.status} upload cannot be cancelled`);
    }
    const released = await this.releaseAs(context, session, 'cancelled');
    if (!released) {
      const fresh = await this.readOr404(context, principal, uploadSessionId, 'release');
      if (fresh.status === 'cancelled') return toView(fresh, principal);
      throw this.illegal(`a ${fresh.status} upload cannot be cancelled`);
    }
    return toView(await this.readOr404(context, principal, uploadSessionId, 'release'), principal);
  }

  /**
   * §6 step 7: the bytes go back and the provider upload is abandoned. The abort runs first:
   * if the provider refuses, the reservation stands and the caller may try again, which is
   * better than a released reservation over an upload the provider still holds open.
   * `best-effort` is for a completion the provider has already refused as lost, where a
   * failing abort must not hide the refusal. `false` when the session had already left
   * `reserved`.
   */
  private async releaseAs(
    context: TenantContext,
    session: UploadSessionRow,
    cause: 'cancelled' | 'expired' | 'failed',
    abort: 'required' | 'best-effort' = 'required',
  ): Promise<boolean> {
    try {
      await this.store.abortMultipart({
        zone: 'quarantine',
        objectKey: session.objectKey,
        providerUploadId: session.providerUploadId,
      });
    } catch (error) {
      if (abort === 'required') throw error;
      // Deliberately swallowed: the caller is answering a refusal the provider already
      // made, and an upload left open is what lifecycle-abort (50-BOOTSTRAP §4) exists for.
    }
    return this.writing(() =>
      this.database.transaction(context, async (tx) => {
        const moved = await this.sessions.transition(tx, context, session.id, ['reserved'], cause);
        if (!moved) return false;
        await this.counters.release(tx, context, STORAGE_BYTES_METRIC, session.declaredBytes);
        await this.assets.transition(
          tx,
          context,
          session.fileAssetId,
          cause === 'expired' ? 'expired' : 'cancelled',
        );
        await this.outbox?.append(tx, context, {
          type: 'usage.storage_released.v1',
          aggregateId: session.id,
          payload: {
            uploadSessionId: session.id,
            metricKey: STORAGE_BYTES_METRIC,
            deltaBytes: session.declaredBytes,
            cause,
          },
        });
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
      return asset && version ? { asset, version } : null;
    });
    if (!found) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return toFileAssetView(found.asset, found.version, session);
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

  private async recordRefusal(
    context: TenantContext,
    draft: Draft,
    limitBytes: number,
  ): Promise<void> {
    if (!this.audit) return;
    // Its own transaction: the reservation's rolled back, and this row must not.
    await this.database.transaction(context, (tx) =>
      this.audit!.record(tx, context, {
        action: 'upload_session.refused',
        objectId: null,
        result: 'denied',
        metadata: {
          denial_code: 'storage_quota_exhausted',
          declared_bytes: draft.input.sizeBytes,
          limit_bytes: limitBytes,
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

/** Internal signal: the reservation statement changed no row. */
class QuotaExhausted extends Error {
  constructor() {
    super('quota exhausted');
    this.name = 'QuotaExhausted';
  }
}
