import type { ApiClient } from './client';

/**
 * CAL week/month grid (x212) — the read-only calendar grid.
 *
 * A read-only composition the API serves at `GET .../meetings/grid?range=week|month&anchor=`, behind
 * the same `meeting.read` capability as the agenda. Unlike the agenda (which returns only the days
 * that carry a meeting), the grid returns every day of the window as a cell, so the screen can draw
 * the empty days a calendar has, and each cell carries both the concrete meetings and the recurrence
 * occurrences that fall on it.
 */

/** One concrete meeting in a grid cell. Not exported: the grid is one paired response shape. */
interface CalendarGridMeeting {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** An ISO-8601 instant on the wire. */
  readonly startsAt: string;
}

/** One recurrence occurrence in a grid cell — a series' rule falling on this day. Not exported. */
interface CalendarGridOccurrence {
  readonly seriesId: string;
  readonly title: string;
}

/** One grid cell: its `YYYY-MM-DD` day (UTC) and what falls on it. Not exported (see above). */
interface CalendarGridDay {
  readonly date: string;
  readonly meetings: readonly CalendarGridMeeting[];
  readonly occurrences: readonly CalendarGridOccurrence[];
}

/** The grid range the caller asks for. */
export type CalendarGridRange = 'week' | 'month';

/** The grid read's response — paired Exact with the API's `CalendarGridView` in the contracts gate. */
export interface CalendarGridView {
  readonly range: CalendarGridRange;
  readonly anchor: string;
  readonly from: string;
  readonly to: string;
  readonly days: readonly CalendarGridDay[];
}

/** One grid day, for the screen — an indexed access, so it is not a second enumerated shape. */
export type CalendarGridDayRow = CalendarGridView['days'][number];

export interface CalendarGridInput {
  readonly range: CalendarGridRange;
  readonly anchor: string;
}

export async function getCalendarGrid(
  client: ApiClient,
  organizationSlug: string,
  input: CalendarGridInput,
): Promise<CalendarGridView> {
  const parameters = new URLSearchParams({ range: input.range, anchor: input.anchor });
  const { data } = await client.request<CalendarGridView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/meetings/grid?${parameters.toString()}`,
  });
  return data;
}
