import type { MilestoneHealth, WorkItemState } from '@tmanage/domain';
import type { ApiClient } from './client';
import { ApiRequestError } from './errors';

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
  /** 53-06. Total float in working days at the last recompute; `null` without a stats row. */
  readonly floatDays?: number | null;
  /** 53-06. On the critical path at the last recompute. */
  readonly critical?: boolean;
  /** 53-03. The readable predecessor edges with their ids, so one can be removed. */
  readonly dependencies?: readonly WorkTimelineDependency[];
}

/** 53-03. One readable predecessor edge. Nested in the timeline response; not exported. */
interface WorkTimelineDependency {
  readonly id: string;
  readonly predecessorId: string;
}

/** 53-07. One phase band. Nested in the timeline response; not exported. */
interface WorkTimelinePhase {
  readonly id: string;
  readonly name: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly colorToken: string | null;
  readonly position: number;
}

/** 53-07. One milestone diamond. Nested in the timeline response; not exported. */
interface WorkTimelineMilestone {
  readonly id: string;
  readonly title: string;
  readonly date: string | null;
  readonly committedOn: string | null;
  readonly forecastOn: string | null;
  readonly status: string;
  readonly health: MilestoneHealth;
  readonly phaseId: string | null;
  readonly linkedItemIds: readonly string[];
}

