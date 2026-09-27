import type { ApiClient } from './client';

/**
 * Admin bulk role assignment (Administration module 18, x222).
 *
 * Wraps the one route x222 adds on top of the roles surface (x173 create + list, x195 clone + edit):
 * assign an existing custom role to many memberships in a single bounded batch. The one exported response
 * shape is {@link MemberBulkRoleView}, paired Exact with the API's `MemberBulkRoleView` in the contracts
 * gate — a per-id outcome that never echoes the tenant id. The privilege-escalation boundary (a bulk
 * assign may never hand out a role beyond the caller) and the tenant scoping (a foreign membership id is
 * reported not-found, never written) live entirely on the server; this client only carries the request
 * and the per-id result back to the screen.
 */

/** One requested membership's outcome. Paired Exact with the API. */
export interface MemberBulkRoleView {
  readonly roleId: string;
  readonly assignments: readonly {
    readonly membershipId: string;
    readonly outcome: 'assigned' | 'not_found';
  }[];
}

/** The request body: the role to assign and the memberships to assign it to. */
export interface BulkAssignRoleInput {
  readonly roleId: string;
  readonly membershipIds: readonly string[];
}

/** Assign one custom role to a batch of memberships. */
export async function bulkAssignRole(
  client: ApiClient,
  organizationSlug: string,
  input: BulkAssignRoleInput,
): Promise<MemberBulkRoleView> {
  const { data } = await client.request<MemberBulkRoleView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/members/bulk-role`,
    body: { roleId: input.roleId, membershipIds: input.membershipIds },
  });
  return data;
}
