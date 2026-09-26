import type { ApiClient } from './client';

/**
 * CAL recurrence (x129) — the meeting-series list / create / occurrence-expand client.
 *
 * A meeting series is an org-scoped recurrence *rule* served at `.../meeting-series`: `GET` lists a
 * tenant's series behind `meeting.read`, `POST` creates one behind `meeting.write`, and
 * `GET .../:seriesId/occurrences?from&to` expands one series' occurrences in a bounded window (max
 * 90 days) behind `meeting.read`. A series names no project — unlike a meeting — so nothing here
 * carries a `projectId`.
 */

export const MEETING_SERIES_FREQS = ['daily', 'weekly', 'monthly'] as const;
export type MeetingSeriesFreq = (typeof MEETING_SERIES_FREQS)[number];

/**
 * One series, as the screen reads it. Paired `Exact` with the API's `MeetingSeriesView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`): rename or retype a field on either side and
 * `pnpm contracts:check` fails. `organizationId` is deliberately absent — it is never echoed into a
 * response body (`25-AUTH-AND-TENANT-ISOLATION` §7).
 */
export interface MeetingSeriesView {
  readonly id: string;
  readonly title: string;
  readonly freq: MeetingSeriesFreq;
  /** Every-N interval (a positive integer). */
  readonly interval: number;
  /** The last calendar date the series may recur on, `YYYY-MM-DD`, or `null` when open-ended. */
  readonly until: string | null;
  readonly createdByUserId: string;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

/** What the create form sends. A request body, like `CreateMeetingInput` — not a paired projection. */
export interface CreateMeetingSeriesInput {
  readonly title: string;
  readonly freq: MeetingSeriesFreq;
  readonly interval: number;
  /** `YYYY-MM-DD`, or omitted/`null` for an open-ended series. */
  readonly until?: string | null;
}

/** List a tenant's meeting series (behind `meeting.read`). */
export async function listMeetingSeries(
  client: ApiClient,
  organizationSlug: string,
): Promise<{ readonly series: readonly MeetingSeriesView[] }> {
  const { data } = await client.request<{ readonly series: readonly MeetingSeriesView[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meeting-series`,
  });
  return data;
}

/** Create a meeting series (behind `meeting.write`). Returns the created series (201). */
export async function createMeetingSeries(
  client: ApiClient,
  organizationSlug: string,
  input: CreateMeetingSeriesInput,
): Promise<MeetingSeriesView> {
  const { data } = await client.request<MeetingSeriesView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meeting-series`,
    body: input,
  });
  return data;
}

/**
 * Expand one series' occurrences in `[from, to]` (behind `meeting.read`). The dates are `YYYY-MM-DD`;
 * the API refuses a window wider than 90 days or a `to` before `from` (400). The occurrences are ISO
 * calendar-date strings, ascending.
 */
export async function listMeetingSeriesOccurrences(
  client: ApiClient,
  organizationSlug: string,
  seriesId: string,
  from: string,
  to: string,
): Promise<{ readonly seriesId: string; readonly occurrences: readonly string[] }> {
  const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const { data } = await client.request<{
    readonly seriesId: string;
    readonly occurrences: readonly string[];
  }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meeting-series/${encodeURIComponent(seriesId)}/occurrences?${query}`,
  });
  return data;
}
