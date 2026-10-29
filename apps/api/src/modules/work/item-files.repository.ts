import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { RESTORE_VALUES, softDeleteValues } from '../../common/database/content-retention.js';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { fileAssets, workItemFiles } from '../../common/database/schema.js';
import type { WorkItemFileRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** A link joined to the display name and upload status of the file it points at. */
export interface WorkItemFileListRow extends WorkItemFileRow {
  readonly fileName: string;
  /** The file asset's upload status (`23-ERD` §10), the service maps to a coarse availability. */
  readonly status: string;
  /**
   * F50: the project the file asset belongs to. A link is only listed while this equals the work
   * item's current project — a file left behind by a move stays in its own project's boundary.
   */
  readonly fileProjectId: string;
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
    projectId?: string,
  ): Promise<readonly WorkItemFileListRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: workItemFiles.id,
        organizationId: workItemFiles.organizationId,
        workItemId: workItemFiles.workItemId,
        fileAssetId: workItemFiles.fileAssetId,
        attachedByMembershipId: workItemFiles.attachedByMembershipId,
        createdAt: workItemFiles.createdAt,
        deletedAt: workItemFiles.deletedAt,
        deletedByUserId: workItemFiles.deletedByUserId,
        deletedReason: workItemFiles.deletedReason,
        purgeAfter: workItemFiles.purgeAfter,
        fileName: fileAssets.name,
        status: fileAssets.status,
        fileProjectId: fileAssets.projectId,
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
          // PA-03 (0245): a detached (soft-deleted) link is not listed.
          isNull(workItemFiles.deletedAt),
          // F50: only files of the work item's current project.
          ...(projectId === undefined ? [] : [eq(fileAssets.projectId, projectId)]),
        ),
      )
      .orderBy(asc(workItemFiles.createdAt), asc(workItemFiles.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_WORK_ITEM_FILE_PAGE));
    return rows;
  }

  /**
   * The existing live link for this (work item, file) pair, if any — the idempotent-attach guard.
   * PA-03: a detached (soft-deleted) link is not "already attached"; {@link create} revives it.
   */
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
          isNull(workItemFiles.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Attach a file. The server timestamp is read back rather than reconstructed. PA-03: when the
   * pair was detached earlier (soft-deleted, still inside its restore window) the unique edge key
   * still holds that row, so the attach revives it instead of inserting a duplicate.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateWorkItemFileInput,
  ): Promise<WorkItemFileRow> {
    const detached = await tenantDrizzle(runner)
      .select({ id: workItemFiles.id })
      .from(workItemFiles)
      .where(
        and(
          eq(workItemFiles.organizationId, context.organizationId),
          eq(workItemFiles.workItemId, input.workItemId),
          eq(workItemFiles.fileAssetId, input.fileAssetId),
          isNotNull(workItemFiles.deletedAt),
        ),
      )
      .limit(1);
    const revived = detached[0];
    if (revived) {
      await tenantDrizzle(runner)
        .update(workItemFiles)
        .set(RESTORE_VALUES)
        .where(
          and(
            eq(workItemFiles.organizationId, context.organizationId),
            eq(workItemFiles.id, revived.id),
          ),
        );
      const row = await this.findLink(runner, context, input.workItemId, revived.id);
      if (!row) throw new Error('work item file attachment vanished immediately after restore');
      return row;
    }

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

  /**
   * F50: detach every attachment of a work item whose file asset is NOT in `projectId`. Called
   * inside the work-item move transaction, so a file that stays in the source project is no longer
   * reachable through the moved item. Two statements, both tenant-scoped: the ids are selected
   * first (the join carries `organization_id` on both tables), then deleted by id. Returns how many
   * links were removed.
   */
  async detachOutsideProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    projectId: string,
  ): Promise<number> {
    const db = tenantDrizzle(runner);
    const stale = await db
      .select({ id: workItemFiles.id })
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
          ne(fileAssets.projectId, projectId),
        ),
      );
    if (stale.length === 0) return 0;
    const result = await db.delete(workItemFiles).where(
      and(
        eq(workItemFiles.organizationId, context.organizationId),
        eq(workItemFiles.workItemId, workItemId),
        inArray(
          workItemFiles.id,
          stale.map((row) => row.id),
        ),
      ),
    );
    return result[0].affectedRows;
  }

  /**
   * Detach a file. Returns whether a live link was detached, so the service can answer 404 for
   * none. PA-03 (0245): a soft delete — the link keeps its row with who, why and `purge_after`,
   * leaves the list at once and is purged by the worker after the restore window.
   */
  async delete(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    linkId: string,
    reason: string | null = null,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(workItemFiles)
      .set(await softDeleteValues(runner, context.userId, reason))
      .where(
        and(
          eq(workItemFiles.organizationId, context.organizationId),
          eq(workItemFiles.workItemId, workItemId),
          eq(workItemFiles.id, linkId),
          isNull(workItemFiles.deletedAt),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
