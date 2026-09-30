import type { ApiClient } from './client';

/**
 * INS custom reports (module 15, x320) — a member's own named, custom insight report: an ordered
 * selection of existing metric keys plus a layout hint, created, listed, read back rendered, replaced
 * and deleted. All behind `work.read` on the server (the internal-read capability the sibling insights
 * reads reuse); a caller without it gets the ordinary 403 the shared client turns into an error. The
 * tenant is the slug in the path resolved against the caller's membership, and the *owner* is the
 * authenticated principal — never a value this client supplies — so it can only ever read, create,
 * replace or remove the caller's own reports.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** The metric keys a custom report may compose — mirrors the API's closed allowlist. */
export const INSIGHT_CUSTOM_REPORT_METRICS = [
  'open_items',
  'scheduled_items',
  'active_projects',
  'active_assignees',
] as const;
export type InsightCustomReportMetric = (typeof INSIGHT_CUSTOM_REPORT_METRICS)[number];

/** How a custom report is laid out — mirrors the API's closed vocabulary. */
export const INSIGHT_CUSTOM_REPORT_LAYOUTS = ['list', 'grid'] as const;
export type InsightCustomReportLayout = (typeof INSIGHT_CUSTOM_REPORT_LAYOUTS)[number];

/** A custom report as the screen reads it. Paired Exact with the API's `InsightCustomReportView`. */
export interface InsightCustomReportView {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly metricKeys: readonly InsightCustomReportMetric[];
  readonly layout: InsightCustomReportLayout;
  readonly createdAt: string;
}

/**
 * A report with its metrics rendered against the current figures — the by-id read. Paired Exact with
 * the API's `InsightCustomReportRenderedView`.
 */
export interface InsightCustomReportRenderedView {
  readonly report: InsightCustomReportView;
  readonly metrics: readonly {
    readonly metric: InsightCustomReportMetric;
    readonly value: number;
  }[];
}

/** The editable fields a create/replace sends. A request shape (suffix `Input`), not a response. */
export interface InsightCustomReportInput {
  readonly name: string;
  readonly metricKeys: readonly InsightCustomReportMetric[];
  readonly layout: InsightCustomReportLayout;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/custom-reports`;
}

export async function listInsightCustomReports(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly InsightCustomReportView[]> {
  const { data } = await client.request<{ reports: readonly InsightCustomReportView[] }>({
    path: base(organizationSlug),
  });
  return data.reports;
}

export async function getInsightCustomReport(
  client: ApiClient,
  organizationSlug: string,
  reportId: string,
): Promise<InsightCustomReportRenderedView> {
  const { data } = await client.request<InsightCustomReportRenderedView>({
    path: `${base(organizationSlug)}/${encodeURIComponent(reportId)}`,
  });
  return data;
}

export async function createInsightCustomReport(
  client: ApiClient,
  organizationSlug: string,
  input: InsightCustomReportInput,
): Promise<InsightCustomReportView> {
  const { data } = await client.request<InsightCustomReportView>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

export async function replaceInsightCustomReport(
  client: ApiClient,
  organizationSlug: string,
  reportId: string,
  input: InsightCustomReportInput,
): Promise<InsightCustomReportView> {
  const { data } = await client.request<InsightCustomReportView>({
    method: 'PUT',
    path: `${base(organizationSlug)}/${encodeURIComponent(reportId)}`,
    body: input,
  });
  return data;
}

export async function deleteInsightCustomReport(
  client: ApiClient,
  organizationSlug: string,
  reportId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(reportId)}`,
  });
}
