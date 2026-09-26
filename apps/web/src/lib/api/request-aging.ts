import type { ApiClient } from './client';
import type { ClientRequestState } from './client-requests';

/**
 * The request-aging endpoint — module 11 (x154), the studio's overdue-to-triage / long-uncommitted
 * roll-up. Behind `client_request.triage` on the server (the internal-only capability REQ-001's inbox
 * reads under); a caller without it gets the 403 the shared client turns into an error, and an
 * over-wide `limit` gets a 400.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the slug in the path
 * resolved against the caller's membership, never a value the caller supplies; the counts are
 * tenant-scoped in SQL and re-checked on the server, so this never returns another tenant's requests.
 */

/** Which age bucket an open request falls into. */
export type RequestAgingBucket = 'fresh' | 'aging' | 'overdue';

/** One open request, aged — the element type of {@link RequestAgingView.requests}. */
interface RequestAgingItemRow {
  readonly id: string;
  readonly title: string;
  readonly state: ClientRequestState;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  readonly createdAt: string;
  readonly ageDays: number;
  readonly bucket: RequestAgingBucket;
  readonly committed: boolean;
}

/** The counts across the open set — the value type of {@link RequestAgingView.counts}. */
interface RequestAgingCountsRow {
  readonly fresh: number;
  readonly aging: number;
  readonly overdue: number;
  readonly uncommitted: number;
  readonly total: number;
}

/**
 * The aging roll-up. `thresholds` echoes the fixed day boundaries the buckets were chosen against;
 * `counts` is the tally across the open set; `requests` is the bounded, oldest-first page.
 */
export interface RequestAgingView {
  readonly thresholds: { readonly agingDays: number; readonly overdueDays: number };
  readonly counts: RequestAgingCountsRow;
  readonly requests: readonly RequestAgingItemRow[];
  readonly computedAt: string;
}

/** One aged request, named for the screen — the element type of {@link RequestAgingView.requests}. */
export type RequestAgingItem = RequestAgingView['requests'][number];
/** The counts, named for the screen — the value type of {@link RequestAgingView.counts}. */
export type RequestAgingCounts = RequestAgingView['counts'];

export async function fetchRequestAging(
  client: ApiClient,
  organizationSlug: string,
  options: { limit?: number } = {},
): Promise<RequestAgingView> {
  const query = options.limit === undefined ? '' : `?limit=${encodeURIComponent(options.limit)}`;
  const { data } = await client.request<RequestAgingView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests/aging${query}`,
  });
  return data;
}
