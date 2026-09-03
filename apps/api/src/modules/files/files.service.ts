import { authorize } from '@tmanage/domain';
import type { Audience, Principal } from '@tmanage/domain';
import { uploadObjectKey } from '@tmanage/storage';
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
import { mayUploadFor } from './purpose-policy.js';
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
 * client organization. `get` refuses with 404; `list` filters. Both are the same predicate.
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

/** 8 MiB parts: above S3's 5 MiB minimum, small enough that a retry is cheap. */
export const PART_SIZE_BYTES = 8 * 1024 * 1024;

function toView(row: UploadSessionRow): UploadSessionView {
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
    uploadUrls: row.uploadTargetsJson.map((t) => ({ partNumber: t.partNumber, url: t.url })),
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
    return toView(await this.readOr404(context, principal, uploadSessionId));
  }

  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId?: string } = {},
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
    const rows = await this.database.read(context, (runner) =>
      this.sessions.list(runner, context, { ...options, actorUserId: principal.userId }),
    );
    return rows.filter((row) => this.mayUpload(principal, row)).map(toView);
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
    return rows.filter((row) => this.mayUpload(principal, row)).map(toView);
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
    if (existing) return this.replay(existing, principal);

    const id = this.sessions.nextId();
    const objectKey = uploadObjectKey({
      organizationId: context.organizationId,
      projectId: input.projectId,
      uploadId: id,
    });
    const partCount = Math.max(1, Math.ceil(input.sizeBytes / PART_SIZE_BYTES));
    const upload = await this.store.beginMultipart({
      zone: 'quarantine',
      objectKey,
      partCount,
      expiresInSeconds: this.config.uploadUrlTtlSeconds,
    });
    const expiresAt = new Date(Date.now() + this.config.uploadUrlTtlSeconds * 1_000);
    const limitBytes = this.config.storageOrgBytesLimit;

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
          declaredName: input.fileName,
          declaredMimeType: input.mimeType,
          declaredBytes: input.sizeBytes,
          declaredContentHash: input.contentHash,
          partSizeBytes: PART_SIZE_BYTES,
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
      // Whatever refused, the provider upload opened above is not going to be used.
      await this.store.abortMultipart({
        zone: 'quarantine',
        objectKey,
        providerUploadId: upload.providerUploadId,
      });
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
        if (winner) return this.replay(winner, principal);
      }
      throw error;
    }

    return toView(created);
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
    // no lock across the network call.
    const stored: StoredObject = await this.store.completeMultipart({
      zone: 'quarantine',
      objectKey: session.objectKey,
      providerUploadId: session.providerUploadId,
      parts: [...parts].sort((a, b) => a.partNumber - b.partNumber),
    });
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

  private async cancelSession(
    context: TenantContext,
    principal: Principal,
    uploadSessionId: string,
  ): Promise<UploadSessionView> {
    const session = await this.readOr404(context, principal, uploadSessionId);
    if (session.status === 'cancelled') return toView(session);
    if (session.status !== 'reserved') {
      throw this.illegal(`a ${session.status} upload cannot be cancelled`);
    }
    const released = await this.releaseAs(context, session, 'cancelled');
    if (!released) {
      const fresh = await this.readOr404(context, principal, uploadSessionId);
      if (fresh.status === 'cancelled') return toView(fresh);
      throw this.illegal(`a ${fresh.status} upload cannot be cancelled`);
    }
    return toView(await this.readOr404(context, principal, uploadSessionId));
  }

  /**
   * §6 step 7: the bytes go back and the provider upload is abandoned. The abort runs first:
   * if the provider refuses, the reservation stands and the caller may try again, which is
   * better than a released reservation over an upload the provider still holds open.
   * `false` when the session had already left `reserved`.
   */
  private async releaseAs(
    context: TenantContext,
    session: UploadSessionRow,
    cause: 'cancelled' | 'expired' | 'failed',
  ): Promise<boolean> {
    await this.store.abortMultipart({
      zone: 'quarantine',
      objectKey: session.objectKey,
      providerUploadId: session.providerUploadId,
    });
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

  private replay(existing: UploadSessionRow, principal: Principal): UploadSessionView {
    if (existing.actorUserId !== principal.userId) {
      throw new ApiError(409, 'conflict', 'This idempotency key belongs to another upload', [
        { field: 'Idempotency-Key', message: 'was used by a different person' },
      ]);
    }
    return toView(existing);
  }

  /** `objectId` must name a row this principal may attach to. 404 when it does not. */
  private async requireObject(
    context: TenantContext,
    draft: Draft,
    input: CreateUploadInput,
  ): Promise<void> {
    if (input.purpose !== 'request_attachment') return;
    if (input.objectId === null) {
      if (draft.principal.kind === 'client') {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'objectId', message: 'must name the request the file belongs to' },
        ]);
      }
      return;
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
  ): Promise<UploadSessionRow> {
    const row = await this.database.read(context, (runner) =>
      this.sessions.findById(runner, context, uploadSessionId),
    );
    if (!row || !this.mayUpload(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  /**
   * The per-row rule, and it is stricter than `authorize()` alone: a session is completed or
   * cancelled by the person who opened it. An owner can see the studio's sessions in a list;
   * finishing somebody else's upload with parts they did not send is not a thing anybody has
   * a reason to do.
   */
  private mayUpload(principal: Principal, row: UploadSessionRow): boolean {
    if (row.actorUserId !== principal.userId) return false;
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
