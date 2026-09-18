import type { ApiClient } from './client';

/**
 * The member directory — D16, behind every field that used to ask for a user id.
 *
 * Tenant-scoped like `projects.ts`: the slug is in the path, the API resolves it against a
 * membership row before the handler runs, and a slug the caller has no membership in is
 * refused. The route needs `work.read`, which no client role holds, so the portal cannot
 * reach this list at all.
 */

export interface MemberSummary {
  /** What the API stores on a work item. Never typed by a person — see `MemberSelect`. */
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
}

/**
 * Every active member of this organization, by name.
 *
 * One page. The API's default is 50 and its ceiling is 200; a directory large enough to need
 * a second page needs a search parameter on the server rather than a client that walks the
 * whole roster into memory, and `nextAfter` is returned so the day that is true is visible
 * rather than silent.
 */
export async function listMembers(
  client: ApiClient,
  organizationSlug: string,
  options: { readonly limit?: number } = {},
): Promise<{ readonly members: readonly MemberSummary[]; readonly nextAfter: string | null }> {
  const query = options.limit === undefined ? '' : `?limit=${String(options.limit)}`;
  const { data } = await client.request<{
    members: readonly MemberSummary[];
    nextAfter: string | null;
  }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/members${query}`,
  });
  return data;
}
