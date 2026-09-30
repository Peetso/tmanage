import type { ApiClient } from './client';
import type { WorkItemSummary } from './work-items';

/**
 * The Home / My Day endpoints — HOME-03's Personal-work read.
 *
 * The read is behind `work.read` on the API, reuses the work item projection, and takes no
 * request body: the acting user is the session's, never a field this client supplies. The
 * response is the caller's own open work, each row carrying the one reason it needs them today,
 * already ranked by the API.
 */

/** Why an item is on the My Day list, in the API's rank order. */
export type MyDayReason = 'overdue' | 'due_soon' | 'assigned';

/**
 * The My Day personal-work section: the acting user's open work, ranked. Each entry is inlined
 * rather than a second exported shape, so the API↔web pairing is the one `MyDay` projection.
 */
export interface MyDay {
  readonly items: readonly {
    readonly reason: MyDayReason;
    readonly workItem: WorkItemSummary;
  }[];
}

export async function getMyDay(client: ApiClient, organizationSlug: string): Promise<MyDay> {
  const { data } = await client.request<MyDay>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/my-day`,
  });
  return data;
}

/**
 * The Home / Waiting read — HOME-04's three buckets: approvals pending on the acting user as a
 * reviewer, client requests awaiting their triage, and stale client follow-ups. Behind
 * `approval.read` on the API, each bucket gated by its own relation, and taking no request body:
 * the acting user is the session's. The response is already ranked by the API.
 *
 * Each entry is a discriminated `kind` — `'approval'` or `'client_request'`. The delegated bucket
 * (`41-...-MATRIX` HOME-04) is still deferred — `work_items` has no assignee/creator column — and
 * would be one more `kind` arm, not a reshape of these.
 */
export type WaitingReason =
  | 'approval_requested'
  | 'approval_viewed'
  | 'client_submitted'
  | 'client_triage'
  | 'stale_follow_up';

export interface Waiting {
  readonly items: readonly (
    | {
        readonly kind: 'approval';
        readonly reason: 'approval_requested' | 'approval_viewed';
        readonly approvalId: string;
        readonly deliverableId: string;
        readonly projectId: string;
        readonly requestedAt: string;
      }
    | {
        readonly kind: 'client_request';
        readonly reason: 'client_submitted' | 'client_triage' | 'stale_follow_up';
        readonly clientRequestId: string;
        readonly projectId: string;
        readonly title: string;
        readonly waitingSince: string;
      }
  )[];
}

export async function getWaiting(client: ApiClient, organizationSlug: string): Promise<Waiting> {
  const { data } = await client.request<Waiting>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/waiting`,
  });
  return data;
}

/**
 * The Home / Summary read — HOME-01's hero counts. Behind `work.read` on the API, taking no
 * request body. Every number is derived by the API from the same My Day and Waiting reads the
 * sections render, so the hero shows nothing the lists below it do not.
 */
export interface HomeSummary {
  readonly personalWork: {
    readonly total: number;
    readonly overdue: number;
    readonly dueSoon: number;
  };
  readonly waiting: {
    readonly total: number;
    readonly approvals: number;
    readonly clientRequests: number;
    readonly staleFollowUps: number;
  };
}

export async function getHomeSummary(
  client: ApiClient,
  organizationSlug: string,
): Promise<HomeSummary> {
  const { data } = await client.request<HomeSummary>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/summary`,
  });
  return data;
}

/**
 * The Home / Pulse read — HOME-01's Focus summary: the acting user's four headline counts. Behind
 * `work.read` on the API and taking no request body. `openWork` and `dueToday` are the caller's own
 * open work (`dueToday` a subset of `openWork`); `waitingOnYou` is the Waiting list total; and
 * `meetingsToday` is the meetings that start today in a project the caller may read. Every number is
 * the API's, gated per row, so the Focus capsule shows nothing the sections below it do not.
 */
export interface HomePulse {
  readonly openWork: number;
  readonly dueToday: number;
  readonly waitingOnYou: number;
  readonly meetingsToday: number;
}

export async function getHomePulse(
  client: ApiClient,
  organizationSlug: string,
): Promise<HomePulse> {
  const { data } = await client.request<HomePulse>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/pulse`,
  });
  return data;
}

/**
 * The Home / Saved-context endpoints — HOME-05's saved/pinned context.
 *
 * Behind `work.read` on the API and taking no `userId`: a pin is always the acting user's own. A
 * pin is a *reference* — its kind and id, grouped by project — never a copy of the entity; resolving
 * each pin to a live title/preview is the deferred follow-up, so the screen renders the reference by
 * type and project. The pin write resolves the ids tenant-scoped before authorizing, so an unknown
 * or cross-tenant id is a 404.
 */
export type SavedContextEntityType = 'message' | 'doc' | 'work' | 'file';

/**
 * The caller's pins grouped by project. Each group and item is inlined rather than a second
 * exported shape, so the API↔web pairing is the one `SavedContext` projection.
 */
