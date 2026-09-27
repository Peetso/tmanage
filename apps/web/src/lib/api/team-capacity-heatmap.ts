import type { ApiClient } from './client';

/**
 * The team-capacity-heatmap endpoint — PEOPLE / module 14 (x193), gated on `work.read`.
 *
 * A read-only org-level roll-up: `GET …/people/capacity/heatmap?from=YYYY-MM-DD&weeks=N` returns a
 * member × week grid of utilisation, folded by the API from the per-person capacity (x170) and
 * allocation (x171) facts. Distinct from `person-capacity.ts` (one member's figure) and
 * `person-allocations.ts` (one project's allocations): this is the whole team, read-only.
 */

/** One member's utilisation in one week bucket. Nested in {@link CapacityHeatmapView}, not a response itself. */
interface CapacityHeatmapCell {
  readonly weekStart: string;
  readonly allocatedPercent: number;
  readonly capacityHours: number;
  readonly allocatedHours: number;
  readonly utilisation: number | null;
  readonly overAllocated: boolean;
}

/** One member's row across the window. Nested in {@link CapacityHeatmapView}, not a response itself. */
interface CapacityHeatmapMember {
  readonly membershipId: string;
  readonly cells: readonly CapacityHeatmapCell[];
}

/** The team capacity heatmap — paired Exact with the API's `CapacityHeatmapView`. */
export interface CapacityHeatmapView {
  readonly from: string;
  readonly weeks: number;
  readonly weekStarts: readonly string[];
  readonly members: readonly CapacityHeatmapMember[];
}

/** The window a read requests. Request-side (suffix `Query`), so the contracts gate ignores it. */
export interface TeamCapacityHeatmapQuery {
  readonly from: string;
  readonly weeks: number;
}

/** Read the team capacity heatmap for a window. */
export async function getTeamCapacityHeatmap(
  client: ApiClient,
  organizationSlug: string,
  query: TeamCapacityHeatmapQuery,
): Promise<CapacityHeatmapView> {
  const parameters = new URLSearchParams({ from: query.from, weeks: String(query.weeks) });
  const { data } = await client.request<CapacityHeatmapView>({
    path: `/v1/organizations/${encodeURIComponent(
      organizationSlug,
    )}/people/capacity/heatmap?${parameters.toString()}`,
  });
  return data;
}
