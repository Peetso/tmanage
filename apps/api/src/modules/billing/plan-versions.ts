import { ApiError } from '../../common/http/errors.js';
import { CONTRACT_MAX_SIZE_BYTES } from '../files/upload-input.js';
import type { BillingMode, PlanVersionEntitlements } from './billing-mode.js';
import { PLAN_FEATURES, canonicalPlanId, isPlanId } from './plan-catalog.js';
import type { CatalogPlanId, PlanFeature, PlanLimits } from './plan-catalog.js';

/**
 * 57-02 · The final plan ladder as data (doc 57 §4.2, §4.5; `plan_versions`, 0351).
 *
 * Each plan's price, limits and features live in immutable versions. A Platform admin publishes a
 * change as a new version with its own `effective_from`; nothing is ever edited in place. A
 * workspace's subscription names the version it is on (`subscriptions.plan_version`), so a newer
 * version never changes what an existing workspace has (grandfathering).
 *
 * **Off during the beta.** The ladder applies only when `PLAN_LADDER=on` AND the billing mode is
 * `paid` ({@link planLadderActive}). Otherwise every workspace stays on the free beta plan exactly
 * as `entitlementsFor` decides today. No price here is ever charged: there is no payment provider,
 * no provider key and no provider call in this module (57-03 owns that).
 */

/** The currencies a version may be priced in. USD only until a local gateway exists (doc 57 §5). */
export const PLAN_CURRENCIES = ['USD'] as const;
export type PlanCurrency = (typeof PLAN_CURRENCIES)[number];

/** A stored currency read as a supported one (USD when unknown). */
export function readPlanCurrency(value: unknown): PlanCurrency {
  return (PLAN_CURRENCIES as readonly unknown[]).includes(value) ? (value as PlanCurrency) : 'USD';
}

/** The largest price a version may carry, in cents ($100,000 a month or year): a typo guard. */
export const MAX_PLAN_PRICE_CENTS = 10_000_000;

/** The largest limit a version may carry for people or active projects. */
const MAX_COUNT_LIMIT = 1_000_000;

/** The largest storage allowance a version may carry: 100 TiB. */
const MAX_STORAGE_BYTES = 100 * 1024 ** 4;

/** One published version of one plan. */
export interface PlanVersion extends PlanVersionEntitlements {
  readonly id: string;
  readonly version: number;
  readonly currency: PlanCurrency;
  /** Integer cents; `null` is "quoted per contract" (Enterprise). */
  readonly monthlyCents: number | null;
  readonly yearlyCents: number | null;
  readonly effectiveFrom: Date;
}

/** What a Platform admin submits to publish a new version. The version number is the server's. */
export interface NewPlanVersion {
  readonly planId: CatalogPlanId;
  readonly currency: PlanCurrency;
  readonly monthlyCents: number | null;
  readonly yearlyCents: number | null;
  readonly limits: PlanLimits;
  readonly features: readonly PlanFeature[];
  readonly effectiveFrom: Date;
}

/** `PLAN_LADDER` — the ladder's own switch. Only an explicit `on` turns it on. */
export function planLadderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['PLAN_LADDER'] ?? '').trim().toLowerCase() === 'on';
}

/** The ladder decides entitlements only when its switch is on and billing is paid. */
export function planLadderActive(mode: BillingMode, env: NodeJS.ProcessEnv = process.env): boolean {
  return mode === 'paid' && planLadderEnabled(env);
}

/**
 * The version a subscription is pinned to; else (no row, or a pinned version that is not published
 * for this plan) the newest version in force at `at`. `null` when the plan has no version in force.
 */
export function versionForSubscription(
  versions: readonly PlanVersion[],
  planId: CatalogPlanId,
  pinned: number | null,
  at: Date,
): PlanVersion | null {
  const ofPlan = versions.filter((v) => v.planId === planId);
  const exact = pinned === null ? undefined : ofPlan.find((v) => v.version === pinned);
  if (exact) return exact;
  return ofPlan
    .filter((v) => v.effectiveFrom.getTime() <= at.getTime())
    .reduce<PlanVersion | null>((best, v) => (best && best.version > v.version ? best : v), null);
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'Check the plan version and try again.', [
    { field, message },
  ]);
}

function boundedInt(value: unknown, field: string, max: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(field, `a whole number from ${min} to ${max}`);
  }
  return value;
}

function priceOrNull(value: unknown, field: string): number | null {
  return value === null ? null : boundedInt(value, field, MAX_PLAN_PRICE_CENTS);
}

function countOrNull(value: unknown, field: string): number | null {
  return value === null ? null : boundedInt(value, field, MAX_COUNT_LIMIT);
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/** Validate a limits object (request body or stored `limits_json`). */
export function parsePlanLimits(value: unknown): PlanLimits {
  const limits = record(value);
  if (!limits) throw invalid('limits', 'an object');
  return {
    people: countOrNull(limits['people'], 'limits.people'),
    activeProjects: countOrNull(limits['activeProjects'], 'limits.activeProjects'),
    // 57-13r: absent or null = no allowance figure (Enterprise, by agreement).
    storageBytes:
      limits['storageBytes'] === undefined || limits['storageBytes'] === null
        ? null
        : boundedInt(limits['storageBytes'], 'limits.storageBytes', MAX_STORAGE_BYTES, 1),
    maxFileBytes: boundedInt(
      limits['maxFileBytes'],
      'limits.maxFileBytes',
      CONTRACT_MAX_SIZE_BYTES,
      1,
    ),
  };
}

/** Validate a features list: known features only, each once, in catalog order. */
export function parsePlanFeatures(value: unknown): readonly PlanFeature[] {
  if (
    !Array.isArray(value) ||
    value.some((f) => !(PLAN_FEATURES as readonly unknown[]).includes(f))
  ) {
    throw invalid('features', `a list of ${PLAN_FEATURES.join(', ')}`);
  }
  return PLAN_FEATURES.filter((f) => value.includes(f));
}

/**
 * Validate a Platform admin's new version. Prices and limits come from this body only after these
 * checks, and a version can never start in the past: an earlier date would silently re-price a
 * period that was already quoted.
 */
export function parseNewPlanVersion(
  body: Readonly<Record<string, unknown>>,
  now: Date,
): NewPlanVersion {
  const planId = body['planId'];
  if (!isPlanId(planId)) throw invalid('planId', 'a plan in the catalog');
  const currency = body['currency'] ?? 'USD';
  if (!(PLAN_CURRENCIES as readonly unknown[]).includes(currency)) {
    throw invalid('currency', PLAN_CURRENCIES.join(', '));
  }
  const raw = body['effectiveFrom'];
  const effectiveFrom = typeof raw === 'string' ? new Date(raw) : new Date(Number.NaN);
  if (Number.isNaN(effectiveFrom.getTime()) || effectiveFrom.getTime() < now.getTime()) {
    throw invalid('effectiveFrom', 'an ISO date and time from now on');
  }
  return {
    planId: canonicalPlanId(planId),
    currency: currency as PlanCurrency,
    monthlyCents: priceOrNull(body['monthlyCents'], 'monthlyCents'),
    yearlyCents: priceOrNull(body['yearlyCents'], 'yearlyCents'),
    limits: parsePlanLimits(body['limits']),
    features: parsePlanFeatures(body['features']),
    effectiveFrom,
  };
}
