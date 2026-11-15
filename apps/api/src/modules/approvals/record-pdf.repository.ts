import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  deliverables,
  fileVersions,
  memberships,
  organizations,
  projects,
  users,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { CertificateNames, SignedOriginal } from './record-pdf-documents.js';

/** 52-26 — a larger original is not merged into the signed copy (it stays bound by its hash). */
export const MAX_ORIGINAL_PDF_BYTES = 20 * 1024 * 1024;

/**
 * 52-19 — the display names an approval certificate prints beside the sealed ids. Read-only, and
 * every query is bound to the context's tenant: a membership of another organization never
 * resolves to a name here.
 */
export class RecordPdfRepository {
  async certificateNames(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly projectId: string;
      readonly deliverableId: string;
      readonly membershipIds: readonly string[];
    },
  ): Promise<CertificateNames> {
    const db = tenantDrizzle(runner);
    const organization = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    const project = await db
      .select({ name: projects.name })
      .from(projects)
      .where(
        and(eq(projects.organizationId, context.organizationId), eq(projects.id, input.projectId)),
      )
      .limit(1);
    const deliverable = await db
      .select({ title: deliverables.title })
      .from(deliverables)
      .where(
        and(
          eq(deliverables.organizationId, context.organizationId),
          eq(deliverables.id, input.deliverableId),
        ),
      )
      .limit(1);
    const approvers =
      input.membershipIds.length === 0
        ? []
        : await db
            .select({ id: memberships.id, name: users.displayName })
            .from(memberships)
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(
              and(
                eq(memberships.organizationId, context.organizationId),
                inArray(memberships.id, [...new Set(input.membershipIds)]),
              ),
            );
    return {
      organizationName: organization[0]?.name ?? '',
      projectName: project[0]?.name ?? '',
      deliverableTitle: deliverable[0]?.title ?? '',
      approvers: new Map(approvers.map((a) => [a.id, a.name])),
    };
  }

  /**
   * 52-26 — the signed file version, only when it is a PDF (by its detected type) that was
   * cleared into the private zone, has a content hash, and is within the size cap.
   */
  async signedOriginal(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileVersionId: string,
  ): Promise<SignedOriginal | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        objectKey: fileVersions.objectKey,
        sizeBytes: fileVersions.sizeBytes,
        sha256: fileVersions.contentHash,
        scanVerdict: fileVersions.scanVerdict,
      })
      .from(fileVersions)
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileVersions.id, fileVersionId),
          eq(fileVersions.trustZone, 'private'),
          eq(fileVersions.detectedMimeType, 'application/pdf'),
          isNotNull(fileVersions.contentHash),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined || row.sha256 === null || row.scanVerdict === 'infected') return null;
    if (row.sizeBytes <= 0 || row.sizeBytes > MAX_ORIGINAL_PDF_BYTES) return null;
    return { objectKey: row.objectKey, sizeBytes: row.sizeBytes, sha256: row.sha256 };
  }
}
