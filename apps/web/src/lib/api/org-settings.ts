import type { ApiClient } from './client';

/**
 * Organization settings / policy (Administration module 18, x153).
 *
 * Wraps the org-settings API: read the organization's settings (every allowlisted key with its stored
 * value or its default) and set one key. The one exported response shape is {@link OrgSettingsView},
 * paired Exact with the API's `OrgSettingsView` in the contracts gate — the wire projection is a flat
 * list of `{ key, value }` entries and never echoes the tenant id.
 */

/** The organization's settings — every allowlisted key with its current value. Paired Exact with the API. */
export interface OrgSettingsView {
  readonly settings: readonly {
    readonly key: string;
    readonly value: string;
  }[];
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/settings`;
}

/** Read the organization's settings. */
export async function readOrgSettings(
  client: ApiClient,
  organizationSlug: string,
): Promise<OrgSettingsView> {
  const { data } = await client.request<OrgSettingsView>({ path: base(organizationSlug) });
  return data;
}

/** Set one allowlisted setting key. Returns the full settings after the write. */
export async function setOrgSetting(
  client: ApiClient,
  organizationSlug: string,
  key: string,
  value: string,
): Promise<OrgSettingsView> {
  const { data } = await client.request<OrgSettingsView>({
    method: 'PUT',
    path: `${base(organizationSlug)}/${encodeURIComponent(key)}`,
    body: { value },
  });
  return data;
}
