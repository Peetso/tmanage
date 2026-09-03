import { and, desc, eq, sql } from 'drizzle-orm';
import { uploadStateMachine, uuidv7 } from '@tmanage/domain';
import type { Audience, UploadState } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { fileAssets, fileVersions } from '../../common/database/schema.js';
import type { FileAssetRow, FileVersionRow, UploadPurpose } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * File assets and their versions — the rows an upload produces.
 *
 * `23-ERD-AND-STATE-MACHINES` §10's lifecycle lives on `file_assets.status` and is driven
 * by `packages/domain`'s `uploadStateMachine`, which already knows that `uploading →
 * uploaded` requires a byte size. This repository asks the machine and writes the answer;
 * it does not restate the transitions. FILE-001 drives `created → uploading → uploaded` and
 * the two early exits; nothing in this file can write `verifying`, `scanning`, `ready` or
 * `rejected`, because nothing in this slice has the facts those states require.
 *
 * A version is written once and never updated — `users.sql` grants INSERT only and 0015's
 * trigger refuses the UPDATE for every credential. "Replacement creates new file version"
 * (§10) is therefore the only way the bytes behind an asset ever change.
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
   * state the row has since left.
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

    const result = await tenantDrizzle(runner)
      .update(fileAssets)
      .set({
        status: to,
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
