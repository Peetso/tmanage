import type { ApiClient } from './client';
import type { DeliveryFlow } from './delivery-flow';
import type { ApprovalCycle } from './approval-cycle';

/**
 * The insights portfolio endpoint — INS-01, the org-level roll-up across the caller's accessible
 * projects. Behind `work.read` on the server; a caller without it gets the ordinary 403 the shared
 * client turns into an error. The tenant is the slug in the path resolved against the caller's
 * membership; a project the caller cannot read never appears in the roll-up, and cross-tenant never
 * resolves — the server excludes it silently rather than 500'ing.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift. `deliveryFlow`/`approvalCycle` are the
 * same per-project reads the per-project screens render, composed server-side — never a second
 * computation — so the index and the dashboards always agree.
 */

/** One project's headline insight figures in the roll-up. Not exported directly — see the alias. */
interface PortfolioProject {
  readonly projectId: string;
  readonly name: string;
  readonly deliveryFlow: DeliveryFlow;
  readonly approvalCycle: ApprovalCycle;
}

/**
 * The portfolio roll-up. `projects` is a bounded, id-ordered page of the projects the caller may
 * read; `projectCount` is the number of rows in this page, not the tenant's total. Computed on
 * demand, never stored.
 */
export interface InsightsPortfolio {
  readonly projects: readonly PortfolioProject[];
  readonly projectCount: number;
  readonly computedAt: string;
}

/** One roll-up row, named for the screen — the element type of {@link InsightsPortfolio.projects}. */
export type InsightsPortfolioProject = InsightsPortfolio['projects'][number];

/**
 * Read the roll-up. `projectIds` (A13, "Projects in this report") narrows it to those ids; the
 * server drops any the caller cannot read, so the filter only ever narrows. Empty means all.
 */
export async function fetchInsightsPortfolio(
  client: ApiClient,
  organizationSlug: string,
  projectIds: readonly string[] = [],
): Promise<InsightsPortfolio> {
  const query =
    projectIds.length > 0 ? `?projectIds=${projectIds.map(encodeURIComponent).join(',')}` : '';
  const { data } = await client.request<InsightsPortfolio>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/portfolio${query}`,
  });
  return data;
}
