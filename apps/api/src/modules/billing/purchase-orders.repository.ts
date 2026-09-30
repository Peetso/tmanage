import { and, asc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { billingPurchaseOrders } from '../../common/database/schema.js';
import type { BillingPurchaseOrderRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Billing & entitlements (module 19, x282). The purchase-orders repository — the data-access layer
 * behind the org-scoped PO references, following the `billing_usage_alerts` repository pattern
 * (`25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6):
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreatePurchaseOrderInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the guard
 *    (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * `poNumber` is non-empty and `amountMinor` bounded (>= 0) by the service before any write. The
 * `(organization_id, po_number)` unique key is the authoritative duplicate guard; the service's
 * pre-check ({@link findByNumber}) turns a would-be collision into a 409 with no second insert.
 */

/**
 * What the service creates. No `organizationId` (from the context), so a request body cannot choose the
 * tenant it writes into. `poNumber` is already non-empty and `amountMinor` (if present) bounded >= 0.
 */
export interface CreatePurchaseOrderInput {
  readonly poNumber: string;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly note: string | null;
}

export class PurchaseOrdersRepository {
  /** List a tenant's PO references, number-ascending, within the acting tenant. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly BillingPurchaseOrderRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(billingPurchaseOrders)
      .where(eq(billingPurchaseOrders.organizationId, context.organizationId))
      .orderBy(asc(billingPurchaseOrders.poNumber));
  }

  /**
   * Fetch one PO by id, within the acting tenant. No `findById(id)` without a context: on MySQL that
   * would return another customer's row. A cross-tenant id resolves to null here.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<BillingPurchaseOrderRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(billingPurchaseOrders)
      .where(
        and(
          eq(billingPurchaseOrders.organizationId, context.organizationId),
          eq(billingPurchaseOrders.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Fetch one PO by its number, within the acting tenant. The service's pre-check for a duplicate
   * before {@link create}, so a collision is a 409 with no second insert (the unique key is the
   * backstop besides).
   */
  async findByNumber(
    runner: TenantQueryRunner,
    context: TenantContext,
    poNumber: string,
  ): Promise<BillingPurchaseOrderRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(billingPurchaseOrders)
      .where(
        and(
          eq(billingPurchaseOrders.organizationId, context.organizationId),
          eq(billingPurchaseOrders.poNumber, poNumber),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a PO reference. The id is generated here (UUIDv7). `organization_id` comes from the
   * context, never from `input`. The row is read back so the server-generated `created_at` is returned.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreatePurchaseOrderInput,
  ): Promise<BillingPurchaseOrderRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(billingPurchaseOrders).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      poNumber: input.poNumber,
      amountMinor: input.amountMinor,
      currency: input.currency,
      note: input.note,
      status: 'open',
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) throw new Error(`billing purchase order ${id} vanished after insert`);
    return created;
  }

  /**
   * Set a PO's status to `closed`, within the acting tenant. Idempotent: closing an already-closed PO
   * is a no-op write that returns the same row. Identity (organization, number) is never touched — the
   * engine trigger pins it besides. Returns the fresh row.
   */
  async close(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<BillingPurchaseOrderRow> {
    const db = tenantDrizzle(runner);
    await db
      .update(billingPurchaseOrders)
      .set({ status: 'closed' })
      .where(
        and(
          eq(billingPurchaseOrders.organizationId, context.organizationId),
          eq(billingPurchaseOrders.id, id),
        ),
      );

    const closed = await this.findById(runner, context, id);
    if (!closed) throw new Error(`billing purchase order ${id} vanished after close`);
    return closed;
  }

  /**
   * Remove a PO reference, within the acting tenant. Idempotent: deleting a row that is absent (or in
   * another tenant, invisible here) touches nothing. The caller returns 204 either way.
   */
  async remove(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(billingPurchaseOrders)
      .where(
        and(
          eq(billingPurchaseOrders.organizationId, context.organizationId),
          eq(billingPurchaseOrders.id, id),
        ),
      );
  }
}
