import type { ApiClient } from './client';

/**
 * INS metric favorites (module 15, x303) — a member's own starred insight metrics, starred, listed and
 * unstarred. All behind `work.read` on the server (the internal-read capability the sibling insights
 * reads reuse); a caller without it gets the ordinary 403 the shared client turns into an error. The
 * tenant is the slug in the path resolved against the caller's membership, and the owner is the
 * authenticated principal — never a value this client supplies — so it can only ever read, star or
 * unstar the caller's own favorites.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** The closed vocabulary of insight metric ids a member may star. Mirrors the API's `INSIGHT_METRIC_KEYS`. */
export const INSIGHT_METRIC_KEYS = [
  'portfolio.projectCount',
  'portfolio.openItemCount',
  'deliveryFlow.itemCount',
  'approvalCycle.approvalCount',
  'workload.assigneeCount',
  'workload.openItemCount',
  'workload.scheduledItemCount',
  'adoption.activeMembers',
] as const;
export type InsightMetricKey = (typeof INSIGHT_METRIC_KEYS)[number];

/** One of the caller's starred metrics as the screen reads it. Paired Exact with the API's `MetricFavoriteView`. */
export interface MetricFavoriteSummary {
  readonly id: string;
  readonly metricKey: InsightMetricKey;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

function listBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/metric-favorites`;
}

function metricBase(organizationSlug: string, metricKey: InsightMetricKey): string {
  return `${listBase(organizationSlug)}/${encodeURIComponent(metricKey)}`;
}

/** List the caller's starred metrics, newest first. */
export async function listMetricFavorites(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly MetricFavoriteSummary[]> {
  const { data } = await client.request<{ favorites: readonly MetricFavoriteSummary[] }>({
    path: listBase(organizationSlug),
  });
  return data.favorites;
}

/** Star a metric for the caller. Idempotent: a repeated call returns the same summary. */
export async function addMetricFavorite(
  client: ApiClient,
  organizationSlug: string,
  metricKey: InsightMetricKey,
): Promise<MetricFavoriteSummary> {
  const { data } = await client.request<MetricFavoriteSummary>({
    method: 'PUT',
    path: metricBase(organizationSlug, metricKey),
  });
  return data;
}

/** Unstar a metric for the caller. Idempotent: no favorite is still success. */
export async function removeMetricFavorite(
  client: ApiClient,
  organizationSlug: string,
  metricKey: InsightMetricKey,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: metricBase(organizationSlug, metricKey),
  });
}
