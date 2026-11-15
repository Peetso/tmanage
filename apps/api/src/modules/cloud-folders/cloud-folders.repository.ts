import { and, asc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { cloudFolderImports, workItemCloudFolders } from '../../common/database/schema.js';
import type { CloudFolderImportRow, WorkItemCloudFolderRow } from '../../common/database/schema.js';
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

  /** FIX6 C3b. The checked copy already made of this drive item at this modified time, if any. */
  async findImport(
    runner: TenantQueryRunner,
    context: TenantContext,
    key: ImportKey,
  ): Promise<CloudFolderImportRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(cloudFolderImports)
      .where(
        and(
          eq(cloudFolderImports.organizationId, context.organizationId),
          eq(cloudFolderImports.projectId, key.projectId),
          eq(cloudFolderImports.provider, key.provider),
          eq(cloudFolderImports.externalItemId, key.externalItemId),
          eq(cloudFolderImports.modifiedTime, key.modifiedTime),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Remember the copy; a copy that was deleted since is replaced by the new one. */
  async recordImport(
    runner: TenantQueryRunner,
    context: TenantContext,
    key: ImportKey,
    input: { readonly cloudFolderId: string; readonly fileAssetId: string; readonly at: Date },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(cloudFolderImports)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        ...key,
        cloudFolderId: input.cloudFolderId,
        fileAssetId: input.fileAssetId,
        createdAt: input.at,
      })
      .onDuplicateKeyUpdate({
        set: {
          cloudFolderId: input.cloudFolderId,
          fileAssetId: input.fileAssetId,
          createdAt: input.at,
        },
      });
  }
}

export interface ImportKey {
  readonly projectId: string;
  readonly provider: 'google_drive' | 'onedrive';
  readonly externalItemId: string;
  readonly modifiedTime: string;
}
