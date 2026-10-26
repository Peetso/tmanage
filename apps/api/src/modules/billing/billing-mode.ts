import { ApiError } from '../../common/http/errors.js';
import { PLAN_FEATURE_SET, PLAN_IDS, PLAN_LIMITS } from './plan-catalog.js';
import type { CatalogPlanId, PlanFeature, PlanLimits } from './plan-catalog.js';

/**
 * `BILLING_MODE` — the one switch between the public beta and paid billing.
 *
 * - `beta_free` (the default, also when the variable is unset or unrecognised): TManage is free.
 *   Every organization gets the top plan's limits and features, and every route that would start a
 *   charge or record a purchase (plan change, plan-change request, purchase order, credit) answers
 *   409 `billing_disabled_beta`. Read-only billing routes keep working.
 * - `paid`: the catalog applies as written — each organization gets its own plan's entitlements and
 *   the plan-change / purchase routes behave as before.
 *
 * Read from the environment at call time (the `fileScanJobEnabled(env = process.env)` shape), so the
 * services need no new constructor argument and a test switches it with `vi.stubEnv`. An unknown
 * value reads as `beta_free`: a typo must never start charging.
 */
export const BILLING_MODES = ['beta_free', 'paid'] as const;

export type BillingMode = (typeof BILLING_MODES)[number];

export const DEFAULT_BILLING_MODE: BillingMode = 'beta_free';

/** Parse a raw `BILLING_MODE` value. Only an explicit `paid` turns billing on. */
export function parseBillingMode(raw: string | undefined): BillingMode {
  return (raw ?? '').trim().toLowerCase() === 'paid' ? 'paid' : DEFAULT_BILLING_MODE;
}

/** The deployment's billing mode, read from `BILLING_MODE`. */
export function billingMode(env: NodeJS.ProcessEnv = process.env): BillingMode {
  return parseBillingMode(env['BILLING_MODE']);
}

/** The top plan of the catalog — what every organization gets during the free beta. */
export const TOP_PLAN_ID: CatalogPlanId = PLAN_IDS[PLAN_IDS.length - 1]!;

/** What an organization may use: the plan whose limits and features apply, and those values. */
export interface Entitlements {
  /** The plan the limits and features come from (the top plan in `beta_free`). */
  readonly planId: CatalogPlanId;
  readonly limits: PlanLimits;
  readonly features: readonly PlanFeature[];
}

/**
 * The one place a plan's entitlements are decided. In `beta_free` every organization, whatever plan
 * it is stored on, gets the top plan's; in `paid` it gets its own.
 */
export function entitlementsFor(
  storedPlanId: CatalogPlanId,
  mode: BillingMode = billingMode(),
): Entitlements {
  const planId = mode === 'beta_free' ? TOP_PLAN_ID : storedPlanId;
  return { planId, limits: PLAN_LIMITS[planId], features: PLAN_FEATURE_SET[planId] };
}

export const BILLING_DISABLED_BETA_MESSAGE =
  'TManage is free during the public beta, so plans cannot be changed or bought yet.';

/**
 * Refuse a charge-starting or purchase-recording action while the beta is free: 409
 * `billing_disabled_beta`, with no write. A no-op in `paid`.
 */
export function assertBillingEnabled(mode: BillingMode = billingMode()): void {
  if (mode === 'beta_free') {
    throw new ApiError(
      409,
      'billing_disabled_beta',
      BILLING_DISABLED_BETA_MESSAGE,
      undefined,
      'billing_disabled_beta',
    );
  }
}
