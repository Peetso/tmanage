import type { ApiClient } from './client';

/**
 * The insight-metric-target endpoints — x230, module 15 (Insights & reporting). A target is an
 * org-wide goal line per metric so a studio can measure a live figure against a goal (audit: insights
 * are reported and snapshotted, but there is no target to judge them against).
 *
 * Setting a target is behind `org.manage` on the server; reading targets and their status is behind
 * `work.read` (the internal-read capability the sibling insights reads reuse), so a viewer sees the
 * goals but cannot set them and gets the ordinary 403 the shared client turns into an error. An
 * unknown metric/period or an out-of-range value is a 400, and the tenant is the slug in the path
 * resolved against the caller's membership, never a value the caller supplies.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** The metrics a target can judge — mirrors the API's closed vocabulary. */
export type MetricTargetMetric =
  'open_items' | 'scheduled_items' | 'active_projects' | 'active_assignees';

/** The cadence a target applies to — mirrors the API's closed vocabulary. */
export type MetricTargetPeriod = 'weekly' | 'monthly' | 'quarterly';

/** Whether a live metric meets its target. */
export type MetricTargetStatus = 'on_track' | 'behind';

/** One stored target — the set/list projection. */
export interface MetricTargetView {
  readonly metric: MetricTargetMetric;
  readonly targetValue: number;
  readonly period: MetricTargetPeriod;
}

/**
 * A target with the live metric measured against it. `currentValue` is the live org-wide figure;
 * `attainment` is `currentValue / targetValue` (null when the target is zero, so no divide-by-zero);
 * `status` flags on-track / behind.
 */
export interface MetricTargetStatusView {
  readonly metric: MetricTargetMetric;
  readonly targetValue: number;
  readonly period: MetricTargetPeriod;
  readonly currentValue: number;
  readonly attainment: number | null;
  readonly status: MetricTargetStatus;
}

/** Set an org's target for one metric (create or replace). Behind `org.manage`. */
export async function setTarget(
  client: ApiClient,
  organizationSlug: string,
  target: MetricTargetView,
): Promise<MetricTargetView> {
  const { data } = await client.request<MetricTargetView>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/targets`,
    body: target,
  });
  return data;
}

/** List the org's targets, ordered by metric. Behind `work.read`. */
export async function listTargets(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly MetricTargetView[]> {
  const { data } = await client.request<readonly MetricTargetView[]>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/targets`,
  });
  return data;
}

/** Read each target's attainment against its live metric — on-track / behind. Behind `work.read`. */
export async function fetchTargetStatus(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly MetricTargetStatusView[]> {
  const { data } = await client.request<readonly MetricTargetStatusView[]>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/targets/status`,
  });
  return data;
}
