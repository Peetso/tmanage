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

/** A11 — the "What members can do" switches, in the card's order. */
export const MEMBER_SWITCH_KEYS = [
  'members_can_create_projects',
  'members_can_invite_clients',
  'clients_can_upload_files',
  'require_two_step',
] as const;

export type MemberSwitchKey = (typeof MEMBER_SWITCH_KEYS)[number];

/** The defaults the API holds for each switch (no row written yet). */
export const MEMBER_SWITCH_DEFAULTS: Readonly<Record<MemberSwitchKey, boolean>> = {
  members_can_create_projects: true,
  members_can_invite_clients: true,
  clients_can_upload_files: true,
  require_two_step: false,
};

/** Each switch's on/off state from a settings read; a key the read lacks keeps its default. */
export function memberSwitches(
  view: OrgSettingsView | undefined,
): Record<MemberSwitchKey, boolean> {
  const values = new Map((view?.settings ?? []).map((entry) => [entry.key, entry.value]));
  const result = { ...MEMBER_SWITCH_DEFAULTS };
  for (const key of MEMBER_SWITCH_KEYS) {
    const value = values.get(key);
    if (value === 'true' || value === 'false') result[key] = value === 'true';
  }
  return result;
}
