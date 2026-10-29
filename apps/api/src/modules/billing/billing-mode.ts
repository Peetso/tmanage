import { ApiError } from '../../common/http/errors.js';
import { PLAN_FEATURE_SET, PLAN_IDS, PLAN_LIMITS } from './plan-catalog.js';
import type { CatalogPlanId, PlanFeature, PlanLimits } from './plan-catalog.js';
import { platformSettingsReader } from './platform-settings-reader.js';
import type { PlatformSettingsReader } from './platform-settings-reader.js';

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
 *
 * platform-admin v2 · PA-07 (SPEC §7 item 10): the Platform admin's `platform_settings.billing_mode`
 * row wins over the environment once the process has a settings reader (30 s cache,
 * `platform-settings-reader.ts`); the environment stays the default when no row exists. One
 * organization can be pinned to a mode with `organizations.billing_mode_override`
 * ({@link effectiveBillingMode}), and `organization_limits` overrides the plan's limits
 * ({@link entitlementsFor}'s third argument).
 */
export const BILLING_MODES = ['beta_free', 'paid'] as const;

export type BillingMode = (typeof BILLING_MODES)[number];

export const DEFAULT_BILLING_MODE: BillingMode = 'beta_free';

/** Parse a raw `BILLING_MODE` value. Only an explicit `paid` turns billing on. */
export function parseBillingMode(raw: string | undefined): BillingMode {
  return (raw ?? '').trim().toLowerCase() === 'paid' ? 'paid' : DEFAULT_BILLING_MODE;
}

/** The `platform_settings` key the Platform admin's billing-mode switch writes (PA-10). */
export const BILLING_MODE_SETTING_KEY = 'billing_mode';

/** A stored value when it names a mode exactly; anything else is "no setting". */
function storedMode(value: string | null | undefined): BillingMode | null {
  const trimmed = (value ?? '').trim().toLowerCase();
  return (BILLING_MODES as readonly string[]).includes(trimmed) ? (trimmed as BillingMode) : null;
}

/**
 * The deployment's billing mode: the platform setting when the process has read one (cached
 * 30 s, synchronous — a stale value refreshes in the background), else `BILLING_MODE`.
 */
export function billingMode(
  env: NodeJS.ProcessEnv = process.env,
  reader: PlatformSettingsReader | null = platformSettingsReader(),
): BillingMode {
  return (
    storedMode(reader?.peek(BILLING_MODE_SETTING_KEY)) ?? parseBillingMode(env['BILLING_MODE'])
  );
}

/** {@link billingMode}, waiting for the platform setting when the cache is cold or stale. */
export async function resolveBillingMode(
  env: NodeJS.ProcessEnv = process.env,
  reader: PlatformSettingsReader | null = platformSettingsReader(),
): Promise<BillingMode> {
  const stored = reader ? storedMode(await reader.get(BILLING_MODE_SETTING_KEY)) : null;
  return stored ?? parseBillingMode(env['BILLING_MODE']);
}

/** The per-organization override values (`organizations.billing_mode_override`, 0243). */
export const BILLING_MODE_OVERRIDES = ['inherit', ...BILLING_MODES] as const;
export type BillingModeOverride = (typeof BILLING_MODE_OVERRIDES)[number];

/** Read a stored override: `null`, empty or unknown is "inherit". */
export function parseBillingModeOverride(raw: unknown): BillingMode | null {
  return typeof raw === 'string' ? storedMode(raw) : null;
}

/** One organization's mode: its own override when set, else the platform's. */
export function effectiveBillingMode(
  platform: BillingMode,
  override: BillingMode | string | null | undefined,
): BillingMode {
  return parseBillingModeOverride(override) ?? platform;
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
 * PA-07 (0243 `organization_limits`). An organization's explicit limits; `null` in a field means
 * "the plan's value". Storage is in bytes.
 */
export interface OrganizationLimitOverrides {
  readonly people: number | null;
  readonly activeProjects: number | null;
  readonly storageBytes: number | null;
}

/** Merge overrides over plan limits: a set override wins, a `null` keeps the plan's value. */
export function mergeLimits(
  plan: PlanLimits,
  overrides: OrganizationLimitOverrides | null | undefined,
): PlanLimits {
  if (!overrides) return plan;
  return {
    people: overrides.people ?? plan.people,
    activeProjects: overrides.activeProjects ?? plan.activeProjects,
    storageBytes: overrides.storageBytes ?? plan.storageBytes,
  };
}

/**
 * The one place a plan's entitlements are decided. In `beta_free` every organization, whatever plan
 * it is stored on, gets the top plan's; in `paid` it gets its own. PA-07: the organization's own
 * `organization_limits` row, when given, wins over the plan field by field. (Pass the mode through
 * {@link effectiveBillingMode} to honour a per-organization override.)
 */
export function entitlementsFor(
  storedPlanId: CatalogPlanId,
  mode: BillingMode = billingMode(),
  overrides?: OrganizationLimitOverrides | null,
): Entitlements {
  const planId = mode === 'beta_free' ? TOP_PLAN_ID : storedPlanId;
  return {
    planId,
    limits: mergeLimits(PLAN_LIMITS[planId], overrides),
    features: PLAN_FEATURE_SET[planId],
  };
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
