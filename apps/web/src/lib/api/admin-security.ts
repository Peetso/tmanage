import type { ApiClient } from './client';

/**
 * Organization security settings (Administration module 18, x176).
 *
 * Wraps the admin-security API: read the organization's security posture (2FA enforcement + IP
 * allowlist, defaults if never set) and set it. The one exported response shape is
 * {@link SecuritySettingsView}, paired Exact with the API's `SecuritySettingsView` in the contracts
 * gate — the wire projection is the posture only and never echoes the tenant id.
 */

/** The organization's security posture. Paired Exact with the API. */
export interface SecuritySettingsView {
  readonly enforce2fa: boolean;
  readonly ipAllowlist: readonly string[];
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/security`;
}

/** Read the organization's security settings. */
export async function readSecuritySettings(
  client: ApiClient,
  organizationSlug: string,
): Promise<SecuritySettingsView> {
  const { data } = await client.request<SecuritySettingsView>({ path: base(organizationSlug) });
  return data;
}

/** Set the organization's security settings. Returns the stored posture after the write. */
export async function setSecuritySettings(
  client: ApiClient,
  organizationSlug: string,
  input: { enforce2fa: boolean; ipAllowlist: readonly string[] },
): Promise<SecuritySettingsView> {
  const { data } = await client.request<SecuritySettingsView>({
    method: 'PUT',
    path: base(organizationSlug),
    body: { enforce2fa: input.enforce2fa, ipAllowlist: input.ipAllowlist },
  });
  return data;
}

/**
 * Wave 9 S8 (F09/F12b): turn the company's two-step requirement on or off — the owner's choice.
 * Sends `enforce2fa` alone, so the stored trusted networks are kept. The generic settings route
 * refuses this key, so the Organization settings screen saves it here.
 */
export async function setTwoStepRequirement(
  client: ApiClient,
  organizationSlug: string,
  required: boolean,
): Promise<SecuritySettingsView> {
  const { data } = await client.request<SecuritySettingsView>({
    method: 'PUT',
    path: base(organizationSlug),
    body: { enforce2fa: required },
  });
  return data;
}
