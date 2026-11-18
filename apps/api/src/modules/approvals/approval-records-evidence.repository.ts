import { and, desc, eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  approvalChainChecks,
  deliverableVersions,
  fileAssets,
  fileVersions,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { StoredVersion } from '../files/provider-objects.js';

/** The approved version's file, as the evidence bundle needs it. */
export interface EvidenceFile extends StoredVersion {
  readonly fileVersionId: string;
  readonly name: string;
  readonly versionNo: number;
  readonly sha256: string | null;
  readonly trustZone: string;
  readonly scanVerdict: string | null;
}

/** The newest verdict of the worker's nightly chain walk (0355) for this organization. */
export interface EvidenceChainCheck {
  readonly checkedAt: Date;
  readonly status: string;
  readonly records: number;
  readonly breakRecordNo: number | null;
  readonly breakReason: string | null;
}

/**
 * 52-19 — the reads of the approval evidence bundle. SELECT only, every query bound to the
 * context's tenant: another organization's version, file or verdict never resolves here.
 */
export class ApprovalEvidenceRepository {
  async approvedFile(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableVersionId: string,
  ): Promise<EvidenceFile | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        fileVersionId: fileVersions.id,
        organizationId: fileVersions.organizationId,
        objectKey: fileVersions.objectKey,
        sizeBytes: fileVersions.sizeBytes,
        sha256: fileVersions.contentHash,
        scanVerdict: fileVersions.scanVerdict,
        trustZone: fileVersions.trustZone,
        versionNo: fileVersions.versionNo,
        storageBackend: fileVersions.storageBackend,
        providerFileId: fileVersions.providerFileId,
        storageConnectionId: fileVersions.storageConnectionId,
        name: fileAssets.name,
      })
      .from(deliverableVersions)
      .innerJoin(
        fileVersions,
        and(
          eq(fileVersions.organizationId, deliverableVersions.organizationId),
          eq(fileVersions.id, deliverableVersions.fileVersionId),
        ),
      )
      .innerJoin(
        fileAssets,
        and(
          eq(fileAssets.organizationId, fileVersions.organizationId),
          eq(fileAssets.id, fileVersions.fileAssetId),
        ),
      )
      .where(
        and(
          eq(deliverableVersions.organizationId, context.organizationId),
          eq(deliverableVersions.id, deliverableVersionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async latestChainCheck(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<EvidenceChainCheck | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        checkedAt: approvalChainChecks.checkedAt,
        status: approvalChainChecks.status,
        records: approvalChainChecks.records,
        breakRecordNo: approvalChainChecks.breakRecordNo,
        breakReason: approvalChainChecks.breakReason,
      })
      .from(approvalChainChecks)
      .where(eq(approvalChainChecks.organizationId, context.organizationId))
      .orderBy(desc(approvalChainChecks.checkedAt))
      .limit(1);
    return rows[0] ?? null;
  }
}
