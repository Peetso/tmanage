import type { ApiClient } from './client';

/**
 * The per-member profile endpoint — x169, the detail counterpart to x168's people directory. Behind
 * `work.read` on the server (the internal-read capability the directory and the sibling insights
 * reads reuse); a caller without it gets the ordinary 403 the shared client turns into an error, and
 * a cross-tenant or unknown membership id gets a 404.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the slug in the path
 * resolved against the caller's membership, never a value the caller supplies; the membership is
 * resolved tenant-scoped on the server, so this never returns another tenant's member.
 */

/**
 * One project the member belongs to — id, name, the project's status, and the member's project role.
 * Module-private: it is the element type of {@link PersonProfileView.projects}, paired through its
 * parent rather than as a response projection of its own (the sibling forecast client does the same
 * with its per-week row).
 */
interface PersonProfileProjectRow {
  readonly projectId: string;
  readonly name: string;
  readonly status: string;
  readonly role: string;
}

/**
 * The member's profile. `displayName`, `role` and `status` are the non-sensitive header; `projects`
 * is the member's project memberships; `openWorkCount` is how much open work they own; `computedAt`
 * echoes when it was read.
 */
export interface PersonProfileView {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
  readonly projects: readonly PersonProfileProjectRow[];
  readonly openWorkCount: number;
  readonly computedAt: string;
}

export async function fetchPersonProfile(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
): Promise<PersonProfileView> {
  const { data } = await client.request<PersonProfileView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/people/${encodeURIComponent(
      membershipId,
    )}`,
  });
  return data;
}
