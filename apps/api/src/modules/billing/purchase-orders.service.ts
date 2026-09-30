import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingPurchaseOrderRow } from '../../common/database/schema.js';
import { PurchaseOrdersRepository } from './purchase-orders.repository.js';

/**
 * Billing & entitlements (module 19, x282). The purchase-orders service — the business layer over the
 * org-scoped PO references. It follows the `usage-alerts` service posture: it holds the
 * {@link TenantDatabase} and the repository, opens the read/transaction, and makes the authoritative
 * authorization decision. No driver handle lives here (the repository holds it), so this file is free
 * of the `no-restricted-imports` boundary that reserves `drizzle-orm` for repository/database modules.
 *
 * ## The capability
 *
 * Billing is an org-admin concern, so every method reuses `org.manage` — no billing capability exists
 * and this slice adds none (the same divergence `usage-alerts.service.ts` records). The route guard
 * asks the coarse ceiling question; this service adds the authoritative application decision
 * (`25-AUTH` §3 step 2, deny-by-default): an org-scoped `authorize()` (`projectId: null`) that a
 * suspended membership fails.
 *
 * ## The Known-trap order
 *
 * The tenant comes from the context the guard resolved, never the body. On the close path the PO is
 * resolved tenant-scoped **before** authorize/write: a cross-tenant or missing id is a 404, never a
 * foreign-key surprise. On create the duplicate number is pre-checked before the insert, so a
 * collision is a 409 with no second insert. Validation (empty number, negative amount) is the
 * controller's, done before this service is called; nothing here writes on an invalid input.
 *
 * ## What it does, and what it cannot
 *
 * A PO reference is a *record*, not a payment: nothing here charges, transfers, or stores a payment
 * instrument. Invoices citing a PO are a later concern; this slice only records the references.
 */

/** What a caller is allowed to see of one PO reference. `organizationId` is deliberately absent. */
export interface PurchaseOrderView {
  readonly id: string;
  readonly poNumber: string;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly note: string | null;
  readonly status: 'open' | 'closed';
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** What the service's create accepts. Already validated by the caller (non-empty number, amount >= 0). */
export interface CreatePurchaseOrderParams {
  readonly poNumber: string;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly note: string | null;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: BillingPurchaseOrderRow): PurchaseOrderView {
  return {
    id: row.id,
    poNumber: row.poNumber,
    amountMinor: row.amountMinor,
    currency: row.currency,
    note: row.note,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PurchaseOrdersService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly purchaseOrders: PurchaseOrdersRepository = new PurchaseOrdersRepository(),
  ) {}

  /** List the acting tenant's PO references, number-ascending, for an org admin. */
  async list(context: TenantContext, principal: Principal): Promise<readonly PurchaseOrderView[]> {
    this.requireOrgManage(principal, context, 'purchase_order.list');
    const rows = await this.database.read(context, (runner) =>
      this.purchaseOrders.list(runner, context),
    );
    return rows.map(toView);
  }

  /**
   * Record a PO reference. `org.manage` org-scoped (a 403 for a caller without it). A number that
   * already exists for the tenant is a 409 with no second insert (pre-checked, and the unique key is
   * the backstop). The caller has already validated the input; nothing is written on an invalid one.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    params: CreatePurchaseOrderParams,
  ): Promise<PurchaseOrderView> {
    this.requireOrgManage(principal, context, 'purchase_order.create');
    const row = await this.database.transaction(context, async (tx) => {
      const existing = await this.purchaseOrders.findByNumber(tx, context, params.poNumber);
      if (existing) {
        throw new ApiError(
          409,
          'conflict',
          'A purchase order with this number already exists',
          [{ field: 'poNumber', message: 'must be unique within the organization' }],
          'purchase_order_number_duplicate',
        );
      }
      return this.purchaseOrders.create(tx, context, params);
    });
    return toView(row);
  }

  /**
   * Close a PO reference. The PO is resolved tenant-scoped **before** the authorize/write: a
   * cross-tenant or missing id is a 404. `org.manage` org-scoped besides. Idempotent: closing an
   * already-closed PO returns it unchanged.
   */
  async close(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<PurchaseOrderView> {
    const existing = await this.database.read(context, (runner) =>
      this.purchaseOrders.findById(runner, context, id),
    );
    if (!existing) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'purchase_order_not_visible',
      );
    }
    this.requireOrgManage(principal, context, 'purchase_order.close');
    const row = await this.database.transaction(context, (tx) =>
      this.purchaseOrders.close(tx, context, id),
    );
    return toView(row);
  }

  /**
   * Remove a PO reference. `org.manage` org-scoped. Idempotent: a delete of an absent (or cross-tenant,
   * invisible) id touches nothing and still succeeds, so the caller returns 204 either way.
   */
  async remove(context: TenantContext, principal: Principal, id: string): Promise<void> {
    this.requireOrgManage(principal, context, 'purchase_order.remove');
    await this.database.transaction(context, (tx) => this.purchaseOrders.remove(tx, context, id));
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  private requireOrgManage(principal: Principal, context: TenantContext, action: string): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }
  }
}
