import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { uploadStateMachine, uuidv7 } from '@tmanage/domain';
import type { Audience, UploadState } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { fileAssets, fileVersions } from '../../common/database/schema.js';
import type { FileAssetRow, FileVersionRow, UploadPurpose } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * File assets and their versions — the rows an upload produces.
 *
 * `23-ERD-AND-STATE-MACHINES` §10's lifecycle lives on `file_assets.status` and is driven
 * by `packages/domain`'s `uploadStateMachine`, which already knows that `uploading →
 * uploaded` requires a byte size. This repository asks the machine and writes the answer;
 * it does not restate the transitions. FILE-001 drives `created → uploading → uploaded` and
 * the two early exits; FILE-002's verification pass (`file-verifier.ts`) drives `uploaded →
 * verifying → scanning | rejected`. `ready` is still written by nothing: it needs a scan
 * verdict, and that is slice B's.
 *
 * ## The facts a move carries are written, not only checked
 *
 * `transition` hands `facts` to the machine — which is how `verifying → rejected` without a
 * `rejectionCode` is refused before any write — and then **projects** the facts that have a
 * column: `rejectionCode` to `file_assets.rejection_code`. An earlier revision passed the
 * facts to the machine and discarded them, so a rejection would have satisfied the guard
 * and left the column NULL (the FILE-002 fleet's finding).
 *
 * ## A version is written once, and its verdict once
 *
 * A version's identity, key, size, declared type, etag and number are immutable at the
 * engine (`trg_file_versions_immutable`, recreated in 0018); its `content_hash` and
 * `detected_mime_type` are NULL at creation and **write-once**: {@link recordVerification}
 * writes them conditionally on NULL, and the trigger refuses a second value even if that
 * condition is forgotten. `users.sql` grants the runtime credential INSERT and, since
 * FILE-002, UPDATE — the trigger is what keeps that grant to those two values.
 * "Replacement creates new file version" (§10) remains the only way the bytes behind an
 * asset ever change.
 */

export class FileAssetNotFoundError extends Error {
  constructor(readonly fileAssetId: string) {
    super(`File asset ${fileAssetId} was not found`);
    this.name = 'FileAssetNotFoundError';
  }
}

export class FileAssetTransitionError extends Error {
  constructor(
    readonly from: UploadState,
    readonly to: UploadState,
    detail: string,
  ) {
    super(detail);
    this.name = 'FileAssetTransitionError';
  }
}

export interface CreateFileAssetInput {
  readonly projectId: string;
  readonly clientOrganizationId: string | null;
  readonly ownerUserId: string;
  readonly name: string;
  readonly purpose: UploadPurpose;
  readonly objectId: string | null;
  readonly audience: Audience;
}

export interface CreateFileVersionInput {
  readonly fileAssetId: string;
  readonly objectKey: string;
  readonly sizeBytes: number;
  readonly declaredMimeType: string;
  readonly etag: string | null;
}

export class FileAssetsRepository {
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<FileAssetRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(fileAssets)
      .where(
        and(eq(fileAssets.organizationId, context.organizationId), eq(fileAssets.id, fileAssetId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<FileAssetRow> {
    const found = await this.findById(runner, context, fileAssetId);
    if (!found) throw new FileAssetNotFoundError(fileAssetId);
    return found;
  }

  /** At the machine's initial state, explicitly — the column has no DEFAULT to invent one. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateFileAssetInput,
  ): Promise<FileAssetRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(fileAssets)
      .values({
        id,
        organizationId: context.organizationId,
        projectId: input.projectId,
        clientOrganizationId: input.clientOrganizationId,
        ownerUserId: input.ownerUserId,
        name: input.name,
        purpose: input.purpose,
        objectId: input.objectId,
        audience: input.audience,
        status: uploadStateMachine.definition.initial,
        version: 1,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });
    return this.requireById(runner, context, id);
  }

  /**
   * Move an asset through §10, with the facts the move requires.
   *
   * The current state is read in the same unit of work and the machine is asked; an illegal
   * move, or a legal one arriving without its facts, is refused before any write. The write
   * re-states the current status, so a concurrent move loses rather than being applied to a
   * state the row has since left — the pass that loses sees `FileAssetTransitionError` with
   * "changed state concurrently", and counts it skipped. A fact with a column is written
   * with the move: `rejectionCode`, as a string, to `rejection_code`.
   */
  async transition(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
    to: UploadState,
    facts: Readonly<Record<string, unknown>> = {},
  ): Promise<FileAssetRow> {
    const current = await this.requireById(runner, context, fileAssetId);
    const from = current.status as UploadState;
    const verdict = uploadStateMachine.transition(from, to, facts);
    if (!verdict.ok) throw new FileAssetTransitionError(from, to, verdict.detail);

    const rejectionCode = facts['rejectionCode'];
    const result = await tenantDrizzle(runner)
      .update(fileAssets)
      .set({
        status: to,
        ...(typeof rejectionCode === 'string' ? { rejectionCode } : {}),
        version: sql`version + 1`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(fileAssets.organizationId, context.organizationId),
          eq(fileAssets.id, fileAssetId),
          eq(fileAssets.status, from),
        ),
      );
    if (result[0].affectedRows === 0) {
      throw new FileAssetTransitionError(from, to, 'the file changed state concurrently');
    }
    return this.requireById(runner, context, fileAssetId);
  }

  /**
   * FILE-002. The assets one verification pass should look at in this organization: every
   * `uploaded` one, and every `verifying` one that no pass has touched since `staleBefore` —
   * a pass that died mid-object. Oldest first, so a stuck row is never starved by new
   * arrivals; the index is `ix_file_assets_org_project_status`'s prefix.
   */
  async listAwaitingVerification(
    runner: TenantQueryRunner,
    context: TenantContext,
    staleBefore: Date,
    limit: number,
  ): Promise<readonly FileAssetRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(fileAssets)
      .where(
        and(
          eq(fileAssets.organizationId, context.organizationId),
          or(
            eq(fileAssets.status, 'uploaded'),
            and(eq(fileAssets.status, 'verifying'), lt(fileAssets.updatedAt, staleBefore)),
          ),
        ),
      )
      .orderBy(asc(fileAssets.updatedAt), asc(fileAssets.id))
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  /**
   * FILE-002's cross-tenant half: which organizations hold an asset a pass should look at.
   * Read through the bootstrap escape hatch with a reason naming this use, as the sweeper's
   * `organizationsHoldingExpired` is; one statement, and it reaches `file_assets` alone.
   */
  async organizationsAwaitingVerification(
    runner: BootstrapQueryRunner,
    staleBefore: Date,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: fileAssets.organizationId })
      .from(fileAssets)
      .where(
        or(
          eq(fileAssets.status, 'uploaded'),
          and(eq(fileAssets.status, 'verifying'), lt(fileAssets.updatedAt, staleBefore)),
        ),
      )
      .orderBy(asc(fileAssets.organizationId));
    return rows.map((row) => row.organizationId);
  }

  /**
   * FILE-002. Record what the pass read — the digest of the bytes and, when the signature
   * admitted the declared type, the detected type — on a version whose `content_hash` is
   * still NULL. `true` when this call wrote it; `false` when a verdict was already there, in
   * which case nothing changed and the caller compares what it read with what stands (an
   * equal digest is a redelivery; a different one is an object that changed under a sealed
   * version, and is an error, never a rewrite). The trigger recreated in 0018 refuses a
   * rewrite even if this condition is forgotten. On a rejection the digest is still
   * recorded — the bytes are evidence — and the detected type stays NULL.
   */
  async recordVerification(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileVersionId: string,
    facts: { readonly contentHash: string; readonly detectedMimeType: string | null },
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(fileVersions)
      .set({ contentHash: facts.contentHash, detectedMimeType: facts.detectedMimeType })
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileVersions.id, fileVersionId),
          isNull(fileVersions.contentHash),
        ),
      );
    return result[0].affectedRows === 1;
  }

  async findVersionById(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileVersionId: string,
  ): Promise<FileVersionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(fileVersions)
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileVersions.id, fileVersionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The asset's newest version, or null before its first completion. */
  async findLatestVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<FileVersionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(fileVersions)
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileVersions.fileAssetId, fileAssetId),
        ),
      )
      .orderBy(desc(fileVersions.versionNo))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Append the asset's next version. The number is allocated from the asset's own rows
   * inside the caller's transaction, and `uq_file_versions_org_asset_no` refuses a duplicate
   * if two completions ever reach here for one asset at once.
   */
  async createVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateFileVersionInput,
  ): Promise<FileVersionRow> {
    const [latest] = await tenantDrizzle(runner)
      .select({ max: sql<number | null>`max(${fileVersions.versionNo})` })
      .from(fileVersions)
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileVersions.fileAssetId, input.fileAssetId),
        ),
      );
    const versionNo = Number(latest?.max ?? 0) + 1;

    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(fileVersions)
      .values({
        id,
        organizationId: context.organizationId,
        fileAssetId: input.fileAssetId,
        versionNo,
        objectKey: input.objectKey,
        sizeBytes: input.sizeBytes,
        declaredMimeType: input.declaredMimeType,
        etag: input.etag,
        createdAt: sql`current_timestamp(3)`,
      });
    const row = await this.findVersionById(runner, context, id);
    if (!row) throw new FileAssetNotFoundError(input.fileAssetId);
    return row;
  }
}
