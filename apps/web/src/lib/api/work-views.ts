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
