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
 * The Home / Waiting read — HOME-04's one readable bucket: approvals pending on the acting user
 * as a reviewer. Behind `approval.read` on the API, gated by the reviewer relation, and taking no
 * request body: the acting user is the session's. The response is already ranked by the API.
 *
 * The delegated bucket (`41-...-MATRIX` HOME-04) is deferred — `work_items` has no assignee/
 * creator column — so every entry is the `'approval'` kind for now. The discriminant keeps the
 * shape open for a second kind without a breaking change.
 */
export type WaitingReason = 'approval_requested' | 'approval_viewed';

export interface Waiting {
  readonly items: readonly {
    readonly kind: 'approval';
    readonly reason: WaitingReason;
    readonly approvalId: string;
    readonly deliverableId: string;
    readonly projectId: string;
    readonly requestedAt: string;
  }[];
}

export async function getWaiting(client: ApiClient, organizationSlug: string): Promise<Waiting> {
  const { data } = await client.request<Waiting>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/waiting`,
  });
  return data;
}
