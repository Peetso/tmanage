import { and, desc, eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { invoices } from '../../common/database/schema.js';
import type { InvoiceRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The invoices repository — FEAT: Billing invoice history (x179), following the read-only sibling
 * pattern (`project_risks` 0049) for its tenant scoping.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read.** Every method's first two parameters are the `TenantQueryRunner` for the
 *    current unit of work and the `TenantContext`. There is no overload without a context, so a
 *    caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never a DTO.** There is no `organizationId` argument a
 *    request could populate.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * This slice is read-only: invoices are produced by the subscription lifecycle or the seed, and
 * there is no create/update path here. The runner is a parameter, not a field: the repository holds
 * no connection and no state.
 */

export type InvoiceStatus = InvoiceRow['status'];

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/** Clamp the caller's page size into `[1, MAX_PAGE_SIZE]`, defaulting when absent. */
export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export interface ListInvoicesOptions {
  readonly limit?: number;
}

export class InvoicesRepository {
  /**
   * List the acting tenant's invoices, newest issued first.
   *
   * The order is `issued_at DESC, id DESC`: deterministic even when two invoices share a
   * millisecond, and served by the `(organization_id, issued_at)` index (0076). The tenant
   * predicate is always present; the page is bounded.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListInvoicesOptions = {},
  ): Promise<readonly InvoiceRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    return db
      .select()
      .from(invoices)
      .where(eq(invoices.organizationId, context.organizationId))
      .orderBy(desc(invoices.issuedAt), desc(invoices.id))
      .limit(limit);
  }

  /**
   * Fetch one invoice by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row, which
   * is why ADR-0001 exists and this signature has no unscoped form. A cross-tenant or unknown id
   * returns `null`, which the service turns into a 404 — the resolve-before-authorize guarantee.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    invoiceId: string,
  ): Promise<InvoiceRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.organizationId, context.organizationId), eq(invoices.id, invoiceId)))
      .limit(1);
    return rows[0] ?? null;
  }
}
