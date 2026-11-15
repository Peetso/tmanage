import { and, asc, eq, isNull } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItemCloudFolders } from '../../common/database/schema.js';
import type { WorkItemCloudFolderRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** A work item holds at most this many live folders. */
export const MAX_FOLDERS_PER_ITEM = 20;

export type NewCloudFolder = Omit<
  WorkItemCloudFolderRow,
  'organizationId' | 'removedAt' | 'removedByUserId'
>;

/**
 * FIX6 C3 — storage for `work_item_cloud_folders` (0346). Every statement carries the caller's
 * `organization_id`; a removed row (`removed_at` set) is never returned.
 */
export class CloudFoldersRepository {
  async listForItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<readonly WorkItemCloudFolderRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemCloudFolders)
      .where(
        and(
          eq(workItemCloudFolders.organizationId, context.organizationId),
          eq(workItemCloudFolders.workItemId, workItemId),
          isNull(workItemCloudFolders.removedAt),
        ),
      )
      .orderBy(asc(workItemCloudFolders.createdAt), asc(workItemCloudFolders.id))
      .limit(MAX_FOLDERS_PER_ITEM);
  }

  /** The live attachment `id` on `workItemId`, or null (unknown, removed, other item or tenant). */
  async findLive(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    id: string,
  ): Promise<WorkItemCloudFolderRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemCloudFolders)
      .where(
        and(
          eq(workItemCloudFolders.organizationId, context.organizationId),
          eq(workItemCloudFolders.workItemId, workItemId),
          eq(workItemCloudFolders.id, id),
          isNull(workItemCloudFolders.removedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: NewCloudFolder,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(workItemCloudFolders)
      .values({ ...row, organizationId: context.organizationId });
  }

  async markRemoved(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(workItemCloudFolders)
      .set({ removedAt: at, removedByUserId: context.userId })
      .where(
        and(
          eq(workItemCloudFolders.organizationId, context.organizationId),
          eq(workItemCloudFolders.id, id),
          isNull(workItemCloudFolders.removedAt),
        ),
      );
  }
}
