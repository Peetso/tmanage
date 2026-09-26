import { and, asc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { onboardingProgress } from '../../common/database/schema.js';
import type { OnboardingProgressRow, OnboardingTourStep } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * ON-10 guided-tour progress's data half — a membership's completed tour steps, and the idempotent
 * completion upsert.
 *
 * ## Progress is private to a membership
 *
 * Every read and the completion write are scoped by `membership_id = context.membershipId`, so one
 * member never sees or advances another's tour even inside the same tenant — the own-principal
 * substance. The controller never reads a membership id from input; the acting membership is always
 * the tenant context's.
 *
 * ## Completion is idempotent, forward-only
 *
 * A step is completed with INSERT alone (the credential holds no UPDATE or DELETE). Re-completing a
 * step the member already finished collides on `uq_onboarding_progress_step`; {@link complete} probes
 * first and returns the existing row rather than inserting a duplicate, so a re-complete is a no-op
 * that answers 200 with the same progress.
 */
export class OnboardingTourRepository {
  /** The acting membership's already-completed step for `step`, if any — the idempotency probe. */
  async findStep(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    step: OnboardingTourStep,
  ): Promise<OnboardingProgressRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(onboardingProgress)
      .where(
        and(
          eq(onboardingProgress.organizationId, context.organizationId),
          eq(onboardingProgress.membershipId, membershipId),
          eq(onboardingProgress.step, step),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Mark `step` complete for the acting membership, idempotently. If the member already completed it
   * the existing row is returned and nothing is written; otherwise one row is inserted. The id and
   * tenant come from here, never from input.
   */
  async complete(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    step: OnboardingTourStep,
  ): Promise<OnboardingProgressRow> {
    const existing = await this.findStep(runner, context, membershipId, step);
    if (existing) return existing;

    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(onboardingProgress)
      .values({
        id,
        organizationId: context.organizationId,
        membershipId,
        step,
        completedAt: sql`current_timestamp(3)`,
      });
    const row = await this.findStep(runner, context, membershipId, step);
    if (!row) throw new Error('onboarding_progress row vanished immediately after insert');
    return row;
  }

  /**
   * Every step the acting membership has completed in this tenant, in completion order with id
   * breaking ties for a total, deterministic order (the `ix_onboarding_progress_org_membership`
   * index's order).
   */
  async listForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly OnboardingProgressRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(onboardingProgress)
      .where(
        and(
          eq(onboardingProgress.organizationId, context.organizationId),
          eq(onboardingProgress.membershipId, membershipId),
        ),
      )
      .orderBy(asc(onboardingProgress.completedAt), asc(onboardingProgress.id));
  }
}
