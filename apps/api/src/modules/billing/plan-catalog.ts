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

/** One gibibyte, the unit the storage allowances are counted in (the same 1024 scale the UI uses). */
const GB = 1024 ** 3;
/** One mebibyte, for the per-file caps (56-06). */
const MB = 1024 ** 2;

/**
 * What each flat plan allows — Figma F4 (390:22381) "Plan and usage". `null` is "no limit". People
 * and active projects follow the A12 flat plans (the public pricing page). Storage is the
 * temporary allowance on TManage before Drive/OneDrive is connected (57-13r, plan 57 §19.3: 1 GB
 * Free, 5 GB Starter, 10 GB Studio, 25 GB Business; Enterprise by agreement = null, so the
 * platform cap applies). Never sold. Clients are never limited and never billed, so they have no
 * entry here. Mirrors the `plan_versions` version-1 rows (0351, corrected by 0369).
 */
export interface PlanLimits {
  readonly people: number | null;
  readonly activeProjects: number | null;
  /** The temporary allowance in bytes; null = no plan figure (Enterprise, by agreement). */
  readonly storageBytes: number | null;
  /**
   * 56-06 (R19-e). The largest single file this plan accepts. Never above the upload contract's
   * 5 GiB ceiling (`CONTRACT_MAX_SIZE_BYTES`); `planMaxFileBytes` in `files/file-safety.ts` reads it
   * from this table. Optional only so a merged entitlement (`mergeLimits`) need not carry it.
   */
  readonly maxFileBytes?: number;
}

export const PLAN_LIMITS: Readonly<Record<CatalogPlanId, PlanLimits>> = {
  free: { people: 3, activeProjects: 3, storageBytes: GB, maxFileBytes: 25 * MB },
  starter: { people: 10, activeProjects: null, storageBytes: 5 * GB, maxFileBytes: 250 * MB },
  studio: { people: null, activeProjects: null, storageBytes: 10 * GB, maxFileBytes: GB },
  business: { people: null, activeProjects: null, storageBytes: 25 * GB, maxFileBytes: 2 * GB },
  enterprise: { people: null, activeProjects: null, storageBytes: null, maxFileBytes: 5 * GB },
};

/** The plan features a change can switch on or off, in the order the preview lists gains. */
export const PLAN_FEATURES = [
  'requests_approvals',
  'client_portal',
  'docs_decisions',
  'insights_automations',
  'security_controls',
  'admin_audit',
] as const;

export type PlanFeature = (typeof PLAN_FEATURES)[number];

/**
 * 57-18 (plan 57 §19.1). Security controls (IP allowlist, session policies) and the admin
 * console, custom roles and audit log with its CSV export are on EVERY plan, Free included; the
 * keys stay so a future Enterprise-only control can be added honestly.
 */
const EVERY_PLAN: readonly PlanFeature[] = ['security_controls', 'admin_audit'];

/** The features each plan includes, cumulative up the ladder (the public pricing bullets). */
export const PLAN_FEATURE_SET: Readonly<Record<CatalogPlanId, readonly PlanFeature[]>> = {
  free: [...EVERY_PLAN],
  starter: ['requests_approvals', 'client_portal', ...EVERY_PLAN],
  studio: [
    'requests_approvals',
    'client_portal',
    'docs_decisions',
    'insights_automations',
    ...EVERY_PLAN,
  ],
  business: [...PLAN_FEATURES],
  enterprise: [...PLAN_FEATURES],
};
