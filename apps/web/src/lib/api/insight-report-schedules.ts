import type { ApiClient } from './client';

/**
 * INS report schedules (module 15, x228) — a member's own recurring insights-report definitions,
 * created, listed and deleted. All behind `work.read` on the server (the internal-read capability the
 * sibling insights reads reuse); a caller without it gets the ordinary 403 the shared client turns
 * into an error. The tenant is the slug in the path resolved against the caller's membership, and the
 * *owner* is the authenticated principal — never a value this client supplies — so it can only ever
 * read, create or remove the caller's own schedules.
 *
 * Definition only: the server records when a report is next due (`nextRunAt`) but there is no
 * dispatcher and no delivery in this slice.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** The closed vocabulary of insights reports a schedule may name. Mirrors the API's `INSIGHT_REPORT_KINDS`. */
export const INSIGHT_REPORT_KINDS = [
  'portfolio',
  'delivery-flow',
  'approval-cycle',
  'workload',
  'adoption',
  'forecast',
] as const;
export type InsightReportKind = (typeof INSIGHT_REPORT_KINDS)[number];

/** The cadences a schedule may repeat on. Mirrors the API's `INSIGHT_REPORT_CADENCES`. */
export const INSIGHT_REPORT_CADENCES = ['daily', 'weekly'] as const;
export type InsightReportCadence = (typeof INSIGHT_REPORT_CADENCES)[number];

/** A scheduled insights report as the screen reads it. Paired Exact with the API's `ReportScheduleView`. */
export interface ReportScheduleView {
  readonly id: string;
  readonly ownerUserId: string;
  readonly reportKey: InsightReportKind;
  readonly cadence: InsightReportCadence;
  readonly hour: number;
  readonly dayOfWeek: number | null;
  readonly nextRunAt: string;
  readonly createdAt: string;
}

/** The editable fields a create sends. A request shape (suffix `Input`), not a response. */
export interface ReportScheduleInput {
  readonly reportKey: InsightReportKind;
  readonly cadence: InsightReportCadence;
  readonly hour: number;
  readonly dayOfWeek?: number | null;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/report-schedules`;
}

export async function listInsightReportSchedules(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ReportScheduleView[]> {
  const { data } = await client.request<{ schedules: readonly ReportScheduleView[] }>({
    path: base(organizationSlug),
  });
  return data.schedules;
}

export async function createInsightReportSchedule(
  client: ApiClient,
  organizationSlug: string,
  input: ReportScheduleInput,
): Promise<ReportScheduleView> {
  const { data } = await client.request<ReportScheduleView>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

export async function deleteInsightReportSchedule(
  client: ApiClient,
  organizationSlug: string,
  scheduleId: string,
): Promise<readonly ReportScheduleView[]> {
  const { data } = await client.request<{ schedules: readonly ReportScheduleView[] }>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(scheduleId)}`,
  });
  return data.schedules;
}
