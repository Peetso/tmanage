import type { ApiClient } from './client';

/**
 * The period-comparison endpoint — x229, module 15's period-over-period read (audit: the insights
 * reads are single-period). Behind `work.read` on the server (the internal-read capability the
 * sibling insights reads reuse); a caller without it gets the ordinary 403 the shared client turns
 * into an error, and an unknown metric or a malformed/inverted window gets a 400.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the slug in the path
 * resolved against the caller's membership, never a value the caller supplies; the counts are
 * tenant-scoped in SQL and re-checked on the server, so this never returns another tenant's numbers.
 */

/** The metrics a comparison may be run over — mirrors the server's closed allowlist. */
export type ComparisonMetric = 'work_items_created' | 'meetings_held';

/** One window's contribution — its bounds echoed as ISO instants and the count computed over it. */
export interface PeriodResult {
  readonly start: string;
  readonly end: string;
  readonly value: number;
}

/**
 * A metric compared across two windows. `delta` is `b − a`; `pct` is the fractional change
 * `(b − a) / a`, and is `null` when the base window's count is 0 (divide-by-zero guarded server-side).
 */
export interface PeriodComparisonView {
  readonly metric: ComparisonMetric;
  readonly a: PeriodResult;
  readonly b: PeriodResult;
  readonly delta: number;
  readonly pct: number | null;
  readonly computedAt: string;
}

export async function fetchPeriodComparison(
  client: ApiClient,
  organizationSlug: string,
  params: { metric: ComparisonMetric; periodA: string; periodB: string },
): Promise<PeriodComparisonView> {
  const query = new URLSearchParams({
    metric: params.metric,
    periodA: params.periodA,
    periodB: params.periodB,
  });
  const { data } = await client.request<PeriodComparisonView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/compare?${query.toString()}`,
  });
  return data;
}
