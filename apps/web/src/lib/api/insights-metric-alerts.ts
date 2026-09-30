import type { ApiClient } from './client';

/**
 * The insight-metric-alert endpoints — x319, module 15 (Insights & reporting). A metric alert is a
 * member's own threshold on one insights metric (a comparator and a value), listed with a live
 * breached/ok mark against the latest workload snapshot (audit: insights are reported, snapshotted,
 * compared and given org-wide targets, but a member has no personal threshold alert). Config +
 * read-side evaluation only — no dispatch this slice.
 *
 * Every route is behind `work.read` on the server and self-scoped to the caller, so a member sees and
 * changes only their own alerts and a client gets the ordinary 403 the shared client turns into an
 * error. An unknown metric key or comparator, or a non-numeric threshold, is a 400; the tenant is the
 * slug in the path resolved against the caller's membership, never a value the caller supplies.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** The metrics an alert can watch — mirrors the API's closed vocabulary. */
export type MetricAlertMetric =
  'open_items' | 'scheduled_items' | 'active_projects' | 'active_assignees';

/** How the live figure is compared to the threshold — mirrors the API's closed vocabulary. */
export type MetricAlertComparator = 'gte' | 'lte';

/** One stored alert — the set projection. */
export interface MetricAlertView {
  readonly metricKey: MetricAlertMetric;
  readonly comparator: MetricAlertComparator;
  readonly threshold: number;
}

/**
 * An alert with its live evaluation against the latest workload snapshot. `currentValue` is the live
 * figure (null when no snapshot exists yet, so no fabricated number); `breached` is whether the
 * comparator/threshold is met by it.
 */
export interface MetricAlertStatusView {
  readonly metricKey: MetricAlertMetric;
  readonly comparator: MetricAlertComparator;
  readonly threshold: number;
  readonly currentValue: number | null;
  readonly breached: boolean;
}

/** Set the caller's alert for one metric (create or replace). Behind `work.read`, self-scoped. */
export async function setAlert(
  client: ApiClient,
  organizationSlug: string,
  alert: MetricAlertView,
): Promise<MetricAlertView> {
  const { data } = await client.request<MetricAlertView>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/metric-alerts`,
    body: alert,
  });
  return data;
}

/** List the caller's alerts, each marked breached/ok against the latest workload snapshot. */
export async function listAlerts(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly MetricAlertStatusView[]> {
  const { data } = await client.request<{ alerts: readonly MetricAlertStatusView[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/metric-alerts`,
  });
  return data.alerts;
}

/** Delete the caller's alert for one metric (204). Behind `work.read`, self-scoped. */
export async function deleteAlert(
  client: ApiClient,
  organizationSlug: string,
  metricKey: MetricAlertMetric,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/metric-alerts/${encodeURIComponent(metricKey)}`,
  });
}
