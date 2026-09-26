import type { ApiClient } from './client';

/**
 * The project-objectives endpoints — PROJ / module 8 (x124), gated on `project.manage` (create,
 * transition) / `work.read` (list). Nested under a project: every path names the project the
 * objectives belong to, tenant-scoped by the API.
 *
 * - **An objective is created open and then closed.** `POST …/projects/:id/objectives` records an
 *   objective; `PATCH …/objectives/:objectiveId` transitions it to `met` or `missed`. There is no
 *   edit surface — an objective's wording is fixed once set.
 * - **The list is a project's.** `GET …/projects/:id/objectives` lists one project's objectives in
 *   creation order, tenant-scoped by the API.
 */

/** Where an objective sits in its lifecycle. Mirrors the API's `ProjectObjectiveStatus`. */
export type ProjectObjectiveStatus = 'open' | 'met' | 'missed';

/** The two statuses a transition may set: an objective closes to met or missed, never reopens. */
export type ProjectObjectiveOutcome = 'met' | 'missed';

export interface ProjectObjectiveSummary {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly target: string | null;
  readonly status: ProjectObjectiveStatus;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

export async function listProjectObjectives(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  query: { readonly limit?: number } = {},
): Promise<readonly ProjectObjectiveSummary[]> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<{ objectives: readonly ProjectObjectiveSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/objectives${suffix}`,
  });
  return data.objectives;
}

export interface CreateProjectObjectiveInput {
  readonly name: string;
  readonly description?: string;
  readonly target?: string;
  /** Optional; the API defaults it to `open`. */
  readonly status?: ProjectObjectiveStatus;
}

export async function createProjectObjective(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: CreateProjectObjectiveInput,
): Promise<ProjectObjectiveSummary> {
  const { data } = await client.request<ProjectObjectiveSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/objectives`,
    body: input,
  });
  return data;
}

/** Transition an objective: `open → met | missed`. */
export async function transitionProjectObjective(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  objectiveId: string,
  status: ProjectObjectiveOutcome,
): Promise<ProjectObjectiveSummary> {
  const { data } = await client.request<ProjectObjectiveSummary>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/objectives/${encodeURIComponent(objectiveId)}`,
    body: { status },
  });
  return data;
}
