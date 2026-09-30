import type { ApiClient } from './client';

/**
 * Billing spend-by-cost-centre report — Billing module 19 (x331).
 *
 * This module wraps the read-only report API: for each cost centre the organization defined (x281), the
 * number of projects assigned to it and their summed budget (x293). The one exported response shape is
 * {@link CostCenterReportRow}, paired Exact with the API's `CostCenterReportRowView` in the contracts
 * gate so the two cannot drift.
 *
 * The read is gated on the server by `org.manage` — owners only — so a member who reaches this client
 * gets the ordinary 403 the shared client turns into an error; there is no organization-id argument
 * here, because the tenant is the slug in the path resolved against the caller's membership, never a
 * value the caller supplies. Read-only: nothing here writes or charges.
 */

/**
 * One cost centre's roll-up — paired Exact with the API's `CostCenterReportRowView`. `organizationId`
 * is absent on both sides: the projection never echoes the tenant id. `currency` is `null` when the
 * cost centre budgets no amount or mixes currencies, in which case `totalBudgetAmountMinor` should not
 * be read as a single figure.
 */
export interface CostCenterReportRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly projectCount: number;
  readonly totalBudgetHours: number;
  readonly totalBudgetAmountMinor: number;
  readonly currency: string | null;
}

/** List the organization's spend-by-cost-centre roll-up, code-ascending. */
export async function getCostCenterReport(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly CostCenterReportRow[]> {
  const { data } = await client.request<{ readonly costCenters: readonly CostCenterReportRow[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/cost-center-report`,
  });
  return data.costCenters;
}
