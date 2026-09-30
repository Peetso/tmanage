import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingDiscountRow } from '../../common/database/schema.js';
import { DiscountsRepository } from './discounts.repository.js';

/**
 * Billing & plan management (module 19, x330). The discounts service — the business layer over the org's
 * discount / adjustment register. It follows the `billing_contacts` / `billing_credits` service posture:
 * it holds the {@link TenantDatabase} and the repository, opens the read/transaction, and makes the
 * authoritative authorization decision. No driver handle lives here (the repository holds it), so this
 * file is free of the `no-restricted-imports` boundary that reserves `drizzle-orm` for the
 * repository/database modules.
 *
 * ## The capability
 *
 * Billing is an org-admin concern, so every method reuses `org.manage` — no billing capability exists
 * and this slice adds none (the same divergence `credits.service.ts` records). The route guard asks the
 * coarse ceiling question; this service adds the authoritative application decision (`25-AUTH` §3 step 2,
 * deny-by-default): an org-scoped `authorize()` (`projectId: null`) that a suspended membership fails.
 *
 * ## Resolve-then-authorize on delete
 *
 * {@link remove} resolves the discount tenant-scoped **before** it authorizes: a cross-tenant or absent
 * id is a **404 with no write**, never a neighbour's discount removed and never a 403 that would betray
 * the row exists. Only once the row is in hand does the service authorize `org.manage`.
 *
 * ## What it does, and what it cannot
 *
 * A discount is *bookkeeping at rest*. {@link list} marks each record active or expired against the
 * process clock; it applies nothing to a charge, calls no payment gateway and moves no money (applying a
 * discount to a real charge is Needs-Peter / Stripe). Records only — {@link create} and {@link remove}
 * are the only writes; a discount is never edited (a change is a delete-and-recreate).
 */

/**
 * What a caller is allowed to see of one discount — paired Exact with the web `BillingDiscountView`.
 * `organizationId` is deliberately absent: the wire projection never echoes the tenant id. `active` is
 * computed on the read side against the process clock and is not stored.
 */
export interface BillingDiscountView {
  readonly id: string;
  readonly label: string;
  readonly kind: 'percent' | 'fixed';
  /** A whole percentage 0..100 for `percent`, or a non-negative integer minor-units amount for `fixed`. */
  readonly amount: number;
  /** A calendar date `YYYY-MM-DD`, or null when the record never expires. */
  readonly expiresOn: string | null;
  /** True when the record has no expiry or its expiry is not before the process clock's date. */
  readonly active: boolean;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** What the service's create accepts. Every field is already validated by the caller. */
export interface CreateDiscountParams {
  readonly label: string;
  readonly kind: 'percent' | 'fixed';
  readonly amount: number;
  readonly expiresOn: string | null;
}

/** The process clock's calendar date, `YYYY-MM-DD` (UTC). Lexicographic compare is correct for it. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: BillingDiscountRow, asOf: string): BillingDiscountView {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind as 'percent' | 'fixed',
    amount: row.amount,
    expiresOn: row.expiresOn,
    active: row.expiresOn === null || row.expiresOn >= asOf,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DiscountsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly discounts: DiscountsRepository = new DiscountsRepository(),
  ) {}

  /**
   * List the acting tenant's discounts newest-first, each marked active or expired against the process
   * clock. `org.manage` org-scoped (a 403 for a caller without it).
   */
  async list(
    context: TenantContext,
    principal: Principal,
  ): Promise<{ readonly discounts: readonly BillingDiscountView[] }> {
    this.requireOrgManage(principal, context, 'billing_discount.list');
    const rows = await this.database.read(context, (runner) =>
      this.discounts.list(runner, context),
    );
    const asOf = today();
    return { discounts: rows.map((row) => toView(row, asOf)) };
  }

  /**
   * Record a discount. `org.manage` org-scoped (a 403 for a caller without it). The caller has already
   * validated every field; nothing is written on an invalid input.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    params: CreateDiscountParams,
  ): Promise<BillingDiscountView> {
    this.requireOrgManage(principal, context, 'billing_discount.create');
    const row = await this.database.transaction(context, (tx) =>
      this.discounts.create(tx, context, { ...params, createdBy: context.userId }),
    );
    return toView(row, today());
  }

  /**
   * Remove a discount, tenant-scoped. Resolves the discount (**404**, no write) before it authorizes
   * (`org.manage`, 403). An absent or cross-tenant id is the same 404, so nothing is ever removed from
   * another tenant.
   */
  async remove(context: TenantContext, principal: Principal, id: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const existing = await this.discounts.findById(tx, context, id);
      if (!existing) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'discount_not_visible');
      }
      this.requireOrgManage(principal, context, 'billing_discount.remove');
      await this.discounts.remove(tx, context, id);
    });
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
