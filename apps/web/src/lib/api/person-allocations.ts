import type { ApiClient } from './client';

/**
 * The person-allocations endpoints — PEOPLE / module 14 (x171), gated on `project.manage` (assign) /
 * `work.read` (list). Nested under a project: every path names the project the allocation belongs to,
 * tenant-scoped by the API.
 *
 * - **An allocation assigns a member a share of their time.** `POST …/projects/:id/allocations`
 *   records an allocation (a membership, a percent 1..100, an optional start/end date).
 * - **The list is a project's.** `GET …/projects/:id/allocations` lists one project's allocations in
 *   creation order, tenant-scoped by the API.
 */

export interface PersonAllocationSummary {
  readonly id: string;
  readonly projectId: string;
  readonly membershipId: string;
  readonly percent: number;
  /** A calendar date `YYYY-MM-DD`, or null. */
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
  /** 53-08 (R20-b): `tentative` allocations stay out of planned hours until confirmed. */
  readonly status: 'tentative' | 'confirmed';
  /** 53-08 (R20-b): explicit weekly hours; null means `percent` of the member's capacity. */
  readonly hoursPerWeek: number | null;
  readonly note: string | null;
}

export async function listPersonAllocations(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  query: { readonly limit?: number } = {},
): Promise<readonly PersonAllocationSummary[]> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<{ allocations: readonly PersonAllocationSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/allocations${suffix}`,
  });
  return data.allocations;
}

export interface CreatePersonAllocationInput {
  readonly membershipId: string;
  /** The share of the member's time, 1..100. */
  readonly percent: number;
  readonly startDate?: string;
  readonly endDate?: string;
}

export async function createPersonAllocation(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: CreatePersonAllocationInput,
): Promise<PersonAllocationSummary> {
  const { data } = await client.request<PersonAllocationSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/allocations`,
    body: input,
  });
  return data;
}
