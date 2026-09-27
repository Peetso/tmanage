import type { SUBSCRIPTION_STATUSES } from '../../common/database/schema.js';

/**
 * The billing plan catalog — Billing / module 19 (x177).
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Billing wants a plan-change to validate its target
 * against the pricing catalog (the x157 pricing page's source of truth). That catalog does not exist
 * on this slice's base (master bcfe397 — x157 is a sibling pass-21 slice not yet integrated), so the
 * closed set of plan ids is defined here, self-contained: a `plan_id` the change endpoint accepts is
 * one of exactly these, and anything else is a 400 with no write. When x157's catalog lands, this
 * list is the one place to reconcile against it — the controller and repository name only
 * {@link isPlanId} and {@link DEFAULT_PLAN_ID}, never a literal.
 *
 * Deliberately just the ids: this slice records *which* plan an organization is on and asked to move
 * to. Prices, entitlements and billing periods belong to the pricing/entitlement work (Needs-Peter —
 * an external provider), and are never stored or charged here.
 */
export const PLAN_IDS = ['free', 'starter', 'pro', 'business'] as const;

export type PlanId = (typeof PLAN_IDS)[number];

/** The tier an organization is on until it has a subscription row of its own. */
export const DEFAULT_PLAN_ID: PlanId = 'free';

/** Narrow an untrusted value to a catalog plan id. An off-catalog id is a 400, never a write. */
export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}

/** Re-exported so the service and repository name one status type. Mirrors the `0074` ENUM. */
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
