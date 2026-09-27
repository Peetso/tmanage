import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { DEFAULT_PLAN_ID, isPlanId } from './plan-catalog.js';
import type { PlanId } from './plan-catalog.js';

/**
 * Plan-change preview — Billing / module 19 (x198), extending x177's subscription. Before an owner
 * commits to a plan change (`POST …/billing/subscription/change`), this estimates what that change
 * costs: the difference between the plan they are on and a target plan, for a given number of seats.
 *
 * ## An estimate, never a charge
 *
 * This slice reads the current subscription and does arithmetic against a fixed local price catalog.
 * There is no provider call, no card, no token and no write — nothing here moves money. Real charging
 * (and exact day-level proration) is Needs-Peter (Stripe test-mode). The number returned is a
 * deterministic full-period estimate the UI can show alongside the plan picker.
 *
 * ## Deterministic — no clock reads
 *
 * The computation never reads `now`: the delta is a pure function of the current plan, the target
 * plan and the seat count, so the same inputs always return the same estimate (no clock-drift between
 * a preview and the change that follows it). `currentPeriodEnd` is echoed straight from the stored
 * subscription — the period the change would apply against — rather than derived from the wall clock.
 * Exact remaining-days proration belongs to the provider that actually bills, not to an estimate.
 *
 * ## Same authorization and tenant discipline as the subscription service
 *
 * `org.manage` (owners only) is re-checked here against the org-level resource with the real
 * evaluator, after the route guard (`25` §3: guards are UX, the API authorizes every action). The
 * current subscription is read through {@link SubscriptionRepository} for `context.organizationId` —
 * the tenant the guard proved from a membership row — so a caller can never preview another tenant's
 * subscription: there is no organization-id parameter to name one.
 */

/** A plan's fixed price, in integer US cents. The catalog the estimate is computed against. */
interface PlanPrice {
  /** The recurring platform fee for the plan, independent of seat count. */
  readonly baseCents: number;
  /** The recurring fee per occupied seat. */
  readonly perSeatCents: number;
}

/**
 * The fixed price catalog — self-contained, exactly as {@link PLAN_IDS} is. The pricing page's
 * source of truth (x157) is not on this slice's base, so the numbers live here as a closed table
 * keyed by every catalog plan id; when the real catalog lands this is the one place to reconcile.
 * These are estimate inputs only — no price is stored, and nothing is charged.
 */
const PLAN_PRICING: Readonly<Record<PlanId, PlanPrice>> = {
  free: { baseCents: 0, perSeatCents: 0 },
  starter: { baseCents: 1900, perSeatCents: 900 },
  pro: { baseCents: 4900, perSeatCents: 1500 },
  business: { baseCents: 9900, perSeatCents: 2500 },
};

/** The currency every figure in a preview is expressed in. Estimate only; no charge. */
const CURRENCY = 'usd';

/** The largest seat count a preview will estimate for — a validation bound, not a plan limit. */
const MAX_SEATS = 1000;

/**
 * What the plan-change preview screen reads — CONTRACT-001 Exact, paired in
 * `e2e/contracts/api-web-shapes.ts` with the web `PlanChangePreviewView`.
 *
 * An explicit projection: `organization_id` is never echoed. Every money field is integer cents so
 * the client formats without float drift; a positive `estimatedDeltaCents` is an upgrade cost, a
 * negative one a downgrade credit. `currentPeriodEnd` is null on the free/base tier and until a
 * provider sets the period.
 */
export interface PlanChangePreviewView {
  readonly currentPlanId: string;
  readonly targetPlanId: string;
  readonly seats: number;
  readonly currency: string;
  readonly currentMonthlyCents: number;
  readonly targetMonthlyCents: number;
  readonly baseDeltaCents: number;
  readonly seatDeltaCents: number;
  readonly estimatedDeltaCents: number;
  readonly currentPeriodEnd: string | null;
}

/** What {@link PlanPreviewService.preview} needs. Request-side — never a paired response shape. */
export interface PlanPreviewInput {
  readonly target: string;
  readonly seats: number;
}

export class PlanPreviewService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly subscriptions: SubscriptionRepository = new SubscriptionRepository(),
  ) {}

  /**
   * Re-check `capability` against the org-level resource with the real evaluator, or throw the
   * ordinary `403`. `projectId` is `null` — a subscription belongs to the tenant, not a project.
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
   * Estimate the cost of moving to `input.target` at `input.seats` occupied seats.
   *
   * Validation runs before the read and before authorization is re-checked: an off-catalog target,
   * or a seat count outside `[1, {@link MAX_SEATS}]`, is a 400 (the route guard has already refused a
   * caller without `org.manage`; this service re-checks after validation). The current plan is the
   * one on the tenant's subscription, defaulting to the free/base tier when there is no row — the
   * same default the subscription read uses. No write, no charge: the only effect is the returned
   * estimate.
   */
  async preview(
    context: TenantContext,
    principal: Principal,
    input: PlanPreviewInput,
  ): Promise<PlanChangePreviewView> {
    if (!isPlanId(input.target)) {
      throw new ApiError(
        400,
        'validation_failed',
        'Unknown plan',
        [{ field: 'target', message: 'must be a plan in the catalog' }],
        'off_catalog_plan',
      );
    }
    if (!Number.isSafeInteger(input.seats) || input.seats < 1 || input.seats > MAX_SEATS) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', [
        { field: 'seats', message: `must be an integer between 1 and ${MAX_SEATS}` },
      ]);
    }

    this.authorizeOrg(context, principal, 'org.manage');

    const row = await this.database.read(context, (runner) =>
      this.subscriptions.find(runner, context),
    );

    const currentPlanId: PlanId = isPlanId(row?.planId) ? row.planId : DEFAULT_PLAN_ID;
    const targetPlanId: PlanId = input.target;
    const current = PLAN_PRICING[currentPlanId];
    const target = PLAN_PRICING[targetPlanId];
    const seats = input.seats;

    const currentMonthlyCents = current.baseCents + current.perSeatCents * seats;
    const targetMonthlyCents = target.baseCents + target.perSeatCents * seats;
    const baseDeltaCents = target.baseCents - current.baseCents;
    const seatDeltaCents = (target.perSeatCents - current.perSeatCents) * seats;

    return {
      currentPlanId,
      targetPlanId,
      seats,
      currency: CURRENCY,
      currentMonthlyCents,
      targetMonthlyCents,
      baseDeltaCents,
      seatDeltaCents,
      estimatedDeltaCents: baseDeltaCents + seatDeltaCents,
      currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
    };
  }
}
