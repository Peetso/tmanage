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
