import type { WorkItemState } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * WK-04 Work views — the timeline read.
 *
 * A read-only composition the API serves at `GET .../work-views/timeline/:projectId`, behind the
 * same `work.read` capability as the work list. There is no write here and no request body: the
 * only input is the project id in the path.
 */

/**
 * One row of the accessible timeline. Deliberately **not** exported as its own interface: the
 * contracts gate enumerates every exported response shape in this folder, and the timeline is a
 * single paired response (`WorkTimelineView`). The screen reaches a row through
 * {@link WorkTimelineRow} instead, which is an indexed access, not a second projection.
 */
interface WorkTimelineItem {
  readonly id: string;
  readonly title: string;
  readonly state: WorkItemState;
  readonly startAt: string | null;
  readonly dueAt: string | null;
  /** The ids of the predecessors this caller may read; a redacted edge is absent, not named. */
  readonly predecessorIds: readonly string[];
}

/** The timeline read's response — paired Exact with the API's `WorkTimelineView` in the contracts gate. */
export interface WorkTimelineView {
  readonly projectId: string;
  readonly items: readonly WorkTimelineItem[];
}

/** One timeline row, for the screen — an indexed access, so it is not a second enumerated shape. */
export type WorkTimelineRow = WorkTimelineView['items'][number];

export async function getWorkTimeline(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<WorkTimelineView> {
  const { data } = await client.request<WorkTimelineView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-views/timeline/${encodeURIComponent(projectId)}`,
  });
  return data;
}

/**
 * WK-05 Work calendar — the calendar read.
 *
 * A read-only composition the API serves at `GET .../work-views/calendar/:projectId?from&to`,
 * behind the same `work.read` capability as the work list and timeline. The only inputs are the
 * project id in the path and the required `from`/`to` days in the query — there is no body.
 */

/**
 * One item on the calendar. Not exported: the contracts gate enumerates every exported response
 * shape in this folder, and the calendar is a single paired response (`WorkCalendarView`). The
 * screen reaches a day and its items through indexed access, not a second projection.
 */
interface WorkCalendarItem {
  readonly id: string;
  readonly title: string;
  readonly state: WorkItemState;
  readonly startAt: string | null;
  readonly dueAt: string | null;
}

/** One day cell: its `YYYY-MM-DD` date and the items anchored on it. Not exported (see above). */
interface WorkCalendarDay {
  readonly date: string;
  readonly items: readonly WorkCalendarItem[];
}

/** The requested range, echoed by the API. Not exported (see above). */
interface WorkCalendarRange {
  readonly from: string;
  readonly to: string;
}

/** The calendar read's response — paired Exact with the API's `WorkCalendarView` in the contracts gate. */
export interface WorkCalendarView {
  readonly projectId: string;
  readonly range: WorkCalendarRange;
  readonly days: readonly WorkCalendarDay[];
}

/** One calendar day, for the screen — an indexed access, so it is not a second enumerated shape. */
export type WorkCalendarDayRow = WorkCalendarView['days'][number];

export interface WorkCalendarRangeInput {
  readonly from: string;
  readonly to: string;
}

export async function getWorkCalendar(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  range: WorkCalendarRangeInput,
): Promise<WorkCalendarView> {
  const parameters = new URLSearchParams({ from: range.from, to: range.to });
  const { data } = await client.request<WorkCalendarView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-views/calendar/${encodeURIComponent(projectId)}?${parameters.toString()}`,
  });
  return data;
}
