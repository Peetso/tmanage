import type { ApiClient } from './client';

/**
 * Billing cost centers — Billing module 19 (x281).
 *
 * This module wraps the cost-centers API: list the organization's cost centers with their assigned
 * project ids, create a definition, delete one, and assign / unassign a project. The one exported
 * response shape is {@link CostCenterSummary}, paired Exact with the API's `CostCenterView` in the
 * contracts gate so the two cannot drift.
 *
 * Every read and write is gated on the server by `org.manage` — owners only — so a member who reaches
 * this client gets the ordinary 403 the shared client turns into an error; there is no organization-id
 * argument here, because the tenant is the slug in the path resolved against the caller's membership,
 * never a value the caller supplies. Definitions and assignments only — nothing here stores an amount
 * or charges.
 */

/**
 * One cost center — paired Exact with the API's `CostCenterView`. `organizationId` is absent on both
 * sides: the wire projection never echoes the tenant id.
 */
export interface CostCenterSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly projectIds: readonly string[];
}

/** The fields a create sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface CreateCostCenterInput {
  readonly code: string;
  readonly name: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/billing/cost-centers`;
}

/** List the organization's cost centers with their assigned project ids. */
export async function listCostCenters(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly CostCenterSummary[]> {
  const { data } = await client.request<{ readonly costCenters: readonly CostCenterSummary[] }>({
    path: base(organizationSlug),
  });
  return data.costCenters;
}

/** Create a cost-center definition. */
export async function createCostCenter(
  client: ApiClient,
  organizationSlug: string,
  input: CreateCostCenterInput,
): Promise<CostCenterSummary> {
  const { data } = await client.request<CostCenterSummary>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Delete a cost center and its assignments. */
export async function deleteCostCenter(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}`,
  });
}

/** Assign a project to a cost center (idempotent). */
export async function assignCostCenterProject(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  projectId: string,
): Promise<void> {
  await client.request<void>({
    method: 'PUT',
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}/projects/${encodeURIComponent(projectId)}`,
  });
}

/** Remove a project assignment from a cost center (idempotent). */
export async function unassignCostCenterProject(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  projectId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}/projects/${encodeURIComponent(projectId)}`,
  });
}
