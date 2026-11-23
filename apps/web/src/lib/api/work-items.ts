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
  /** A6 (0219). Plain text, `null` when none was written. Always sent by the API. */
  readonly description?: string | null;
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
  /** C27: everyone who does it, the lead first — sent on the list read for internal readers. */
  readonly doerUserIds?: readonly string[];
  /** 0340 (FIX3 item C): the hand-made Board/List order; `null` sorts by creation time. */
  readonly rank?: number | null;
  /**
   * Work area D1: the stage the item is in and its name, from the stage set it uses; `null` on
   * the built-in stages (show the state's label then). Sent on the list and single reads.
   */
  readonly stageId?: string | null;
  readonly stageName?: string | null;
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
  readonly description?: string;
  readonly type?: string;
  readonly ownerUserId?: string;
  readonly audience?: WorkItemAudience;
  readonly startAt?: string;
  readonly dueAt?: string;
  /** Work area D2: several doers (lead first), supervisors and watchers from the start. */
  readonly doerUserIds?: readonly string[];
  readonly supervisorUserIds?: readonly string[];
  readonly watcherUserIds?: readonly string[];
  /** Work area D2: the project's client companies that may follow it (the client tag). */
  readonly clientOrganizationIds?: readonly string[];
  /** Work area D2: the first steps, in order. */
  readonly steps?: readonly { readonly label: string }[];
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
  /** A6. `null` (or a blank string) clears the description. */
  readonly description?: string | null;
  /** A6. Move the item to another project of this organization; an owner not on it is cleared. */
  readonly projectId?: string;
  readonly type?: string;
  readonly ownerUserId?: string | null;
  readonly audience?: WorkItemAudience;
  readonly startAt?: string | null;
  readonly dueAt?: string | null;
  /** C25: the client companies that may see a client-facing item; all ticked = all. */
  readonly clientOrganizationIds?: readonly string[];
  /** 0340 (FIX3 item C): the hand-made order, set by a drag; `null` returns to creation order. */
  readonly rank?: number | null;
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

/**
 * C25: `GET work-items/:id/client-audience` — the client companies a client-facing item is
 * limited to. An empty list means every client company the project is shared with.
 */
export async function getWorkItemClientAudience(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<readonly string[]> {
  const { data } = await client.request<{ clientOrganizationIds: readonly string[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/client-audience`,
  });
  return data.clientOrganizationIds;
}

/** C26: who does a task (lead first), who supervises it and who watches it, by user id. */
export interface WorkItemPeople {
  readonly doerUserIds: readonly string[];
  readonly supervisorUserIds: readonly string[];
  readonly watcherUserIds: readonly string[];
  /** C27: the reader's own user id ("I supervise this"). */
  readonly viewerUserId?: string;
}

export type WorkItemPeopleRole = 'doers' | 'supervisors';

function peoplePath(organizationSlug: string, workItemId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/people`;
}

export async function getWorkItemPeople(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<WorkItemPeople> {
  const { data } = await client.request<WorkItemPeople>({
    path: peoplePath(organizationSlug, workItemId),
  });
  return data;
}

/** C26: replace the doers (the first becomes the owner) or the supervisors. */
export async function setWorkItemPeople(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  role: WorkItemPeopleRole,
  userIds: readonly string[],
): Promise<WorkItemPeople> {
  const { data } = await client.request<WorkItemPeople>({
    path: `${peoplePath(organizationSlug, workItemId)}/${role}`,
    method: 'PUT',
    body: { userIds },
  });
  return data;
}

/** C27: take one person off the watchers (yourself, or anyone if you may edit the task). */
export async function removeWorkItemWatcher(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  userId: string,
): Promise<{ readonly removed: boolean }> {
  const { data } = await client.request<{ readonly removed: boolean }>({
    path: `${peoplePath(organizationSlug, workItemId)}/watchers/${encodeURIComponent(userId)}`,
    method: 'DELETE',
  });
  return data;
}

/** C26: add several watchers at once. */
export async function addWorkItemWatchers(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  userIds: readonly string[],
): Promise<{ readonly added: number }> {
  const { data } = await client.request<{ readonly added: number }>({
    path: `${peoplePath(organizationSlug, workItemId)}/watchers`,
    method: 'POST',
    body: { userIds },
  });
  return data;
}

/**
 * A6 "Duplicate": a new item with the same project, type, owner, dates, audience and
 * description, titled `copyTitle` (the screen's "Copy of …"). It starts at the lifecycle's
 * first state — a copy is new work, so neither the state nor the checklist travel with it.
 */
export async function duplicateWorkItem(
  client: ApiClient,
  organizationSlug: string,
  item: WorkItemSummary,
  copyTitle: string,
): Promise<WorkItemSummary> {
  const description = item.description ?? null;
  return createWorkItem(client, organizationSlug, {
    projectId: item.projectId,
    title: copyTitle.slice(0, 300),
    type: item.type,
    audience: item.audience,
    ...(item.ownerUserId === null ? {} : { ownerUserId: item.ownerUserId }),
    ...(item.startAt === null ? {} : { startAt: item.startAt }),
    ...(item.dueAt === null ? {} : { dueAt: item.dueAt }),
    ...(description === null ? {} : { description }),
  });
}

/**
 * Soft-delete — `DELETE :id`, answered `204`. The API takes no version here: removing an item
 * is not a field edit that could silently overwrite somebody else's change.
 */
export async function deleteWorkItem(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}`,
  });
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
  /** Work area D3: who does the step (a user id), `null` = nobody. */
  readonly assigneeUserId?: string | null;
  /** Work area D3: the day the step is due (`YYYY-MM-DD`), `null` = none. */
  readonly dueOn?: string | null;
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
  input: {
    readonly label: string;
    readonly assigneeUserId?: string | null;
    readonly dueOn?: string | null;
  },
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
  input: {
    readonly label?: string;
    readonly done?: boolean;
    /** Work area D3: who does the step; `null` clears it. */
    readonly assigneeUserId?: string | null;
    /** Work area D3: the step's day (`YYYY-MM-DD`); `null` clears it. */
    readonly dueOn?: string | null;
  },
): Promise<WorkChecklistItem> {
  const { data } = await client.request<WorkChecklistItem>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/checklist/${encodeURIComponent(itemId)}`,
    body: input,
  });
  return data;
}

function checklistPath(organizationSlug: string, workItemId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/checklist`;
}

/** Work area D3: delete a step. */
export async function deleteChecklistItem(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  itemId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${checklistPath(organizationSlug, workItemId)}/${encodeURIComponent(itemId)}`,
  });
}

