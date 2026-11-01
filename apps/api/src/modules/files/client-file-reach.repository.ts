import { and, eq, inArray, or } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  attachmentVersions,
  clientProjections,
  deliverableVersions,
  fileAssets,
} from '../../common/database/schema.js';
import type { FileAssetRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

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
        ),
      )
      .limit(1);
    return rows[0] ?? null;
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
