import type { ApiClient } from './client';

/**
 * The org-wide adoption endpoint — INS-06, the org-level counterpart to INS-05's per-project
 * workload roll-up. Behind `work.read` on the server (the internal-read capability the sibling
 * insights reads reuse); a caller without it gets the ordinary 403 the shared client turns into an
 * error, and an over-wide `days` window gets a 400.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the slug in the path
 * resolved against the caller's membership, never a value the caller supplies; the counts are
 * tenant-scoped in SQL and re-checked on the server, so this never returns another tenant's numbers.
 */

/**
 * The adoption roll-up. `activeMembers` is the studio's current active memberships; `membersWithWork`
 * is the distinct people who created any work in the window; `meetingsHeld` is the meetings held in
 * it; `windowDays` echoes the clamped window the counts were computed over.
 */
export interface InsightsAdoptionView {
  readonly windowDays: number;
  readonly activeMembers: number;
  readonly membersWithWork: number;
  readonly meetingsHeld: number;
  readonly computedAt: string;
}

export async function fetchOrgAdoption(
  client: ApiClient,
  organizationSlug: string,
  options: { days?: number } = {},
): Promise<InsightsAdoptionView> {
  const query = options.days === undefined ? '' : `?days=${encodeURIComponent(options.days)}`;
  const { data } = await client.request<InsightsAdoptionView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/adoption${query}`,
  });
  return data;
}
