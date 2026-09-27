import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { billingCredits } from '../../common/database/schema.js';
import type { BillingCreditRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Billing & entitlements (module 19, x226). The credits repository — the data-access layer behind the
 * manual credit / adjustment ledger, following the `billing_usage_alerts` repository pattern
 * (`25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6):
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for the
 *    current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateCreditInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the guard
 *    (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The ledger is append-only: there is no `update` and no `delete` here (and the runtime is granted
 * INSERT and SELECT only). `amount` is bounded and `reason` length-checked by the service before any
 * method here is called.
 */

/**
 * What the service creates. No `organizationId` (from the context), so a request body cannot choose the
 * tenant it writes into. `amount` is already bounded and `reason` already trimmed/length-checked.
 */
export interface CreateCreditInput {
  readonly amount: number;
  readonly reason: string;
  /** The person posting the credit — the service passes `context.userId`. */
  readonly createdBy: string;
}

export class CreditsRepository {
  /** List a tenant's credits, newest-first, within the acting tenant. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly BillingCreditRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(billingCredits)
      .where(eq(billingCredits.organizationId, context.organizationId))
      .orderBy(desc(billingCredits.createdAt), desc(billingCredits.id));
  }

  /**
   * Fetch one credit by id, within the acting tenant. No `findById(id)` without a context: on MySQL
   * that would return another customer's row. A cross-tenant id resolves to null here.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<BillingCreditRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(billingCredits)
      .where(
        and(eq(billingCredits.organizationId, context.organizationId), eq(billingCredits.id, id)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Post a credit. The id is generated here (UUIDv7). `organization_id` comes from the context, never
   * from `input`. The row is read back so the server-generated timestamp is returned. Append-only: this
   * is the only write path — there is no update or delete.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateCreditInput,
  ): Promise<BillingCreditRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(billingCredits).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      amount: input.amount,
      reason: input.reason,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) throw new Error(`billing credit ${id} vanished after insert`);
    return created;
  }
}
