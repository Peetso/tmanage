import type { ApiClient } from './client';

/**
 * Custom roles (Administration module 18, x173).
 *
 * Wraps the admin roles API: list the organization's custom roles and define a new one (a name plus a
 * subset of the fixed capability allowlist). The one exported response shape is {@link CustomRoleView},
 * paired Exact with the API's `CustomRoleView` in the contracts gate — the wire projection is a flat
 * list of roles and never echoes the tenant id.
 */

/** The organization's custom roles — each with its capability subset. Paired Exact with the API. */
export interface CustomRoleView {
  readonly roles: readonly {
    readonly id: string;
    readonly name: string;
    readonly capabilities: readonly string[];
    readonly createdAt: string;
  }[];
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/roles`;
}

/** List the organization's custom roles. */
export async function readCustomRoles(
  client: ApiClient,
  organizationSlug: string,
): Promise<CustomRoleView> {
  const { data } = await client.request<CustomRoleView>({ path: base(organizationSlug) });
  return data;
}

/** Define a new custom role. Returns the full role list after the write. */
export async function createCustomRole(
  client: ApiClient,
  organizationSlug: string,
  input: { name: string; capabilities: readonly string[] },
): Promise<CustomRoleView> {
  const { data } = await client.request<CustomRoleView>({
    method: 'POST',
    path: base(organizationSlug),
    body: { name: input.name, capabilities: input.capabilities },
  });
  return data;
}
