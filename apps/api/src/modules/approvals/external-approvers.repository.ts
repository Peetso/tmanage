import { and, desc, eq, isNull } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { externalApprovers } from '../../common/database/schema.js';
import type { ExternalApproverRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 52-18 — the one file holding a driver handle for `external_approvers` (0320, TENANT).
 *
 * Every read and write is bound to `context.organizationId`: the member's own context on send and
 * list, the link's service context on the outsider's decision. A record is written once on send
 * and decided once — the decide UPDATE matches `decision IS NULL`, so a second decision is a no-op.
 */

export const MAX_LISTED_APPROVERS = 100;

export type NewExternalApprover = Omit<
  ExternalApproverRow,
  | 'decision'
  | 'decisionComment'
  | 'typedName'
  | 'emailVerified'
  | 'decidedAt'
  | 'decidedIpHash'
  | 'decidedUserAgent'
>;

export interface ExternalDecisionFacts {
  readonly decision: string;
  readonly comment: string | null;
  readonly typedName: string | null;
  readonly emailVerified: boolean;
  readonly decidedAt: Date;
  readonly ipHash: string | null;
  readonly userAgent: string | null;
}

export class ExternalApproversRepository {
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: NewExternalApprover,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(externalApprovers)
      .values({ ...row, organizationId: context.organizationId });
  }

  async findByLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    publicLinkId: string,
  ): Promise<ExternalApproverRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(externalApprovers)
      .where(
        and(
          eq(externalApprovers.organizationId, context.organizationId),
          eq(externalApprovers.publicLinkId, publicLinkId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listForVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableVersionId: string,
  ): Promise<readonly ExternalApproverRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(externalApprovers)
      .where(
        and(
          eq(externalApprovers.organizationId, context.organizationId),
          eq(externalApprovers.deliverableVersionId, deliverableVersionId),
        ),
      )
      .orderBy(desc(externalApprovers.requestedAt))
      .limit(MAX_LISTED_APPROVERS);
  }

  /** `true` when this call recorded the decision; `false` when one was already recorded. */
  async decide(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    facts: ExternalDecisionFacts,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(externalApprovers)
      .set({
        decision: facts.decision,
        decisionComment: facts.comment,
        typedName: facts.typedName,
        emailVerified: facts.emailVerified,
        decidedAt: facts.decidedAt,
        decidedIpHash: facts.ipHash,
        decidedUserAgent: facts.userAgent,
      })
      .where(
        and(
          eq(externalApprovers.organizationId, context.organizationId),
          eq(externalApprovers.id, id),
          isNull(externalApprovers.decision),
        ),
      );
    return result[0].affectedRows === 1;
  }
}
