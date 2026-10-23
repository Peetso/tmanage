import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { PLAN_MONTHLY_CENTS, canonicalPlanId, isPlanId, readPlanId } from './plan-catalog.js';
import type { BillingPeriod, CatalogPlanId, SubscriptionStatus } from './plan-catalog.js';
import type { SubscriptionRow } from '../../common/database/schema.js';

/**
 * The application service for Billing / module 19 (x177) — the subscription read and the plan-change
 * request. It follows the `UsageService` / `OrgObjectivesService` shape: authorize with the **real**
 * evaluator at an org-level resource, then read or write within the acting tenant.
 *
 * ## The one authorization layer that matters here
 *
 * `CapabilityGuard` on the route asks the coarse question `org.manage` (the owner and, since ADM-03,
 * the org admin, per the capability ceiling). A role that does not hold it gets a 403 there,
 * before this service runs. This service re-checks the same decision with `authorize()` against an
 * **org-level** resource (`projectId: null`, `04-SECURITY-PRIVACY` §4 / `25` §3: route guards are
 * UX only, the API authorizes every action). A denial is an honest `403`.
 *
 * ## The tenant is the principal's, never the caller's
 *
 * Both methods take a {@link TenantContext} the guard resolved from an active membership and read or
 * write for `context.organizationId`. There is no organization-id parameter to accept, so a caller
 * cannot name another tenant's subscription: the only organization these methods can name is the one
 * the request was already proven to belong to. The route's `:orgSlug` is matched against the
 * membership by `TenantContextGuard` (a foreign slug is that guard's 404), never trusted here.
 *
 * ## No money moves here
 *
 * A plan change records an *intent*: it upserts the row with `status = 'pending_change'` and nothing
 * else. There is no charge path in this service — no provider, no card, no token — because real
 * payment is out of this slice (Needs-Peter). `pending_change` is precisely "the customer asked;
 * nothing has been charged".
 */

/**
 * What the billing subscription screen reads — CONTRACT-001 Exact, paired in
 * `e2e/contracts/api-web-shapes.ts` with the web `SubscriptionView`.
 *
 * An explicit projection, not a serialised row (`25` §7): `organization_id` is never echoed, and a
 * column added to `subscriptions` in a future migration is invisible to every caller until someone
 * decides otherwise. `currentPeriodEnd` is null on the free/base tier and until a provider sets it.
 *
 * `planId` is always a catalog plan: a stored legacy `pro` reads as `studio`. `internalPeopleCount`
 * is the active internal memberships (clients never count). `nextBillAt` is null on a plan with no
 * list price (Free, Enterprise); otherwise the stored period end, or the first of next month (UTC)
 * until a provider sets one. `billingPeriod` is `monthly` — no yearly billing is recorded yet.
 */
export interface SubscriptionView {
  readonly planId: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: string | null;
  readonly internalPeopleCount: number;
  readonly nextBillAt: string | null;
  readonly billingPeriod: BillingPeriod;
}

/** The first instant of the month after `at`, in UTC — the default flat-plan billing day. */
export function firstOfNextMonthUtc(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

export class SubscriptionService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly subscriptions: SubscriptionRepository = new SubscriptionRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Project a row (or its absence, the free tier) and the people count into the view. */
  private toView(row: SubscriptionRow | null, internalPeopleCount: number): SubscriptionView {
    const planId: CatalogPlanId = readPlanId(row?.planId);
    const status: SubscriptionStatus = row?.status ?? 'active';
    const currentPeriodEnd = row?.currentPeriodEnd ?? null;
    const billed = (PLAN_MONTHLY_CENTS[planId] ?? 0) > 0;
    return {
      planId,
      status,
      currentPeriodEnd: currentPeriodEnd?.toISOString() ?? null,
      internalPeopleCount,
      nextBillAt: billed
        ? (currentPeriodEnd ?? firstOfNextMonthUtc(this.now())).toISOString()
        : null,
      billingPeriod: 'monthly',
    };
  }

  /**
   * Re-check `capability` against the org-level resource with the real evaluator, or throw the
   * ordinary `403`. `projectId` is `null` — a subscription belongs to the tenant, not a project —
   * so the relation gate never applies and the decision is the role ceiling and the tenant.
   */
  private authorizeOrg(context: TenantContext, principal: Principal, capability: Capability): void {
    const permitted = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, `denied_${capability}`);
    }
  }

  /**
   * Read the caller's own tenant's subscription. Defaults to the free/base tier when the
   * organization has no row yet — a new organization has a subscription (free), not a missing one.
   * A legacy `pro` row reads as `studio`.
   */
  async read(context: TenantContext, principal: Principal): Promise<SubscriptionView> {
    this.authorizeOrg(context, principal, 'org.manage');

    const [row, people] = await this.database.read(
      context,
      async (runner) =>
        [
          await this.subscriptions.find(runner, context),
          await this.subscriptions.countInternalPeople(runner, context),
        ] as const,
    );
    return this.toView(row, people);
  }

  /**
   * Request a change to `planId`: validate it against the plan catalog (off-list ⇒ 400 with no
   * write; `pro` is accepted and stored as `studio`), authorize, then upsert the one subscription
   * row to `status = 'pending_change'`.
   *
   * Validation runs before authorization is re-checked, but after the route guard — an off-catalog
   * id from a caller who already cleared `org.manage` at the guard is a 400, and the write never
   * runs. **No charge is executed**: the only side effect is the upsert of a recorded intent.
   */
  async requestChange(
    context: TenantContext,
    principal: Principal,
    planId: string,
  ): Promise<SubscriptionView> {
    if (!isPlanId(planId)) {
      throw new ApiError(
        400,
        'validation_failed',
        'Unknown plan',
        [{ field: 'planId', message: 'must be a plan in the catalog' }],
        'off_catalog_plan',
      );
    }

    this.authorizeOrg(context, principal, 'org.manage');

    const status: SubscriptionStatus = 'pending_change';
    const [row, people] = await this.database.transaction(
      context,
      async (tx) =>
        [
          await this.subscriptions.upsertPlan(tx, context, {
            planId: canonicalPlanId(planId),
            status,
          }),
          await this.subscriptions.countInternalPeople(tx, context),
        ] as const,
    );
    return this.toView(row, people);
  }
}
