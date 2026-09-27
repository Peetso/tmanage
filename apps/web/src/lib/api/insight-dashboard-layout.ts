import type { ApiClient } from './client';

/**
 * Insight dashboard layout (module 16 Insights, x302) — the caller's own arrangement of the
 * insights-dashboard metric tiles, read and replaced. Behind `work.read` on the server (the
 * internal-read capability the Home widget prefs reuse); a caller without it gets the ordinary 403
 * the shared client turns into an error. The tenant is the slug in the path resolved against the
 * caller's membership, and the *member* is the authenticated principal — never a value this client
 * supplies — so it can only ever read or write the caller's own layout.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** The closed set of insight metric keys the API accepts; every saved tile key is validated against it. */
export const INSIGHT_METRIC_KEYS = [
  'portfolio',
  'deliveryFlow',
  'approvalCycle',
  'workload',
  'workloadForecast',
  'adoption',
  'snapshots',
  'savedViews',
] as const;
export type InsightMetricKey = (typeof INSIGHT_METRIC_KEYS)[number];

/**
 * One tile in the layout: the metric it shows, where it sits, and whether it is visible. Not exported
 * directly (it is the element type of {@link InsightDashboardLayoutView.tiles}); re-exported below as
 * an indexed-access alias so the screen can name it without a second response type for the check to
 * demand its own pair.
 */
interface InsightDashboardTile {
  readonly key: InsightMetricKey;
  readonly position: number;
  readonly visible: boolean;
}

/** The member's insight-dashboard layout the GET/PUT route exchanges. Paired Exact with the API view. */
export interface InsightDashboardLayoutView {
  readonly tiles: readonly InsightDashboardTile[];
}

/** One tile, named for the screen — the element type of {@link InsightDashboardLayoutView.tiles}. */
export type InsightDashboardTileEntry = InsightDashboardLayoutView['tiles'][number];

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/dashboard-layout`;
}

export async function getInsightDashboardLayout(
  client: ApiClient,
  organizationSlug: string,
): Promise<InsightDashboardLayoutView> {
  const { data } = await client.request<InsightDashboardLayoutView>({
    path: path(organizationSlug),
  });
  return data;
}

export async function updateInsightDashboardLayout(
  client: ApiClient,
  organizationSlug: string,
  layout: InsightDashboardLayoutView,
): Promise<InsightDashboardLayoutView> {
  const { data } = await client.request<InsightDashboardLayoutView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: layout,
  });
  return data;
}
