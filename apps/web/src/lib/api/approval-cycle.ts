import type { ApiClient } from './client';

/**
 * The project approval-cycle endpoint — INS-02, the approval-cycle counterpart to INS-01's
 * delivery flow. Behind `approval.read` on the server (x92's approvals capability); a caller
 * without it gets the ordinary 403 the shared client turns into an error.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in
 * the `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the slug in the
 * path resolved against the caller's membership, never a value the caller supplies; the project
 * is the id on the route.
 */

/** The terminal outcomes the roll-up reports, in the order the API returns them. */
export type ApprovalCycleOutcome = 'approved' | 'changes_requested' | 'invalidated';

/**
 * One outcome's tally. `count` is every readable approval in the outcome; `decidedCount` is those
 * carrying a decision time; `totalDurationMs` sums the requested→decided spans of exactly those.
 * The mean is `totalDurationMs / decidedCount`, derived by the reader so no rounding is baked in.
 *
 * Not exported directly — it is the value type of {@link ApprovalCycle.metrics}, the one response
 * shape the contracts check pairs — but re-exported below as an indexed-access alias so the screen
 * can name it without a second top-level response type for the check to demand its own pair.
 */
interface OutcomeMetric {
  readonly count: number;
  readonly decidedCount: number;
  readonly totalDurationMs: number;
}

export interface ApprovalCycle {
  readonly projectId: string;
  readonly metrics: Record<ApprovalCycleOutcome, OutcomeMetric>;
  readonly approvalCount: number;
  readonly computedAt: string;
}

/** One outcome's tally, named for the screen — the value type of {@link ApprovalCycle.metrics}. */
export type ApprovalOutcomeMetric = ApprovalCycle['metrics'][ApprovalCycleOutcome];
export type ApprovalCycleMetrics = ApprovalCycle['metrics'];

export async function fetchProjectApprovalCycle(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<ApprovalCycle> {
  const { data } = await client.request<ApprovalCycle>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/projects/${encodeURIComponent(
      projectId,
    )}/approval-cycle`,
  });
  return data;
}
