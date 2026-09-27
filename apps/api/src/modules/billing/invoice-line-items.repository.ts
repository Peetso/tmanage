import { and, asc, eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { invoiceLineItems } from '../../common/database/schema.js';
import type { InvoiceLineItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The invoice line-items repository — FEAT: Billing invoice line items (x225), following the
 * read-only sibling pattern (`invoices` 0076) for its tenant scoping.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read.** Every method's first two parameters are the `TenantQueryRunner` for the
 *    current unit of work and the `TenantContext`. There is no overload without a context, so a
 *    caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never a DTO.** There is no `organizationId` argument a
 *    request could populate; `invoiceId` names a row, not a tenant.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * This slice is read-only: lines are produced by the subscription lifecycle or the seed, and there
 * is no create/update path here. The runner is a parameter, not a field: the repository holds no
 * connection and no state.
 */
export class InvoiceLineItemsRepository {
  /**
   * List one invoice's line items, within the acting tenant, in display order.
   *
   * The order is `position ASC, id ASC`: deterministic even when two lines share a position, and
   * served by the `(organization_id, invoice_id, position)` index (0099). The tenant predicate and
   * the `invoice_id` predicate are always present. The invoice's existence (and tenancy) is resolved
   * by the caller against `invoices` before this runs, so a cross-tenant `invoiceId` has already
   * become a 404.
   */
  async listByInvoice(
    runner: TenantQueryRunner,
    context: TenantContext,
    invoiceId: string,
  ): Promise<readonly InvoiceLineItemRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(invoiceLineItems)
      .where(
        and(
          eq(invoiceLineItems.organizationId, context.organizationId),
          eq(invoiceLineItems.invoiceId, invoiceId),
        ),
      )
      .orderBy(asc(invoiceLineItems.position), asc(invoiceLineItems.id));
  }
}
