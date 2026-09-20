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