/** Work area D3: the steps' new order, every step id of the work once. */
export async function reorderChecklist(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  itemIds: readonly string[],
): Promise<readonly WorkChecklistItem[]> {
  const { data } = await client.request<{ items: readonly WorkChecklistItem[] }>({
    method: 'PUT',
    path: `${checklistPath(organizationSlug, workItemId)}/order`,
    body: { itemIds },
  });
  return data.items;
}

/** Work area D3: turn a step into a work of its own in the same project; answers the new work. */
export async function convertChecklistItem(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  itemId: string,
): Promise<WorkItemSummary> {
  const { data } = await client.request<WorkItemSummary>({
    method: 'POST',
    path: `${checklistPath(organizationSlug, workItemId)}/${encodeURIComponent(itemId)}/convert`,
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
  /** The author's user id and name (Figma `WV2-02` comment line); `null` once unresolvable. */
  readonly authorUserId: string | null;
  readonly authorName: string | null;
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

// ── x204: work item dependencies / typed links ───────────────────────────────

/** The typed relationship one link expresses. `blocks`: this item blocks the target. */
export type WorkItemLinkType = 'blocks' | 'blocked_by' | 'relates';

/**
 * One typed link authored on a work item — x204 (Work module 7). The API projection is
 * `WorkItemLinkView`; this is its web mirror, paired `Exact` in `e2e/contracts`. A link is a
 * fact with no editable field: the client creates, lists and removes, and there is no edit.
 */
export interface WorkItemLink {
  readonly id: string;
  readonly fromWorkItemId: string;
  readonly toWorkItemId: string;
  readonly toWorkItemTitle: string;
  readonly toWorkItemState: string;
  readonly linkType: WorkItemLinkType;
  readonly createdAt: string;
}

export async function listItemLinks(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<readonly WorkItemLink[]> {
  const { data } = await client.request<{ links: readonly WorkItemLink[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/links`,
  });
  return data.links;
}

export async function addItemLink(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: { readonly toWorkItemId: string; readonly linkType: WorkItemLinkType },
): Promise<WorkItemLink> {
  const { data } = await client.request<WorkItemLink>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/links`,
    body: input,
  });
  return data;
}

export async function removeItemLink(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  linkId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/links/${encodeURIComponent(linkId)}`,
  });
}

/**
 * One file attached to a work item — x205 (Work module 7). The API projection is `ItemFileView`;
 * this is its web mirror, paired `Exact` in `e2e/contracts`. A link is attached and detached,
 * never edited: the client reads, adds and removes, and there is no update shape.
 */
export interface ItemFile {
  readonly id: string;
  readonly workItemId: string;
  readonly fileAssetId: string;
  readonly fileName: string;
  /**
   * The file's availability: `ready` opens through the download route; `scanning` is still
   * being checked for viruses; `unavailable` is rejected, expired or cancelled. Mirrors the
   * API's `FileAvailability` (paired `Exact` in `e2e/contracts`).
   */
  readonly availability: 'ready' | 'scanning' | 'unavailable';
  readonly attachedByMembershipId: string;
  readonly createdAt: string;
}

export async function listWorkItemFiles(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<readonly ItemFile[]> {
  const { data } = await client.request<{ files: readonly ItemFile[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/files`,
  });
  return data.files;
}

export async function attachWorkItemFile(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: { readonly fileAssetId: string },
): Promise<ItemFile> {
  const { data } = await client.request<ItemFile>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/files`,
    body: input,
  });
  return data;
}

export async function detachWorkItemFile(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  linkId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/files/${encodeURIComponent(linkId)}`,
  });
}

