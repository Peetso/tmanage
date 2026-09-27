import type { ApiClient } from './client';

/**
 * INS saved views (module 15, x210) — a member's own named, saved insights filter set, created,
 * listed and deleted. All behind `work.read` on the server (the internal-read capability the sibling
 * insights reads reuse); a caller without it gets the ordinary 403 the shared client turns into an
 * error. The tenant is the slug in the path resolved against the caller's membership, and the *owner*
 * is the authenticated principal — never a value this client supplies — so it can only ever read,
 * create or remove the caller's own views.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** The closed vocabulary of insights reports a view may name. Mirrors the API's `INSIGHT_REPORT_KINDS`. */
export const INSIGHT_REPORT_KINDS = [
  'portfolio',
  'delivery-flow',
  'approval-cycle',
  'workload',
  'adoption',
  'forecast',
] as const;
export type InsightReportKind = (typeof INSIGHT_REPORT_KINDS)[number];

/** A saved view's remembered filter set — a small `{ field: value }` object. Matches the API type. */
export type InsightViewFilters = Readonly<Record<string, string>>;

/** A saved insights view as the screen reads it. Paired Exact with the API's `InsightSavedViewView`. */
export interface InsightSavedViewView {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly reportKind: InsightReportKind;
  readonly filters: InsightViewFilters;
  readonly createdAt: string;
}

/** The editable fields a create sends. A request shape (suffix `Input`), not a response. */
export interface InsightSavedViewInput {
  readonly name: string;
  readonly reportKind: InsightReportKind;
  readonly filters: InsightViewFilters;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/saved-views`;
}

export async function listInsightSavedViews(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly InsightSavedViewView[]> {
  const { data } = await client.request<{ savedViews: readonly InsightSavedViewView[] }>({
    path: base(organizationSlug),
  });
  return data.savedViews;
}

export async function createInsightSavedView(
  client: ApiClient,
  organizationSlug: string,
  input: InsightSavedViewInput,
): Promise<InsightSavedViewView> {
  const { data } = await client.request<InsightSavedViewView>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

export async function deleteInsightSavedView(
  client: ApiClient,
  organizationSlug: string,
  viewId: string,
): Promise<readonly InsightSavedViewView[]> {
  const { data } = await client.request<{ savedViews: readonly InsightSavedViewView[] }>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(viewId)}`,
  });
  return data.savedViews;
}
