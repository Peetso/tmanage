import type { ApiClient } from './client';

/**
 * CAL per-occurrence override (x213) — the per-occurrence exception client for a recurring series.
 *
 * A recurring series (`meeting-series`) expands its occurrences on read; this decorates one of those
 * occurrence dates with an exception served at
 * `.../meeting-series/:seriesId/occurrences/:date`: `GET` reads the override behind `meeting.read`,
 * `POST` upserts it behind `meeting.write`, and `DELETE` removes it behind `meeting.write`, restoring
 * the base rule for that date. A series names no project — unlike a meeting — so nothing here carries
 * a `projectId`.
 */

export const MEETING_OCCURRENCE_OVERRIDE_STATUSES = ['moved', 'cancelled'] as const;
export type MeetingOccurrenceOverrideStatus = (typeof MEETING_OCCURRENCE_OVERRIDE_STATUSES)[number];

/**
 * One override, as the control reads it. Paired `Exact` with the API's `OccurrenceOverrideView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`): rename or retype a field on either side and
 * `pnpm contracts:check` fails. `organizationId` is deliberately absent — it is never echoed into a
 * response body (`25-AUTH-AND-TENANT-ISOLATION` §7).
 */
export interface OccurrenceOverrideView {
  readonly id: string;
  readonly seriesId: string;
  /** The original occurrence date being overridden, `YYYY-MM-DD`. */
  readonly occurrenceDate: string;
  readonly status: MeetingOccurrenceOverrideStatus;
  /** For a `moved` override: the new calendar date, `YYYY-MM-DD`, else `null`. */
  readonly newDate: string | null;
  /** For a `moved` override: an optional new time-of-day, `HH:MM:SS`, else `null`. */
  readonly newStartTime: string | null;
  /** For a `moved` override: an optional new title, else `null`. */
  readonly newTitle: string | null;
  readonly createdByUserId: string;
  /** ISO-8601 instants on the wire. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What the upsert form sends. A request body, not a paired projection (dropped by the `Input` suffix). */
export interface UpsertOccurrenceOverrideInput {
  readonly status: MeetingOccurrenceOverrideStatus;
  /** `YYYY-MM-DD`, or omitted/`null`. Only meaningful for a `moved` override. */
  readonly newDate?: string | null;
  /** `HH:MM` or `HH:MM:SS`, or omitted/`null`. Only meaningful for a `moved` override. */
  readonly newStartTime?: string | null;
  /** A new title, or omitted/`null`. Only meaningful for a `moved` override. */
  readonly newTitle?: string | null;
}

function overridePath(organizationSlug: string, seriesId: string, date: string): string {
  return (
    `/v1/organizations/${encodeURIComponent(organizationSlug)}` +
    `/meeting-series/${encodeURIComponent(seriesId)}/occurrences/${encodeURIComponent(date)}`
  );
}

/** Read the override for one occurrence date (behind `meeting.read`). 404 when there is none. */
export async function getOccurrenceOverride(
  client: ApiClient,
  organizationSlug: string,
  seriesId: string,
  date: string,
): Promise<OccurrenceOverrideView> {
  const { data } = await client.request<OccurrenceOverrideView>({
    path: overridePath(organizationSlug, seriesId, date),
  });
  return data;
}

/** Upsert the override for one occurrence date (behind `meeting.write`). Returns the stored override. */
export async function upsertOccurrenceOverride(
  client: ApiClient,
  organizationSlug: string,
  seriesId: string,
  date: string,
  input: UpsertOccurrenceOverrideInput,
): Promise<OccurrenceOverrideView> {
  const { data } = await client.request<OccurrenceOverrideView>({
    method: 'POST',
    path: overridePath(organizationSlug, seriesId, date),
    body: input,
  });
  return data;
}

/** Remove the override for one occurrence date (behind `meeting.write`), restoring the base rule. */
export async function removeOccurrenceOverride(
  client: ApiClient,
  organizationSlug: string,
  seriesId: string,
  date: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: overridePath(organizationSlug, seriesId, date),
  });
}
