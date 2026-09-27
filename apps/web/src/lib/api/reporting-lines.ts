import type { ApiClient } from './client';

/**
 * People reporting lines / org chart (module 14, x217).
 *
 * This module wraps the reporting-line API: read one member's manager, set or clear it, and read the
 * tenant's whole reporting tree. The one exported response shape is {@link ReportingLine}, paired Exact
 * with the API's `ReportingLineView` in the contracts gate. `organizationId` is absent on both sides —
 * the wire projection never echoes the tenant id.
 */

/**
 * One member's reporting line — paired Exact with the API's `ReportingLineView`. `managerMembershipId`
 * is `null` when the member has no manager (a root of the org chart).
 */
export interface ReportingLine {
  readonly membershipId: string;
  readonly managerMembershipId: string | null;
}

function managerPath(organizationSlug: string, membershipId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/people/${encodeURIComponent(
    membershipId,
  )}/manager`;
}

/** Read one member's reporting line. `managerMembershipId` is `null` when none is set. */
export async function getReportingLine(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
): Promise<ReportingLine> {
  const { data } = await client.request<{ reportingLine: ReportingLine }>({
    path: managerPath(organizationSlug, membershipId),
  });
  return data.reportingLine;
}

/** Set (or clear, with `null`) one member's manager. */
export async function setReportingManager(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
  managerMembershipId: string | null,
): Promise<ReportingLine> {
  const { data } = await client.request<ReportingLine>({
    method: 'PUT',
    path: managerPath(organizationSlug, membershipId),
    body: { managerMembershipId },
  });
  return data;
}

/** Read the tenant's whole reporting tree — every reporting line, as edges. */
export async function getOrgChart(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ReportingLine[]> {
  const { data } = await client.request<{ lines: readonly ReportingLine[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/people/org-chart`,
  });
  return data.lines;
}
