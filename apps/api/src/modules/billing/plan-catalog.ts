import type { SUBSCRIPTION_STATUSES } from '../../common/database/schema.js';

/**
 * The billing plan catalog — Billing / module 19 (x177), reconciled with the flat pricing the
 * website `/pricing` page and the in-app "Choose a plan" screen draw (approved Figma 376:2087 and
 * 376:17695 task 12).
 *
 * Five plans, each one flat price for the whole team — never a per-member price. Enterprise is
 * quoted per contract, so it has no list price here. The controllers and repositories name only
 * {@link isPlanId}, {@link canonicalPlanId} and {@link DEFAULT_PLAN_ID}, never a literal.
 *
 * `pro` is the earlier name of `studio`. `subscriptions.plan_id` is a VARCHAR(64), so rows written
 * before the rename may still say `pro`: it is still accepted on input and always read as `studio`.
 * No money moves here — prices are display and estimate inputs only.
 */
export const PLAN_IDS = ['free', 'starter', 'studio', 'business', 'enterprise'] as const;

/** A plan in the current catalog. */
export type CatalogPlanId = (typeof PLAN_IDS)[number];

/** Earlier plan names that are still accepted on input, and the catalog plan each one reads as. */
const LEGACY_PLAN_ALIASES = { pro: 'studio' } as const satisfies Record<string, CatalogPlanId>;

/** Any id the API accepts: a catalog plan or a legacy alias of one. */
export type PlanId = CatalogPlanId | keyof typeof LEGACY_PLAN_ALIASES;

/** The tier an organization is on until it has a subscription row of its own. */
export const DEFAULT_PLAN_ID: CatalogPlanId = 'free';

/** Narrow an untrusted value to an accepted plan id. An unknown id is a 400, never a write. */
export function isPlanId(value: unknown): value is PlanId {
  return (
    typeof value === 'string' &&
    ((PLAN_IDS as readonly string[]).includes(value) ||
      Object.prototype.hasOwnProperty.call(LEGACY_PLAN_ALIASES, value))
  );
}

/** The catalog plan an accepted id reads as (`pro` → `studio`; a catalog id is itself). */
export function canonicalPlanId(planId: PlanId): CatalogPlanId {
  return planId === 'pro' ? LEGACY_PLAN_ALIASES.pro : planId;
}

/** A stored or untrusted plan id read as a catalog plan, falling back to the default tier. */
export function readPlanId(value: unknown): CatalogPlanId {
  return isPlanId(value) ? canonicalPlanId(value) : DEFAULT_PLAN_ID;
}

/**
 * Flat monthly price for the whole team, in integer US cents. `null` is Enterprise: custom, quoted
 * per contract. The same numbers as the public pricing page.
 */
export const PLAN_MONTHLY_CENTS: Readonly<Record<CatalogPlanId, number | null>> = {
  free: 0,
  starter: 1900,
  studio: 4900,
  business: 8900,
  enterprise: null,
};

/** How the organization is billed. Only monthly is recorded today; yearly saves 20 %. */
export type BillingPeriod = 'monthly' | 'yearly';

/** Re-exported so the service and repository name one status type. Mirrors the `0074` ENUM. */
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
