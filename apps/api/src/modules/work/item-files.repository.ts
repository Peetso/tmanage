import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { fileAssets, workItemFiles } from '../../common/database/schema.js';
import type { WorkItemFileRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** A link joined to the display name and upload status of the file it points at. */
export interface WorkItemFileListRow extends WorkItemFileRow {
  readonly fileName: string;
  /** The file asset's upload status (`23-ERD` §10), the service maps to a coarse availability. */
  readonly status: string;
}

/**
 * Work item ↔ file attachments — x205's storage half (Work module 7).
 *
 * Follows `WorkCommentsRepository`: `TenantContext` is the scoping parameter, no
 * `organizationId` on any input type (it comes from the context), and every read and write is
 * bound to `(organization_id, …)` so a caller in the wrong tenant sees nothing rather than a
 * leak. The repository holds no policy — the service decides who may attach, list or detach,
 * and the two composite foreign keys of migration 0086 are what make a cross-tenant
 * `work_item_id` OR `file_asset_id` a non-existent pair.
 *
 * A link is added, listed and removed — no update: re-parenting is delete-and-add, and the 0086
 * trigger refuses UPDATE for every credential besides.
 */

/** The largest attachment page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_WORK_ITEM_FILE_PAGE = 500;

export interface CreateWorkItemFileInput {
  readonly workItemId: string;
  readonly fileAssetId: string;
  readonly attachedByMembershipId: string;
}

export class WorkItemFilesRepository {
  /** One attachment, scoped to the tenant and its parent work item; `null` if absent. */
  async findLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    linkId: string,
  ): Promise<WorkItemFileRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemFiles)
      .where(
        and(
          eq(workItemFiles.organizationId, context.organizationId),
          eq(workItemFiles.workItemId, workItemId),
          eq(workItemFiles.id, linkId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The work item's attachments, created-at ascending then id, bounded to one page. Joined to
   * `file_assets` on the composite `(organization_id, id)` key — an inner join, so the tenant
   * scope holds on both sides and a link whose file has somehow gone is not listed. The join
   * predicate carries `organization_id` on both tables, so it cannot cross a tenant boundary.
   */
  async listForWorkItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    limit: number = MAX_WORK_ITEM_FILE_PAGE,
  ): Promise<readonly WorkItemFileListRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: workItemFiles.id,
        organizationId: workItemFiles.organizationId,
        workItemId: workItemFiles.workItemId,
        fileAssetId: workItemFiles.fileAssetId,
        attachedByMembershipId: workItemFiles.attachedByMembershipId,
        createdAt: workItemFiles.createdAt,
        fileName: fileAssets.name,
        status: fileAssets.status,
      })
      .from(workItemFiles)
      .innerJoin(
        fileAssets,
        and(
          eq(fileAssets.organizationId, workItemFiles.organizationId),
          eq(fileAssets.id, workItemFiles.fileAssetId),
        ),
      )
      .where(
        and(
          eq(workItemFiles.organizationId, context.organizationId),
          eq(workItemFiles.workItemId, workItemId),
        ),
      )
      .orderBy(asc(workItemFiles.createdAt), asc(workItemFiles.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_WORK_ITEM_FILE_PAGE));
    return rows;
  }

  /** The existing link for this (work item, file) pair, if any — the idempotent-attach guard. */
  async findByPair(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    fileAssetId: string,
  ): Promise<WorkItemFileRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemFiles)
      .where(
        and(
          eq(workItemFiles.organizationId, context.organizationId),
          eq(workItemFiles.workItemId, workItemId),
          eq(workItemFiles.fileAssetId, fileAssetId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Attach a file. The server timestamp is read back rather than reconstructed. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateWorkItemFileInput,
  ): Promise<WorkItemFileRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(workItemFiles)
      .values({
        id,
        organizationId: context.organizationId,
        workItemId: input.workItemId,
        fileAssetId: input.fileAssetId,
        attachedByMembershipId: input.attachedByMembershipId,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findLink(runner, context, input.workItemId, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('work item file attachment vanished immediately after insert');
    }
    return created;
  }

  /** Detach a file. Returns whether a row was removed, so the service can answer 404 for none. */
  async delete(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    linkId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(workItemFiles)
      .where(
        and(
          eq(workItemFiles.organizationId, context.organizationId),
          eq(workItemFiles.workItemId, workItemId),
          eq(workItemFiles.id, linkId),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
