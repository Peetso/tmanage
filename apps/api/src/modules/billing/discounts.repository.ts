import { and, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { billingDiscounts } from '../../common/database/schema.js';
import type { BillingDiscountRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Billing & plan management (module 19, x330). The discounts repository — the data-access layer behind
 * the org's discount / adjustment register, following the `billing_contacts` / `billing_credits`
 * repository pattern (`25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6):
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for the
 *    current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateDiscountInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the guard
 *    (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * Records only: there is no `update` here (and the runtime is granted INSERT, DELETE and SELECT only).
 * `label`, `kind`, `amount` and `expiresOn` are validated by the controller before any method here is
 * called.
 */

/**
 * What the service creates. No `organizationId` (from the context), so a request body cannot choose the
 * tenant it writes into. Every field is already validated by the controller.
 */
export interface CreateDiscountInput {
  readonly label: string;
  readonly kind: 'percent' | 'fixed';
  readonly amount: number;
  /** A calendar date `YYYY-MM-DD`, or null when the record never expires. */
  readonly expiresOn: string | null;
  /** The person recording the discount — the service passes `context.userId`. */
  readonly createdBy: string;
}

export class DiscountsRepository {
  /** List a tenant's discounts, newest-first, within the acting tenant. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly BillingDiscountRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(billingDiscounts)
      .where(eq(billingDiscounts.organizationId, context.organizationId))
      .orderBy(desc(billingDiscounts.createdAt), desc(billingDiscounts.id));
  }

  /**
   * Fetch one discount by id, within the acting tenant. No `findById(id)` without a context: on MySQL
   * that would return another customer's row. A cross-tenant id resolves to null here.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<BillingDiscountRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(billingDiscounts)
      .where(
        and(
          eq(billingDiscounts.organizationId, context.organizationId),
          eq(billingDiscounts.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Record a discount. The id is generated here (UUIDv7). `organization_id` comes from the context,
   * never from `input`. The row is read back so the server-generated timestamp is returned.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateDiscountInput,
  ): Promise<BillingDiscountRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(billingDiscounts).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      label: input.label,
      kind: input.kind,
      amount: input.amount,
      expiresOn: input.expiresOn,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) throw new Error(`billing discount ${id} vanished after insert`);
    return created;
  }

  /** Delete one discount, tenant-scoped. A cross-tenant id matches no row and removes nothing. */
  async remove(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(billingDiscounts)
      .where(
        and(
          eq(billingDiscounts.organizationId, context.organizationId),
          eq(billingDiscounts.id, id),
        ),
      );
  }
}
