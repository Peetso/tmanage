import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { fileAssets, fileVersions, memberships, users } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 56-06 (R44 L2) — the read behind the owner's Blocked files queue (`blocked-files.controller.ts`).
 * Tenant-scoped on every joined table; selects metadata only (never `object_key`).
 */

export interface BlockedFileRow {
  readonly id: string;
  readonly name: string;
  readonly rejectionCode: string | null;
  readonly updatedAt: Date;
  readonly declaredMimeType: string | null;
  readonly detectedMimeType: string | null;
  readonly sizeBytes: number | null;
  readonly uploaderName: string | null;
}

const LIST_LIMIT = 200;

/** Rejected, not yet purged, not soft-deleted, with the newest version and the uploader's name. */
export async function listBlockedFiles(
  runner: TenantQueryRunner,
  context: TenantContext,
): Promise<readonly BlockedFileRow[]> {
  const rows = await tenantDrizzle(runner)
    .select({
      id: fileAssets.id,
      name: fileAssets.name,
      rejectionCode: fileAssets.rejectionCode,
      updatedAt: fileAssets.updatedAt,
      declaredMimeType: fileVersions.declaredMimeType,
      detectedMimeType: fileVersions.detectedMimeType,
      sizeBytes: fileVersions.sizeBytes,
      uploaderName: users.displayName,
    })
    .from(fileAssets)
    .leftJoin(
      fileVersions,
      and(
        eq(fileVersions.organizationId, fileAssets.organizationId),
        eq(fileVersions.fileAssetId, fileAssets.id),
        eq(
          fileVersions.versionNo,
          sql`(select max(l.version_no) from file_versions l where l.organization_id = ${fileAssets.organizationId} and l.file_asset_id = ${fileAssets.id})`,
        ),
      ),
    )
    .leftJoin(
      memberships,
      and(
        eq(memberships.organizationId, fileAssets.organizationId),
        eq(memberships.userId, fileAssets.ownerUserId),
      ),
    )
    .leftJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(fileAssets.organizationId, context.organizationId),
        eq(fileAssets.status, 'rejected'),
        isNull(fileAssets.purgedAt),
        isNull(fileAssets.deletedAt),
      ),
    )
    .orderBy(desc(fileAssets.updatedAt), desc(fileAssets.id))
    .limit(LIST_LIMIT);
  return rows;
}