export interface SavedContext {
  readonly groups: readonly {
    readonly projectId: string;
    readonly items: readonly {
      readonly id: string;
      readonly entityType: SavedContextEntityType;
      readonly entityId: string;
      readonly createdAt: string;
    }[];
  }[];
}

/** The body of a pin request. `Input` suffix marks it request-side, not a response projection. */
export interface PinContextInput {
  readonly entityType: SavedContextEntityType;
  readonly entityId: string;
  readonly projectId: string;
}

export async function getSavedContext(
  client: ApiClient,
  organizationSlug: string,
): Promise<SavedContext> {
  const { data } = await client.request<SavedContext>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/saved-context`,
  });
  return data;
}

export async function pinContext(
  client: ApiClient,
  organizationSlug: string,
  input: PinContextInput,
): Promise<SavedContext> {
  const { data } = await client.request<SavedContext>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/saved-context`,
    body: input,
  });
  return data;
}

export async function unpinContext(
  client: ApiClient,
  organizationSlug: string,
  savedContextId: string,
): Promise<SavedContext> {
  const { data } = await client.request<SavedContext>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/saved-context/${encodeURIComponent(savedContextId)}`,
  });
  return data;
}

/**
 * The Home / Pins endpoints — HOME-05's follow-up (x144), a membership-scoped pin surface distinct
 * from the older per-user saved-context above.
 *
 * Behind `work.read` on the API and taking no membership id: a pin is always the acting member's
 * own. A pin is a *reference* — its kind and id — never a copy of the target; resolving each pin to a
 * live title/preview is the deferred follow-up, so the screen renders the reference by type. The pin
 * write resolves the target id tenant-scoped before authorizing, so an unknown or cross-tenant id is
 * a 404, and a duplicate is a 409.
 */
export type HomePinTargetKind = 'work' | 'project' | 'document';

/**
 * The caller's Home pins, newest first. Each item is inlined rather than a second exported shape, so
 * the API↔web pairing is the one `HomePinView` projection.
 */
export interface HomePinView {
  readonly pins: readonly {
    readonly id: string;
    readonly targetKind: HomePinTargetKind;
    readonly targetId: string;
    readonly createdAt: string;
  }[];
}

/** The body of a create-pin request. `Input` suffix marks it request-side, not a response shape. */
export interface CreateHomePinInput {
  readonly targetKind: HomePinTargetKind;
  readonly targetId: string;
}

export async function getHomePins(
  client: ApiClient,
  organizationSlug: string,
): Promise<HomePinView> {
  const { data } = await client.request<HomePinView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/pins`,
  });
  return data;
}

export async function createHomePin(
  client: ApiClient,
  organizationSlug: string,
  input: CreateHomePinInput,
): Promise<HomePinView> {
  const { data } = await client.request<HomePinView>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/pins`,
    body: input,
  });
  return data;
}

export async function deleteHomePin(
  client: ApiClient,
  organizationSlug: string,
  pinId: string,
): Promise<HomePinView> {
  const { data } = await client.request<HomePinView>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/pins/${encodeURIComponent(pinId)}`,
  });
  return data;
}

/**
 * The Home / Recently-viewed endpoints — the My Day recents rail (x324), distinct from the explicit
 * pins above (x144) and the older saved context (x110).
 *
 * Behind `work.read` on the API and taking no membership id: a recent is always the acting member's
 * own. As the member opens an entity the client `PUT`s a view (an idempotent upsert that refreshes
 * the time), and the rail reads the member's recents newest first, bounded to a fixed cap. A recent
 * is a *reference* — its object kind and id — never a copy or a resolved title, so the rail can
 * disclose nothing about a target the member could not already reach; an `objectType` off the
 * allowlist is a 400.
 */
export type RecentItemObjectType = 'work' | 'project' | 'document' | 'meeting';

/**
 * The caller's recently-viewed references, newest first. Each item is inlined rather than a second
 * exported shape, so the API↔web pairing is the one `RecentItemsView` projection.
 */
export interface RecentItemsView {
  readonly items: readonly {
    readonly id: string;
    readonly objectType: RecentItemObjectType;
    readonly objectId: string;
    readonly viewedAt: string;
  }[];
}

/** The body of a record-a-view request. `Input` suffix marks it request-side, not a response shape. */
export interface RecordRecentItemInput {
  readonly objectType: RecentItemObjectType;
  readonly objectId: string;
}

export async function getRecentItems(
  client: ApiClient,
  organizationSlug: string,
): Promise<RecentItemsView> {
  const { data } = await client.request<RecentItemsView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/recent-items`,
  });
  return data;
}

export async function recordRecentItem(
  client: ApiClient,
  organizationSlug: string,
  input: RecordRecentItemInput,
): Promise<RecentItemsView> {
  const { data } = await client.request<RecentItemsView>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/recent-items`,
    body: input,
  });
  return data;
}
