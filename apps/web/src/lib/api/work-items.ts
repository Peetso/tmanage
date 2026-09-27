import type { WorkItemState } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * The work item endpoints — WORK-001, behind `TM-03`, `TM-10` and `TM-13`.
 *
 * Two shapes here differ from every other module in this folder, and both differences are
 * the API's rather than this file's:
 *
 * - **`version` is required on every write.** It is the optimistic concurrency token, and the
 *   API refuses a write that does not name the version it read. It is not optional here for
 *   the same reason it is not optional there: a caller who could omit it could silently
 *   overwrite somebody else's edit, and the type is the first place to say so.
 * - **A transition is its own request.** `POST :id/transitions` takes the target state and
 *   the *facts* the state machine requires for that move. A `PATCH` cannot change state at
 *   all, so there is no second path to a state change for this file to offer.
 */

export type WorkItemAudience = 'internal' | 'client_visible' | 'client_action_required';

export interface WorkItemSummary {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
  readonly title: string;
  readonly state: WorkItemState;
  readonly ownerUserId: string | null;
  readonly audience: WorkItemAudience;
  readonly startAt: string | null;
  readonly dueAt: string | null;
  /** Set when the item reached `done`, from the completion time the mover gave; cleared by a reopen. */
  readonly completedAt: string | null;
  /** The concurrency token. Present it to update or to transition. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/**
 * The largest page the API will return — `MAX_PAGE_SIZE` in `WorkItemsRepository`.
 *
 * Named here because a screen that asks for it needs to know when it got exactly that many
 * back: a full page means there may be more, and a list that showed the first fifty of two
 * hundred without saying so would read as "this is the work". Cursor paging through `after` is
 * the second half of WEB-002; saying so plainly is what this half owes.
 */
export const MAX_WORK_ITEM_PAGE = 200;

export interface ListWorkItemsQuery {
  readonly projectId?: string;
  /** A set of states. Sent comma-separated, which is what the API's `state` parameter takes. */
  readonly states?: readonly WorkItemState[];
  readonly after?: string;
  readonly limit?: number;
}

export async function listWorkItems(
  client: ApiClient,
  organizationSlug: string,
  query: ListWorkItemsQuery = {},
): Promise<readonly WorkItemSummary[]> {
  const parameters = new URLSearchParams();
  if (query.projectId) parameters.set('projectId', query.projectId);
  if (query.states && query.states.length > 0) parameters.set('state', query.states.join(','));
  if (query.after) parameters.set('after', query.after);
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));

  const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
  const { data } = await client.request<{ workItems: readonly WorkItemSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items${suffix}`,
  });
  return data.workItems;
}

export async function getWorkItem(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<WorkItemSummary> {
  const { data } = await client.request<WorkItemSummary>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}`,
  });
  return data;
}

export interface CreateWorkItemInput {
  readonly projectId: string;
  readonly title: string;
  readonly type?: string;
  readonly ownerUserId?: string;
  readonly audience?: WorkItemAudience;
  readonly startAt?: string;
  readonly dueAt?: string;
}

export async function createWorkItem(
  client: ApiClient,
  organizationSlug: string,
  input: CreateWorkItemInput,
): Promise<WorkItemSummary> {
  const { data } = await client.request<WorkItemSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items`,
    body: input,
  });
  return data;
}

export interface UpdateWorkItemInput {
  readonly version: number;
  readonly title?: string;
  readonly type?: string;
  readonly ownerUserId?: string | null;
  readonly audience?: WorkItemAudience;
  readonly startAt?: string | null;
  readonly dueAt?: string | null;
}

export async function updateWorkItem(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: UpdateWorkItemInput,
): Promise<WorkItemSummary> {
  const { data } = await client.request<WorkItemSummary>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}`,
    body: input,
  });
  return data;
}

export interface TransitionWorkItemInput {
  readonly version: number;
  readonly to: WorkItemState;
  /**
   * Whatever the machine requires for this particular move — a blocker reason and an ask, a
   * resolution, an owner and a completion time, a reopen reason. Validated by the machine on
   * the server; this screen only decides which of them to *ask* for.
   */
  readonly facts?: Readonly<Record<string, string>>;
}

export async function transitionWorkItem(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: TransitionWorkItemInput,
): Promise<WorkItemSummary> {
  const { data } = await client.request<WorkItemSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/transitions`,
    body: input,
  });
  return data;
}

// ── x145: work item checklist / sub-items ────────────────────────────────────

/**
 * One checklist item hanging off a work item — x145 (Work module 7). The API projection is
 * `WorkChecklistItemView`; this is its web mirror, paired `Exact` in `e2e/contracts`.
 */
export interface WorkChecklistItem {
  readonly id: string;
  readonly workItemId: string;
  readonly label: string;
  readonly done: boolean;
  /** The ordinal the list is read by, ascending. */
  readonly position: number;
  readonly createdAt: string;
}

export async function listChecklist(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<readonly WorkChecklistItem[]> {
  const { data } = await client.request<{ items: readonly WorkChecklistItem[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/checklist`,
  });
  return data.items;
}

export async function addChecklistItem(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: { readonly label: string },
): Promise<WorkChecklistItem> {
  const { data } = await client.request<WorkChecklistItem>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/checklist`,
    body: input,
  });
  return data;
}

export async function updateChecklistItem(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  itemId: string,
  input: { readonly label?: string; readonly done?: boolean },
): Promise<WorkChecklistItem> {
  const { data } = await client.request<WorkChecklistItem>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/checklist/${encodeURIComponent(itemId)}`,
    body: input,
  });
  return data;
}

// ── x147: work item comments / activity ──────────────────────────────────────

/**
 * One comment hanging off a work item — x147 (Work module 7). The API projection is
 * `WorkCommentView`; this is its web mirror, paired `Exact` in `e2e/contracts`. Append-only:
 * the client reads and adds, and there is no edit or delete.
 */
export interface WorkComment {
  readonly id: string;
  readonly workItemId: string;
  readonly authorMembershipId: string;
  readonly body: string;
  readonly createdAt: string;
}

export async function listWorkComments(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<readonly WorkComment[]> {
  const { data } = await client.request<{ comments: readonly WorkComment[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/comments`,
  });
  return data.comments;
}

export async function addWorkComment(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: { readonly body: string },
): Promise<WorkComment> {
  const { data } = await client.request<WorkComment>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/comments`,
    body: input,
  });
  return data;
}

// ── x232: work item watchers / subscribers ───────────────────────────────────

/**
 * One watcher on a work item — x232 (Work module 7). The API projection is `ItemWatcherView`;
 * this is its web mirror, paired `Exact` in `e2e/contracts`. A roster of who is watching:
 * `memberId` is a membership id, never an email. Self-service — the client subscribes and
 * unsubscribes itself, and there is no route to watch anyone else.
 */
export interface ItemWatcher {
  readonly id: string;
  readonly workItemId: string;
  readonly memberId: string;
  readonly createdAt: string;
}

export async function listWatchers(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<readonly ItemWatcher[]> {
  const { data } = await client.request<{ watchers: readonly ItemWatcher[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/watchers`,
  });
  return data.watchers;
}

export async function subscribeToWorkItem(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<ItemWatcher> {
  const { data } = await client.request<ItemWatcher>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/watchers`,
  });
  return data;
}

export async function unsubscribeFromWorkItem(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/watchers`,
  });
}
