import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { deliverableVersions, fileReviewDecisions } from '../../common/database/schema.js';
import type { FileReviewDecisionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * R4 slice 11 (0269) — Approve / Request changes on the versions of a plain attachment.
 *
 * `AttachmentVersionsRepository`'s shape: `TenantContext` scopes every statement, no input carries
 * an `organizationId`, and the runner is a parameter. Append-only: there is no update and no
 * delete (the table's trigger refuses an UPDATE; the company erasure deletes by organization).
 */

export const FILE_REVIEW_DECISIONS = ['approved', 'changes_requested'] as const;
export type FileReviewDecision = (typeof FILE_REVIEW_DECISIONS)[number];

/** The most decisions one chain read returns. */
export const MAX_FILE_REVIEW_DECISIONS = 200;

export interface InsertFileReviewDecisionInput {
  readonly projectId: string;
  readonly rootFileAssetId: string;
  readonly fileAssetId: string;
  readonly fileVersionId: string | null;
  readonly decision: FileReviewDecision;
  readonly note: string | null;
  readonly decidedByMembershipId: string;
  readonly decidedByUserId: string;
  readonly principalKind: 'internal' | 'client';
  readonly clientOrganizationId: string | null;
}

export class FileReviewDecisionsRepository {
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsertFileReviewDecisionInput,
  ): Promise<FileReviewDecisionRow> {
    const row: FileReviewDecisionRow = {
      id: uuidv7(),
      organizationId: context.organizationId,
      projectId: input.projectId,
      rootFileAssetId: input.rootFileAssetId,
      fileAssetId: input.fileAssetId,
      fileVersionId: input.fileVersionId,
      decision: input.decision,
      note: input.note,
      decidedByMembershipId: input.decidedByMembershipId,
      decidedByUserId: input.decidedByUserId,
      principalKind: input.principalKind,
      clientOrganizationId: input.clientOrganizationId,
      createdAt: new Date(),
    };
    await tenantDrizzle(runner).insert(fileReviewDecisions).values(row);
    return row;
  }

  /** Every decision on one chain (all its versions), newest first. Bounded. */
  async listForRoot(
    runner: TenantQueryRunner,
    context: TenantContext,
    rootFileAssetId: string,
  ): Promise<readonly FileReviewDecisionRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(fileReviewDecisions)
      .where(
        and(
          eq(fileReviewDecisions.organizationId, context.organizationId),
          eq(fileReviewDecisions.rootFileAssetId, rootFileAssetId),
        ),
      )
      .orderBy(desc(fileReviewDecisions.createdAt), desc(fileReviewDecisions.id))
      .limit(MAX_FILE_REVIEW_DECISIONS);
  }

  /**
   * The deliverable version whose file this asset is, if any — such a version is decided through
   * its approval, never here. The newest one when a file was attached to more than one.
   */
  async deliverableVersionFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileAssetId: string,
  ): Promise<{ readonly id: string; readonly deliverableId: string } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ id: deliverableVersions.id, deliverableId: deliverableVersions.deliverableId })
      .from(deliverableVersions)
      .where(
        and(
          eq(deliverableVersions.organizationId, context.organizationId),
          eq(deliverableVersions.fileAssetId, fileAssetId),
        ),
      )
      .orderBy(desc(deliverableVersions.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }
}
