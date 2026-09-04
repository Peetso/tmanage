import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { unwrapQueryError } from '../../common/database/query-error.js';
import { uploadSessions } from '../../common/database/schema.js';
import type {
  UploadPurpose,
  UploadSessionRow,
  UploadSessionStatus,
  UploadTargetJson,
} from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * Upload sessions — the reservation with its declaration attached (0015's header on why the
 * DBML's `storage_reservations` and `07-DATA-MODEL`'s `UploadSession` are one table here).
 *
 * The row is created with the counter reservation in one transaction and moves through
 * `reserved → completed | cancelled | expired | failed`. Every move is a conditional UPDATE
 * on the status it leaves, so the caller that flips the status is the one caller that then
 * touches the counter — which is how a double `complete` commits once and a cancel after a
 * completion releases nothing (`49` §7: "duplicate completion/release ... do not
 * double-count bytes").
 */

export class UploadSessionNotFoundError extends Error {
  constructor(readonly uploadSessionId: string) {
    super(`Upload session ${uploadSessionId} was not found`);
    this.name = 'UploadSessionNotFoundError';
  }
}

/** The tenant already holds a session under this `Idempotency-Key`. The caller re-reads it. */
export class UploadSessionKeyTakenError extends Error {
  constructor(readonly idempotencyKey: string) {
    super('An upload session already exists for this idempotency key');
    this.name = 'UploadSessionKeyTakenError';
  }
}

export interface CreateUploadSessionInput {
  readonly id: string;
  readonly projectId: string;
  readonly clientOrganizationId: string | null;
  readonly actorUserId: string;
  readonly fileAssetId: string;
  readonly idempotencyKey: string;
  readonly purpose: UploadPurpose;
  readonly objectId: string | null;
  readonly declaredName: string;
  readonly declaredMimeType: string;
  readonly declaredBytes: number;
  readonly declaredContentHash: string | null;
  readonly partSizeBytes: number;
  readonly partCount: number;
  readonly objectKey: string;
  readonly providerUploadId: string;
  readonly uploadTargets: readonly UploadTargetJson[];
  readonly expiresAt: Date;
}

export interface ListUploadSessionsOptions {
  readonly projectId?: string;
  /** Omitting this returns every client's sessions; a client's own read always passes theirs. */
  readonly clientOrganizationId?: string;
  readonly actorUserId?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function isDuplicateKey(error: unknown): boolean {
  const unwrapped = unwrapQueryError(error);
  if (typeof unwrapped !== 'object' || unwrapped === null) return false;
  const candidate = unwrapped as { code?: unknown; errno?: unknown };
  return candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062;
}

export class UploadSessionsRepository {
  /** Newest first. The per-row rule is the service's; this is the tenant predicate and the filters. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListUploadSessionsOptions = {},
  ): Promise<readonly UploadSessionRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const predicates = [eq(uploadSessions.organizationId, context.organizationId)];
    if (options.projectId) predicates.push(eq(uploadSessions.projectId, options.projectId));
    if (options.clientOrganizationId) {
      predicates.push(eq(uploadSessions.clientOrganizationId, options.clientOrganizationId));
    }
    if (options.actorUserId) predicates.push(eq(uploadSessions.actorUserId, options.actorUserId));
    return tenantDrizzle(runner)
      .select()
      .from(uploadSessions)
      .where(and(...predicates))
      .orderBy(desc(uploadSessions.id))
      .limit(limit);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    uploadSessionId: string,
  ): Promise<UploadSessionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.organizationId, context.organizationId),
          eq(uploadSessions.id, uploadSessionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * USAGE-001: the reservations the sweeper is for — still `reserved`, past the cutoff,
   * oldest first. The predicate is the full prefix of `ix_upload_sessions_org_status_expires`
   * (organization, status, expires_at), which is the index 0015 created for exactly this
   * read. `before` is the caller's clock, bound as a parameter rather than `NOW(3)`: the
   * session's `expires_at` was minted from the API host's clock and `complete` refuses
   * against that same clock, so the sweeper compares against it too — two clocks would
   * let the sweeper expire a session `complete` still accepted.
   */
  async listExpired(
    runner: TenantQueryRunner,
    context: TenantContext,
    before: Date,
    limit: number,
  ): Promise<readonly UploadSessionRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.organizationId, context.organizationId),
          eq(uploadSessions.status, 'reserved'),
          lt(uploadSessions.expiresAt, before),
        ),
      )
      .orderBy(asc(uploadSessions.expiresAt), asc(uploadSessions.id))
      .limit(Math.min(Math.max(limit, 1), MAX_PAGE_SIZE));
  }

  /**
   * USAGE-001's cross-tenant half: which organizations hold a `reserved` session past the
   * cutoff. The one read on this table with no tenant predicate, and therefore the one that
   * takes a `BootstrapQueryRunner` — the caller declares the reason and the allowlist, and
   * the escape hatch refuses anything but a select on `upload_sessions`. A `select
   * distinct` over the same index {@link listExpired} uses.
   */
  async organizationsHoldingExpired(
    runner: BootstrapQueryRunner,
    before: Date,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: uploadSessions.organizationId })
      .from(uploadSessions)
      .where(and(eq(uploadSessions.status, 'reserved'), lt(uploadSessions.expiresAt, before)))
      .orderBy(asc(uploadSessions.organizationId));
    return rows.map((row) => row.organizationId);
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    uploadSessionId: string,
  ): Promise<UploadSessionRow> {
    const found = await this.findById(runner, context, uploadSessionId);
    if (!found) throw new UploadSessionNotFoundError(uploadSessionId);
    return found;
  }

  async findByIdempotencyKey(
    runner: TenantQueryRunner,
    context: TenantContext,
    idempotencyKey: string,
  ): Promise<UploadSessionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.organizationId, context.organizationId),
          eq(uploadSessions.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Insert the session at `reserved`. `id` is the caller's, because the object key was built
   * from it before the provider was asked and the row must record the key the provider was
   * given. A duplicate `Idempotency-Key` is refused as {@link UploadSessionKeyTakenError};
   * since the caller runs this in the same transaction as the counter reservation, the
   * rollback that follows also undoes the reservation, which is the property a replay needs.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateUploadSessionInput,
  ): Promise<UploadSessionRow> {
    try {
      await tenantDrizzle(runner)
        .insert(uploadSessions)
        .values({
          id: input.id,
          organizationId: context.organizationId,
          projectId: input.projectId,
          clientOrganizationId: input.clientOrganizationId,
          actorUserId: input.actorUserId,
          fileAssetId: input.fileAssetId,
          idempotencyKey: input.idempotencyKey,
          purpose: input.purpose,
          objectId: input.objectId,
          declaredName: input.declaredName,
          declaredMimeType: input.declaredMimeType,
          declaredBytes: input.declaredBytes,
          declaredContentHash: input.declaredContentHash,
          partSizeBytes: input.partSizeBytes,
          partCount: input.partCount,
          objectKey: input.objectKey,
          providerUploadId: input.providerUploadId,
          uploadTargetsJson: input.uploadTargets,
          status: 'reserved',
          version: 1,
          expiresAt: input.expiresAt,
          createdAt: sql`current_timestamp(3)`,
          updatedAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (isDuplicateKey(error)) throw new UploadSessionKeyTakenError(input.idempotencyKey);
      throw error;
    }
    return this.requireById(runner, context, input.id);
  }

  /**
   * Move the session out of one of `from`, into `to`. `true` when this call made the move;
   * `false` when the row was already elsewhere — the caller then reads the row and answers
   * from what it finds rather than repeating a side effect.
   */
  async transition(
    runner: TenantQueryRunner,
    context: TenantContext,
    uploadSessionId: string,
    from: readonly UploadSessionStatus[],
    to: UploadSessionStatus,
    facts: { readonly committedBytes?: number } = {},
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(uploadSessions)
      .set({
        status: to,
        version: sql`version + 1`,
        updatedAt: sql`current_timestamp(3)`,
        ...(facts.committedBytes === undefined ? {} : { committedBytes: facts.committedBytes }),
        ...(to === 'completed' ? { completedAt: sql`current_timestamp(3)` } : {}),
      })
      .where(
        and(
          eq(uploadSessions.organizationId, context.organizationId),
          eq(uploadSessions.id, uploadSessionId),
          inArray(uploadSessions.status, [...from]),
        ),
      );
    return result[0].affectedRows === 1;
  }

  /** The id a session will get. Exposed so the key can be built before the row exists. */
  nextId(): string {
    return uuidv7();
  }
}