// ── x231: work item time logs / logged effort ────────────────────────────────

/**
 * One logged-effort entry hanging off a work item — x231 (Work module 7). The API projection is
 * `TimeLogView`; this is its web mirror, paired `Exact` in `e2e/contracts`.
 */
export interface TimeLog {
  readonly id: string;
  readonly workItemId: string;
  readonly loggedBy: string;
  readonly minutes: number;
  /** The calendar day the effort was spent, `YYYY-MM-DD`. */
  readonly spentOn: string;
  readonly note: string | null;
  readonly createdAt: string;
  /** How the minutes came in (2026-11-23 time trust): measured by the timer, or typed in. */
  readonly source: 'manual' | 'timer' | 'automatic' | 'correction';
  readonly trust: 'measured' | 'hand';
  readonly approvalState: 'none' | 'pending' | 'approved' | 'rejected';
  /** Counts in the totals (false: waiting for a manager, refused, or replaced by a correction). */
  readonly counted: boolean;
  readonly reason: string | null;
}

/** The list response: the entries, the minutes that count, and hand time still waiting. */
export interface TimeLogList {
  readonly entries: readonly TimeLog[];
  readonly totalMinutes: number;
  readonly pendingMinutes: number;
}

export async function listTimeLogs(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<TimeLogList> {
  const { data } = await client.request<TimeLogList>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/time-logs`,
  });
  return data;
}

export async function addTimeLog(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: {
    readonly minutes: number;
    readonly spentOn: string;
    readonly note?: string | null;
    /** Why the time is typed in; required while the owner allows hand time. */
    readonly reason?: string;
  },
): Promise<TimeLog> {
  const { data } = await client.request<TimeLog>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/time-logs`,
    body: input,
  });
  return data;
}

export async function deleteTimeLog(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  entryId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/time-logs/${encodeURIComponent(entryId)}`,
  });
}

// ── x258: work item effort estimate (plan vs actual) ─────────────────────────

/**
 * A work item's effort estimate read beside its logged actual — x258 (Work module). The API
 * projection is `WorkItemEstimateView`; this is its web mirror, paired `Exact` in `e2e/contracts`.
 * `estimateMinutes` is `null` until one is set; `actualMinutes` sums x231's time logs (0 when none);
 * `varianceMinutes` is `estimate - actual`, `null` with no estimate.
 */
export interface WorkItemEstimate {
  readonly workItemId: string;
  readonly estimateMinutes: number | null;
  readonly actualMinutes: number;
  readonly varianceMinutes: number | null;
  readonly updatedAt: string | null;
  /** 53-08 (0309): what is left — the override when set, else `max(0, estimate − actual)`. */
  readonly remainingMinutes: number | null;
  readonly remainingSource: 'override' | 'derived' | null;
}

export async function getWorkItemEstimate(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<WorkItemEstimate> {
  const { data } = await client.request<WorkItemEstimate>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/estimate`,
  });
  return data;
}

export async function setWorkItemEstimate(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: { readonly minutes: number },
): Promise<WorkItemEstimate> {
  const { data } = await client.request<WorkItemEstimate>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/estimate`,
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

// ── x256: work item personal reminders ───────────────────────────────────────

/**
 * The acting member's personal reminder on a work item — x256 (Work module 7). The API projection
 * is `WorkItemReminderView`; this is its web mirror, paired `Exact` in `e2e/contracts`. Self-service:
 * the client sets and clears its own reminder, and there is no route to set anyone else's.
 * `membershipId` is a membership id, never an email. No notification is dispatched — storage only.
 */
export interface WorkItemReminder {
  readonly id: string;
  readonly workItemId: string;
  readonly membershipId: string;
  readonly remindAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One entry in the "My Reminders" due list — x256. The API projection is `DueReminderView`; this is
 * its web mirror, paired `Exact` in `e2e/contracts`. A reminder joined to the item it names, so the
 * list can render a title and state.
 */
export interface DueReminder {
  readonly id: string;
  readonly workItemId: string;
  readonly workItemTitle: string;
  readonly workItemState: string;
  readonly membershipId: string;
  readonly remindAt: string;
}

export async function setWorkItemReminder(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  remindAt: string,
): Promise<WorkItemReminder> {
  const { data } = await client.request<WorkItemReminder>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/reminder`,
    body: { remindAt },
  });
  return data;
}

export async function clearWorkItemReminder(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/reminder`,
  });
}

export async function listDueReminders(
  client: ApiClient,
  organizationSlug: string,
  before?: string,
): Promise<readonly DueReminder[]> {
  const query = before === undefined ? '' : `?before=${encodeURIComponent(before)}`;
  const { data } = await client.request<{ reminders: readonly DueReminder[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/reminders/due${query}`,
  });
  return data.reminders;
}
