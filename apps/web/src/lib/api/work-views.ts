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
