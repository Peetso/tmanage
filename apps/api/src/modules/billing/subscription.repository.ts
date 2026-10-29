import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { INTERNAL_ROLES, PLATFORM_SUPPORT_ROLE, uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, subscriptions } from '../../common/database/schema.js';
import type { SubscriptionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { SubscriptionStatus } from './plan-catalog.js';

/**
 * The subscriptions repository — Billing / module 19 (x177). One row per organization: the plan it
 * is on, that plan's status, and when the current period ends.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * usage-counters and org-objectives repositories honour it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    and the `TenantContext`; there is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link UpsertPlanInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/**
 * What {@link SubscriptionRepository.upsertPlan} writes. Note what is absent: `organizationId`. It
 * is taken from the context, so there is no field for a request body to populate and no code path
 * that could prefer one over the other.
 */
export interface UpsertPlanInput {
  readonly planId: string;
  readonly status: SubscriptionStatus;
}

export class SubscriptionRepository {
  /**
   * Read the organization's subscription within the acting tenant. `null` when the organization has
   * no row yet — the service reads that as the free/base tier, never as an error.
   *
   * No `find(organizationId)` without a context: on MySQL that would return another customer's row.
   */
  async find(runner: TenantQueryRunner, context: TenantContext): Promise<SubscriptionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, context.organizationId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * How many internal people the organization has: active memberships holding an internal role.
   * Clients are never counted — they are always free and never count as people on a flat plan.
   */
  async countInternalPeople(runner: TenantQueryRunner, context: TenantContext): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ people: sql<number>`count(*)` })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          inArray(memberships.role, [...INTERNAL_ROLES]),
          ne(memberships.role, PLATFORM_SUPPORT_ROLE), // PA-05 (SPEC §3.2): the hidden Support-mode role never shows here.
        ),
      );
    return Number(rows[0]?.people ?? 0);
  }

  /**
   * Upsert the organization's one subscription row to `input`, then read it back.
   *
   * One row per organization: the `uq_subscriptions_org` unique key on `organization_id` is the
   * upsert target, so a second change updates the one row rather than appending. The insert names a
   * fresh id and stamps both timestamps; the duplicate-key branch writes only the mutable columns
   * (`plan_id`, `status`, `updated_at`) and never `organization_id` (the `0074` trigger pins it) or
   * `created_at`. `current_period_end` is left untouched — a plan-change *request* does not move the
   * period; a provider does, in a later slice.
   */
  async upsertPlan(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertPlanInput,
  ): Promise<SubscriptionRow> {
    const db = tenantDrizzle(runner);
    await db
      .insert(subscriptions)
      .values({
        id: uuidv7(),
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        planId: input.planId,
        status: input.status,
        currentPeriodEnd: null,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          planId: input.planId,
          status: input.status,
          updatedAt: sql`current_timestamp(3)`,
        },
      });

    const row = await this.find(runner, context);
    // The upsert we just ran guarantees a row for this tenant; the predicate on both statements is
    // `organization_id`, so this read can only see the row we wrote.
    if (!row) {
      throw new Error('subscriptions upsert did not produce a row for the acting tenant');
    }
    return row;
  }
}