/** The timeline read's response — paired Exact with the API's `WorkTimelineView` in the contracts gate. */
export interface WorkTimelineView {
  readonly projectId: string;
  readonly items: readonly WorkTimelineItem[];
  /** 53-07. The phase bands; absent for a client principal. */
  readonly phases?: readonly WorkTimelinePhase[];
  /** 53-07. The milestone diamonds; absent for a client principal. */
  readonly milestones?: readonly WorkTimelineMilestone[];
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

/** One milestone on the timeline, for the screen — an indexed access, not a second shape. */
export type WorkTimelineMilestoneRow = NonNullable<WorkTimelineView['milestones']>[number];

/** One phase band, for the screen — an indexed access, not a second shape. */
export type WorkTimelinePhaseRow = NonNullable<WorkTimelineView['phases']>[number];

const orgPath = (organizationSlug: string) =>
  `/v1/organizations/${encodeURIComponent(organizationSlug)}`;

/*
 * 53-03 Editable Gantt — the writes the timeline makes, all on routes 53-04..07 already serve.
 *
 * A move or resize is the 53-04 cascade: preview what else would move, then apply with the
 * previewed list (`expectedMoves`) so a schedule that changed in between is a 409, never a
 * surprise. The response shapes (the API's `CascadePlanView`, the baseline overlay and the
 * critical-path read) are declared here unexported — the contracts gate enumerates exported
 * response shapes — and the screen reaches them through the functions' return types.
 */
interface TimelineCascadeMove {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly startAt: string | null;
  readonly dueAt: string | null;
  readonly deltaWorkingDays: number;
}

interface TimelineCascadePlan {
  readonly workItemId: string;
  readonly startAt: string | null;
  readonly dueAt: string | null;
  readonly moves: readonly TimelineCascadeMove[];
  readonly hiddenCount: number;
  readonly crossProjectIds: readonly string[];
  readonly unscheduled: readonly string[];
}

/** The new dates of a moved or resized bar. A request shape. */
export interface TimelineMoveInput {
  readonly startAt: string | null;
  readonly dueAt: string | null;
}

export async function previewTimelineMove(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: TimelineMoveInput,
): Promise<TimelineCascadePlan> {
  const { data } = await client.request<TimelineCascadePlan>({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/schedule/cascade-preview`,
    body: input,
  });
  return data;
}

export async function applyTimelineMove(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: TimelineMoveInput,
  expectedMoves: readonly string[],
): Promise<TimelineCascadePlan> {
  const { data } = await client.request<TimelineCascadePlan>({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/schedule/cascade-apply`,
    body: { ...input, expectedMoves },
  });
  return data;
}

/** Draw a finish-to-start edge: `workItemId` waits on `predecessorId`. */
export async function addTimelineDependency(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  predecessorId: string,
): Promise<void> {
  await client.request({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/dependencies`,
    body: { dependsOnWorkItemId: predecessorId, kind: 'FS', lagWorkingDays: 0 },
  });
}

export async function removeTimelineDependency(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  dependencyId: string,
): Promise<void> {
  await client.request({
    method: 'DELETE',
    path: `${orgPath(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/dependencies/${encodeURIComponent(dependencyId)}`,
  });
}

interface TimelineBaselineOverlay {
  readonly baselineId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly items: readonly {
    readonly workItemId: string;
    readonly startAt: string | null;
    readonly dueAt: string | null;
  }[];
}

/** The current baseline's frozen dates (ghost bars), or `null` when the project has none. */
export async function getTimelineBaseline(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<TimelineBaselineOverlay | null> {
  try {
    const { data } = await client.request<TimelineBaselineOverlay>({
      path: `${orgPath(organizationSlug)}/projects/${encodeURIComponent(projectId)}/baselines/current/overlay`,
    });
    return data;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}

interface TimelineCriticalPath {
  readonly projectId: string;
  readonly computedAt: string | null;
  readonly criticalEndDate: string | null;
  readonly criticalCount: number;
  readonly items: readonly {
    readonly id: string;
    readonly totalFloatDays: number | null;
    readonly isCritical: boolean;
  }[];
}

/** The critical-path read — the API recomputes a stale project, so it is fresher than the timeline. */
export async function getTimelineCriticalPath(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<TimelineCriticalPath> {
  const { data } = await client.request<TimelineCriticalPath>({
    path: `${orgPath(organizationSlug)}/projects/${encodeURIComponent(projectId)}/schedule/critical-path`,
  });
  return data;
}

/** A dragged milestone: the one date field its diamond is drawn from. A request shape. */
export interface TimelineMilestoneMoveInput {
  readonly field: 'committedOn' | 'forecastOn' | 'dueOn';
  readonly date: string;
  readonly clientSafeReason?: string;
}

export async function moveTimelineMilestone(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  milestoneId: string,
  input: TimelineMilestoneMoveInput,
): Promise<void> {
  await client.request({
    method: 'PATCH',
    path: `${orgPath(organizationSlug)}/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestoneId)}`,
    body: {
      [input.field]: input.date,
      ...(input.clientSafeReason ? { clientSafeReason: input.clientSafeReason } : {}),
    },
  });
}

/**
 * WK-06 Workload — one assignee's slice of a project's open work. Not exported as its own
 * interface, for the same reason {@link WorkTimelineItem} is not: the contracts gate enumerates
 * every exported response shape in this folder, and the workload is a single paired response
 * (`WorkloadView`). The screen reaches a group through {@link WorkloadRow} instead, an indexed
 * access, not a second projection.
 */
interface WorkloadAssignee {
  /** The owner, or `null` for the project's unassigned open work. */
  readonly ownerUserId: string | null;
  /** How many open items this assignee carries in the project. */
  readonly openItemCount: number;
  /** Of those, how many are on the calendar — have a start or a due date. Derived load. */
  readonly scheduledItemCount: number;
}

/** The workload read's response — paired Exact with the API's `WorkloadView` in the contracts gate. */
export interface WorkloadView {
  readonly projectId: string;
  readonly groups: readonly WorkloadAssignee[];
}

/** One workload group, for the screen — an indexed access, so it is not a second enumerated shape. */
export type WorkloadRow = WorkloadView['groups'][number];

export async function getWorkWorkload(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<WorkloadView> {
  const { data } = await client.request<WorkloadView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-views/workload/${encodeURIComponent(projectId)}`,
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

/**
 * WK-08 Saved views — persist / list / apply a named filter/grouping/columns configuration.
 *
 * A saved view is created and edited by its owner (`POST`/`PUT`) and read by the owner plus anyone
 * in the studio when it is shared (`GET`), all behind the same `work.read` capability. The apply
 * step is the client's: `config` is echoed back for the screen to drive the existing list/board
 * reads, so there is no server-side filtering here beyond what WK-04/WK-06 already expose.
 */

/**
 * One remembered filter — a field and the value the view pins it to.
 *
 * Deliberately **not** exported: the contracts gate enumerates every exported response projection
 * in this folder, and these nested config shapes are not standalone responses (the same reason
 * `WorkTimelineItem` above is not exported). The screen reaches them through `SavedViewView`.
 */
interface SavedViewFilter {
  readonly field: string;
  readonly value: string;
}

/** The filter/grouping/columns a saved view remembers. Nested in `SavedViewView`; not exported. */
interface SavedViewConfig {
  readonly filters: readonly SavedViewFilter[];
  readonly grouping: string | null;
  readonly columns: readonly string[];
}

/** A saved view as the screen reads it — paired Exact with the API's `SavedViewView`. */
export interface SavedViewView {
  readonly id: string;
  readonly ownerUserId: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly config: SavedViewConfig;
  readonly shared: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The editable fields a create or a save sends. A request shape (suffix `Input`), not a response. */
export interface SavedViewInput {
  readonly projectId: string | null;
  readonly name: string;
  readonly config: SavedViewConfig;
  readonly shared: boolean;
}

export async function listSavedViews(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly SavedViewView[]> {
  const { data } = await client.request<{ savedViews: readonly SavedViewView[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-views/saved`,
  });
  return data.savedViews;
}

export async function createSavedView(
  client: ApiClient,
  organizationSlug: string,
  input: SavedViewInput,
): Promise<SavedViewView> {
  const { data } = await client.request<SavedViewView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-views/saved`,
    body: input,
  });
  return data;
}

export async function updateSavedView(
  client: ApiClient,
  organizationSlug: string,
  savedViewId: string,
  input: SavedViewInput,
): Promise<SavedViewView> {
  const { data } = await client.request<SavedViewView>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-views/saved/${encodeURIComponent(savedViewId)}`,
    body: input,
  });
  return data;
}

/*
 * FIX3 item 10 (live check a6f66e47): Timeline, Calendar and Workload stay on "All work" until the
 * person picks a project. Their reads are per project, so "All work" reads every project the caller
 * can see and joins the answers here (`projectId: ''` marks the joined view). A studio has a
 * handful of projects in the beta, so one read per project is the honest cost.
 */

/**
 * Every project's timeline bars, joined. Phases and milestones belong to one project's plan (and
 * a milestone move names its project), so the joined view draws the work items only.
 */
export async function getWorkTimelineAll(
  client: ApiClient,
  organizationSlug: string,
  projectIds: readonly string[],
): Promise<WorkTimelineView> {
  const views = await Promise.all(
    projectIds.map((projectId) => getWorkTimeline(client, organizationSlug, projectId)),
  );
  return { projectId: '', items: views.flatMap((view) => view.items) };
}

/** Every project's workload, one row per person with their counts summed. */
export async function getWorkWorkloadAll(
  client: ApiClient,
  organizationSlug: string,
  projectIds: readonly string[],
): Promise<WorkloadView> {
  const views = await Promise.all(
    projectIds.map((projectId) => getWorkWorkload(client, organizationSlug, projectId)),
  );
  const byOwner = new Map<string | null, WorkloadAssignee>();
  for (const group of views.flatMap((view) => view.groups)) {
    const seen = byOwner.get(group.ownerUserId);
    byOwner.set(
      group.ownerUserId,
      seen
        ? {
            ownerUserId: group.ownerUserId,
            openItemCount: seen.openItemCount + group.openItemCount,
            scheduledItemCount: seen.scheduledItemCount + group.scheduledItemCount,
          }
        : group,
    );
  }
  return { projectId: '', groups: [...byOwner.values()] };
}

/** Every project's calendar for one range, one cell per day. */
export async function getWorkCalendarAll(
  client: ApiClient,
  organizationSlug: string,
  projectIds: readonly string[],
  range: WorkCalendarRangeInput,
): Promise<WorkCalendarView> {
  const views = await Promise.all(
    projectIds.map((projectId) => getWorkCalendar(client, organizationSlug, projectId, range)),
  );
  const byDate = new Map<string, WorkCalendarItem[]>();
  for (const day of views.flatMap((view) => view.days)) {
    byDate.set(day.date, [...(byDate.get(day.date) ?? []), ...day.items]);
  }
  return {
    projectId: '',
    range: { from: range.from, to: range.to },
    days: [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, items]) => ({ date, items })),
  };
}
