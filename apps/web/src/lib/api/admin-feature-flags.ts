import type { ApiClient } from './client';

/**
 * Per-org optional-module feature flags (Administration module 18, x278) — the admin surface that
 * lists and toggles optional modules, and the resolved flag map the caller's own org read-side reads.
 *
 * The admin routes (`GET`/`PUT …/admin/feature-flags`) are behind `org.manage`; the resolved read
 * (`GET …/feature-flags`) is behind `work.read`. A caller without the capability gets the ordinary
 * 403 the shared client turns into an error. The tenant is the slug in the path resolved against the
 * caller's membership, and every write names a key from the fixed allowlist below — so the two ends
 * can only ever read or change this studio's own configuration.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired Exact with the API projections
 * so the two shapes cannot drift.
 */

/** The closed set of optional-module flag keys the API accepts; every toggle names one of these. */
export const OPTIONAL_MODULE_FLAGS = [
  'chat',
  'meetings',
  'docs',
  'people',
  'insights',
  'automations',
  'client_portal',
  'billing',
  'copilot',
] as const;
export type OptionalModuleFlag = (typeof OPTIONAL_MODULE_FLAGS)[number];

/** One flag's admin projection: its key, enabled state, and who/when last changed it. */
export interface FeatureFlagAdminView {
  readonly key: OptionalModuleFlag;
  readonly enabled: boolean;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

/** The admin list of every known optional-module flag. Paired Exact with the API view. */
export interface FeatureFlagsAdminView {
  readonly flags: readonly FeatureFlagAdminView[];
}

/** The resolved flag map for the caller's own org: every known key with its resolved state. */
export interface FeatureFlagsResolvedView {
  readonly flags: Record<OptionalModuleFlag, boolean>;
}

function adminPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/feature-flags`;
}

export async function listFeatureFlags(
  client: ApiClient,
  organizationSlug: string,
): Promise<FeatureFlagsAdminView> {
  const { data } = await client.request<FeatureFlagsAdminView>({
    path: adminPath(organizationSlug),
  });
  return data;
}

export async function setFeatureFlag(
  client: ApiClient,
  organizationSlug: string,
  key: OptionalModuleFlag,
  enabled: boolean,
): Promise<FeatureFlagAdminView> {
  const { data } = await client.request<FeatureFlagAdminView>({
    method: 'PUT',
    path: `${adminPath(organizationSlug)}/${encodeURIComponent(key)}`,
    body: { enabled },
  });
  return data;
}

export async function getResolvedFeatureFlags(
  client: ApiClient,
  organizationSlug: string,
): Promise<FeatureFlagsResolvedView> {
  const { data } = await client.request<FeatureFlagsResolvedView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/feature-flags`,
  });
  return data;
}
