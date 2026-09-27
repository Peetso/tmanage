import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingCreditRow } from '../../common/database/schema.js';
import { CreditsRepository } from './credits.repository.js';

/**
 * Billing & entitlements (module 19, x226). The credits service — the business layer over the manual
 * credit / adjustment ledger. It follows the `usage-alerts` service posture: it holds the
 * {@link TenantDatabase} and the repository, opens the read/transaction, and makes the authoritative
 * authorization decision. No driver handle lives here (the repository holds it), so this file is free of
 * the `no-restricted-imports` boundary that reserves `drizzle-orm` for repository/database modules.
 *
 * ## The capability
 *
 * Billing is an org-admin concern, so every method reuses `org.manage` — no billing capability exists
 * and this slice adds none (the same divergence `usage-alerts.service.ts` records). The route guard asks
 * the coarse ceiling question; this service adds the authoritative application decision (`25-AUTH` §3
 * step 2, deny-by-default): an org-scoped `authorize()` (`projectId: null`) that a suspended membership
 * fails.
 *
 * ## What it does, and what it cannot
 *
 * A credit is *bookkeeping at rest*. {@link list} computes a running balance by summing the tenant's
 * amounts in-app; it settles nothing, calls no payment gateway, and moves no money. The ledger is
 * append-only — {@link post} is the only write, and there is no edit or delete of a posted credit (a
 * correction is a new, offsetting entry). Real settlement is Needs-Peter, out of this slice.
 */

/**
 * What a caller is allowed to see of one posted credit — paired Exact with the web
 * `BillingCreditView`. `organizationId` is deliberately absent: the wire projection never echoes the
 * tenant id.
 */
export interface BillingCreditView {
  readonly id: string;
  /** Signed integer minor units: positive is a credit, negative an adjustment. */
  readonly amount: number;
  readonly reason: string;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** What the service's post accepts. `amount`/`reason` are already validated by the caller. */
export interface PostCreditParams {
  readonly amount: number;
  readonly reason: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: BillingCreditRow): BillingCreditView {
  return {
    id: row.id,
    amount: row.amount,
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export class CreditsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly credits: CreditsRepository = new CreditsRepository(),
  ) {}

  /**
   * List the acting tenant's credits newest-first, with the running balance (the sum of every amount)
   * computed in-app. `org.manage` org-scoped (a 403 for a caller without it).
   */
  async list(
    context: TenantContext,
    principal: Principal,
  ): Promise<{ readonly credits: readonly BillingCreditView[]; readonly balance: number }> {
    this.requireOrgManage(principal, context, 'billing_credit.list');
    const rows = await this.database.read(context, (runner) => this.credits.list(runner, context));
    const balance = rows.reduce((sum, row) => sum + row.amount, 0);
    return { credits: rows.map(toView), balance };
  }

  /**
   * Post a credit / adjustment. `org.manage` org-scoped (a 403 for a caller without it). The caller has
   * already validated `amount` and `reason`; nothing is written on an invalid input. Append-only — this
   * is the only write.
   */
  async post(
    context: TenantContext,
    principal: Principal,
    params: PostCreditParams,
  ): Promise<BillingCreditView> {
    this.requireOrgManage(principal, context, 'billing_credit.post');
    const row = await this.database.transaction(context, (tx) =>
      this.credits.create(tx, context, { ...params, createdBy: context.userId }),
    );
    return toView(row);
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
