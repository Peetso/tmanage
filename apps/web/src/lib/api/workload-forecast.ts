import type { ApiClient } from './client';

/**
 * The workload-forecast endpoint — x134, the forward-looking counterpart to INS-05's current
 * workload roll-up. Behind `work.read` on the server (the internal-read capability the workload read
 * reuses); a caller without it gets the ordinary 403 the shared client turns into an error.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the slug in the path
 * resolved against the caller's membership, never a value the caller supplies; the forecast spans the
 * projects that principal may read, so it never returns another tenant's numbers. The `?weeks`
 * horizon is 1..12 (default 4) — a value outside that range is a 400 the shared client surfaces.
 */

/**
 * One upcoming week. `committedItemCount` is the open, dated work the caller may read that is due in
 * it; `capacity` is the constant team capacity for the week; `overCapacity` flags a week whose
 * committed work exceeds it. Not exported directly (it is the element type of {@link
 * WorkloadForecastView.weeks}); re-exported below as an indexed-access alias for the screen.
 */
interface WorkloadForecastWeekRow {
  readonly weekIndex: number;
  readonly startsAt: string;
  readonly committedItemCount: number;
  readonly capacity: number;
  readonly overCapacity: boolean;
}

/**
 * The forecast aggregate. `memberCount` is the distinct owners carrying open work in scope (the
 * capacity basis); the item and capacity figures sum across the horizon; `overCapacityWeekCount` is
 * how many weeks exceed theirs.
 */
interface WorkloadForecastTotalsRow {
  readonly weeks: number;
  readonly memberCount: number;
  readonly committedItemCount: number;
  readonly capacity: number;
  readonly overCapacityWeekCount: number;
}

export interface WorkloadForecastView {
  readonly weeks: readonly WorkloadForecastWeekRow[];
  readonly totals: WorkloadForecastTotalsRow;
  readonly computedAt: string;
}

/** One week's row, named for the screen — the element type of {@link WorkloadForecastView.weeks}. */
export type WorkloadForecastWeek = WorkloadForecastView['weeks'][number];
/** The aggregate, named for the screen — the value type of {@link WorkloadForecastView.totals}. */
export type WorkloadForecastTotals = WorkloadForecastView['totals'];

export async function fetchWorkloadForecast(
  client: ApiClient,
  organizationSlug: string,
  options: { weeks?: number } = {},
): Promise<WorkloadForecastView> {
  const query = options.weeks === undefined ? '' : `?weeks=${encodeURIComponent(options.weeks)}`;
  const { data } = await client.request<WorkloadForecastView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/workload-forecast${query}`,
  });
  return data;
}
