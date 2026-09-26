import type { ApiClient } from './client';

/**
 * The org-objectives endpoints — PROJ / module 8 (x136), gated on `project.manage` (create,
 * transition) / `work.read` (list). Org-scoped, unlike the project objectives (x124): every path is
 * `…/organizations/:orgSlug/objectives`, tenant-scoped by the API, with no project in it.
 *
 * - **An objective is created open and then closed.** `POST …/objectives` records an objective;
 *   `PATCH …/objectives/:objectiveId` transitions it to `met` or `missed`. There is no edit surface —
 *   an objective's wording is fixed once set.
 * - **The list is the organization's.** `GET …/objectives` lists the organization's objectives in
 *   creation order, tenant-scoped by the API.
 */

/** Where an objective sits in its lifecycle. Mirrors the API's `OrgObjectiveStatus`. */
export type OrgObjectiveStatus = 'open' | 'met' | 'missed';

/** The two statuses a transition may set: an objective closes to met or missed, never reopens. */
export type OrgObjectiveOutcome = 'met' | 'missed';

export interface OrgObjectiveSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly target: string | null;
  readonly status: OrgObjectiveStatus;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

export async function listOrgObjectives(
  client: ApiClient,
  organizationSlug: string,
  query: { readonly limit?: number } = {},
): Promise<readonly OrgObjectiveSummary[]> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<{ objectives: readonly OrgObjectiveSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/objectives${suffix}`,
  });
  return data.objectives;
}

export interface CreateOrgObjectiveInput {
  readonly name: string;
  readonly description?: string;
  readonly target?: string;
  /** Optional; the API defaults it to `open`. */
  readonly status?: OrgObjectiveStatus;
}

export async function createOrgObjective(
  client: ApiClient,
  organizationSlug: string,
  input: CreateOrgObjectiveInput,
): Promise<OrgObjectiveSummary> {
  const { data } = await client.request<OrgObjectiveSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/objectives`,
    body: input,
  });
  return data;
}

/** Transition an objective: `open → met | missed`. */
export async function transitionOrgObjective(
  client: ApiClient,
  organizationSlug: string,
  objectiveId: string,
  status: OrgObjectiveOutcome,
): Promise<OrgObjectiveSummary> {
  const { data } = await client.request<OrgObjectiveSummary>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/objectives/${encodeURIComponent(objectiveId)}`,
    body: { status },
  });
  return data;
}
