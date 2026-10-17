import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { billingPlanChangeRequests } from '../../common/database/schema.js';
import type { BillingPlanChangeRequestRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { PlanId } from './plan-catalog.js';

/**
 * Billing & entitlements (module 19, x284). The plan-change-requests repository — the data-access
 * layer behind the org-scoped plan-change requests, following the `billing_usage_alerts` repository
 * pattern (`25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6):
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreatePlanChangeRequestInput} has
 *    no `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * `targetPlanCode` is allowlist-validated and `effectiveOn` bounded (today-or-later) by the service's
 * controller before any method here is called. One pending request per organization is enforced by
 * the service's create transaction ({@link findPending}) and, at the engine, by the `0153`
 * `pending_guard` UNIQUE key (`pending_guard` is trigger-maintained by
 * `trg_billing_plan_change_requests_pending_guard`).
 */

/**
 * What the service creates. No `organizationId` (from the context), so a request body cannot choose
 * the tenant it writes into. `targetPlanCode` is already catalog-validated and `effectiveOn` bounded.
 */
export interface CreatePlanChangeRequestInput {
  readonly targetPlanCode: PlanId;
  /** An ISO-8601 calendar date (`YYYY-MM-DD`); today or later, checked by the caller. */
  readonly effectiveOn: string;
  readonly note: string | null;
  /** The person making the request — the service passes `context.userId`. */
  readonly createdBy: string;
}

export class PlanChangeRequestsRepository {
  /** List a tenant's requests, newest-first, within the acting tenant. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly BillingPlanChangeRequestRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(billingPlanChangeRequests)
      .where(eq(billingPlanChangeRequests.organizationId, context.organizationId))
      .orderBy(desc(billingPlanChangeRequests.createdAt));
  }

  /**
   * Fetch one request by id, within the acting tenant. No `findById(id)` without a context: on MySQL
   * that would return another customer's row. A cross-tenant id resolves to null here.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<BillingPlanChangeRequestRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(billingPlanChangeRequests)
      .where(
        and(
          eq(billingPlanChangeRequests.organizationId, context.organizationId),
          eq(billingPlanChangeRequests.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The acting tenant's pending request, if any — the one-pending-per-org guard reads this. */
  async findPending(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<BillingPlanChangeRequestRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(billingPlanChangeRequests)
      .where(
        and(
          eq(billingPlanChangeRequests.organizationId, context.organizationId),
          eq(billingPlanChangeRequests.status, 'pending'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a request. The id is generated here (UUIDv7). `organization_id` comes from the context,
   * never from `input`. `status` defaults to `pending`. The row is read back so the server-generated
   * timestamp is returned.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreatePlanChangeRequestInput,
  ): Promise<BillingPlanChangeRequestRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(billingPlanChangeRequests).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      targetPlanCode: input.targetPlanCode,
      effectiveOn: input.effectiveOn,
      note: input.note,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) throw new Error(`billing plan-change request ${id} vanished after insert`);
    return created;
  }

  /**
   * Cancel a request, within the acting tenant. Idempotent: the predicate matches only a `pending`
   * row, so re-cancelling an already-cancelled request writes nothing (and the identity trigger pins
   * every other column besides). Returns the fresh row.
   */
  async cancel(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<BillingPlanChangeRequestRow> {
    const db = tenantDrizzle(runner);
    await db
      .update(billingPlanChangeRequests)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(billingPlanChangeRequests.organizationId, context.organizationId),
          eq(billingPlanChangeRequests.id, id),
          eq(billingPlanChangeRequests.status, 'pending'),
        ),
      );

    const cancelled = await this.findById(runner, context, id);
    if (!cancelled) throw new Error(`billing plan-change request ${id} vanished after cancel`);
    return cancelled;
  }
}
