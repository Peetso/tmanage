import type { ApiClient } from './client';

/**
 * The org-wide workload endpoint — INS-05, the portfolio counterpart to INS-01/02's per-project
 * delivery-flow and approval-cycle reads. Behind `work.read` on the server (the internal-read
 * capability the delivery-flow read reuses); a caller without it gets the ordinary 403 the shared
 * client turns into an error.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the slug in the path
 * resolved against the caller's membership, never a value the caller supplies; the roll-up spans the
 * projects that principal may read — a non-org-wide caller sees only the projects they are on, and a
 * cross-tenant project never contributes (tenant-scoped in SQL, re-checked per project on the
 * server), so this never returns another tenant's numbers and never a 500.
 */

/**
 * One project's row in the roll-up. `openItemCount` is the open work the caller may read;
 * `scheduledItemCount` is the part of it on the calendar (a start or due date); `assigneeCount` is
 * the distinct people carrying that open work — the project's capacity in use. Not exported directly
 * (it is the element type of {@link InsightsWorkloadView.projects}); re-exported below as an
 * indexed-access alias so the screen can name it without a second response type for the check to
 * demand its own pair.
 */
interface WorkloadProjectRow {
  readonly projectId: string;
  readonly openItemCount: number;
  readonly scheduledItemCount: number;
  readonly assigneeCount: number;
}

/**
 * The aggregate across the rolled-up projects. `projectCount` is how many contributed;
 * `assigneeCount` is the distinct people carrying open work anywhere in the set (counted once);
 * the two item counts sum the per-project figures.
 */
interface WorkloadTotalsRow {
  readonly projectCount: number;
  readonly assigneeCount: number;
  readonly openItemCount: number;
  readonly scheduledItemCount: number;
}

export interface InsightsWorkloadView {
  readonly projects: readonly WorkloadProjectRow[];
  readonly totals: WorkloadTotalsRow;
  readonly computedAt: string;
}

/** One project's row, named for the screen — the element type of {@link InsightsWorkloadView.projects}. */
export type InsightsWorkloadProject = InsightsWorkloadView['projects'][number];
/** The aggregate, named for the screen — the value type of {@link InsightsWorkloadView.totals}. */
export type InsightsWorkloadTotals = InsightsWorkloadView['totals'];

export async function fetchOrgWorkload(
  client: ApiClient,
  organizationSlug: string,
  options: { limit?: number } = {},
): Promise<InsightsWorkloadView> {
  const query = options.limit === undefined ? '' : `?limit=${encodeURIComponent(options.limit)}`;
  const { data } = await client.request<InsightsWorkloadView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/workload${query}`,
  });
  return data;
}
