import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  attachmentVersions,
  clientProjections,
  cloudFolderImports,
  deliverableVersions,
  fileAssets,
  workItemCloudFolders,
  workItems,
} from '../../common/database/schema.js';
import type { FileAssetRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { deliverableIsLive } from '../approvals/client-projections.repository.js';

/**
 * R4 slice 4 — the reads behind a client's reach to a deliverable file and to a version chain.
 *
 * Every statement names `organization_id` on every table it touches (tenant guard, enforce mode):
 * the joins are tenant-pair joins, never an id alone.
 */

/** A deliverable version that names this file and has been published (a projection exists). */
export interface PublishedDeliverableFile {
  readonly deliverableVersionId: string;
  readonly projectId: string;
}

/** The longest chain this reads. A chain is versions of one attachment; real ones are short. */
export const MAX_CHAIN_MEMBERS = 50;

export class ClientFileReachRepository {
  /**
   * The published deliverable version that names this file asset, if any. `deliverable_versions`
   * joined to `client_projections` on the version: an unpublished version has no projection and
   * answers nothing.
   */
  async publishedVersionNaming(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<PublishedDeliverableFile | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        deliverableVersionId: deliverableVersions.id,
        projectId: deliverableVersions.projectId,
      })
      .from(deliverableVersions)
      .innerJoin(
        clientProjections,
        and(
          eq(clientProjections.organizationId, deliverableVersions.organizationId),
          eq(clientProjections.deliverableVersionId, deliverableVersions.id),
        ),
      )
      .where(
        and(
          eq(deliverableVersions.organizationId, context.organizationId),
          eq(clientProjections.organizationId, context.organizationId),
          eq(deliverableVersions.fileAssetId, fileAssetId),
          // FIX6 item 8: a deleted deliverable's file is not client content any more.
          deliverableIsLive(runner),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * FIX6 C3b. The project of a client-visible work item whose still-attached drive folder this
   * checked copy was opened through, or null. `cloud_folder_imports` -> `work_item_cloud_folders`
   * (not removed) -> `work_items` (not deleted, audience `client_visible` or
   * `client_action_required`), all in the copy's own project.
   */
  async clientVisibleFolderProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    asset: Pick<FileAssetRow, 'id' | 'projectId'>,
  ): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ projectId: workItems.projectId })
      .from(cloudFolderImports)
      .innerJoin(
        workItemCloudFolders,
        and(
          eq(workItemCloudFolders.organizationId, cloudFolderImports.organizationId),
          eq(workItemCloudFolders.id, cloudFolderImports.cloudFolderId),
        ),
      )
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, workItemCloudFolders.organizationId),
          eq(workItems.id, workItemCloudFolders.workItemId),
        ),
      )
      .where(
        and(
          eq(cloudFolderImports.organizationId, context.organizationId),
          eq(workItemCloudFolders.organizationId, context.organizationId),
          eq(workItems.organizationId, context.organizationId),
          eq(cloudFolderImports.fileAssetId, asset.id),
          eq(cloudFolderImports.projectId, asset.projectId),
          eq(workItems.projectId, asset.projectId),
          isNull(workItemCloudFolders.removedAt),
          isNull(workItems.deletedAt),
          inArray(workItems.audience, ['client_visible', 'client_action_required']),
        ),
      )
      .limit(1);
    return rows[0]?.projectId ?? null;
  }

  /** Whether any version of this deliverable has been published to the client. */
  async deliverableIsPublished(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: clientProjections.id })
      .from(clientProjections)
      .where(
        and(
          eq(clientProjections.organizationId, context.organizationId),
          eq(clientProjections.deliverableId, deliverableId),
          deliverableIsLive(runner),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The other assets of the version chain this asset takes part in (as the root or as a later
   * version) — without the asset itself. Empty when it is in no chain.
   */
  async chainSiblings(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<readonly FileAssetRow[]> {
    const db = tenantDrizzle(runner);
    const link = await db
      .select({ rootFileAssetId: attachmentVersions.rootFileAssetId })
      .from(attachmentVersions)
      .where(
        and(
          eq(attachmentVersions.organizationId, context.organizationId),
          or(
            eq(attachmentVersions.fileAssetId, fileAssetId),
            eq(attachmentVersions.rootFileAssetId, fileAssetId),
          ),
        ),
      )
      .limit(1);
    const rootId = link[0]?.rootFileAssetId;
    if (!rootId) return [];
    const members = await db
      .select({ fileAssetId: attachmentVersions.fileAssetId })
      .from(attachmentVersions)
      .where(
        and(
          eq(attachmentVersions.organizationId, context.organizationId),
          eq(attachmentVersions.rootFileAssetId, rootId),
        ),
      )
      .limit(MAX_CHAIN_MEMBERS);
    const ids = [rootId, ...members.map((m) => m.fileAssetId)].filter((id) => id !== fileAssetId);
    if (ids.length === 0) return [];
    return db
      .select()
      .from(fileAssets)
      .where(
        and(eq(fileAssets.organizationId, context.organizationId), inArray(fileAssets.id, ids)),
      );
  }
}
