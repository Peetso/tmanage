import type { ApiClient } from './client';

/**
 * Custom role clone + edit (Administration module 18, x195).
 *
 * Wraps the two id-addressed role routes x195 adds on top of x173's create + list: clone an existing role
 * under a new name, and edit a role's name and capability subset in place. The one exported response
 * shape is {@link RoleEditView}, paired Exact with the API's `RoleEditView` in the contracts gate — the
 * wire projection is the single affected role and never echoes the tenant id. The privilege-escalation
 * boundary (a role may never grant beyond its author) lives entirely on the server; this client only
 * carries the request and the refusal back to the screen.
 */

/** The single role affected by a clone or an edit. Paired Exact with the API. */
export interface RoleEditView {
  readonly role: {
    readonly id: string;
    readonly name: string;
    readonly capabilities: readonly string[];
    readonly createdAt: string;
  };
}

function roleBase(organizationSlug: string, roleId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/roles/${encodeURIComponent(roleId)}`;
}

/** Clone an existing role under a new name (its capability subset is copied by the API). */
export async function cloneCustomRole(
  client: ApiClient,
  organizationSlug: string,
  roleId: string,
  input: { name: string },
): Promise<RoleEditView> {
  const { data } = await client.request<RoleEditView>({
    method: 'POST',
    path: `${roleBase(organizationSlug, roleId)}/clone`,
    body: { name: input.name },
  });
  return data;
}

/** Edit a role's name and capability subset in place. */
export async function editCustomRole(
  client: ApiClient,
  organizationSlug: string,
  roleId: string,
  input: { name: string; capabilities: readonly string[] },
): Promise<RoleEditView> {
  const { data } = await client.request<RoleEditView>({
    method: 'PATCH',
    path: roleBase(organizationSlug, roleId),
    body: { name: input.name, capabilities: input.capabilities },
  });
  return data;
}
