import type { ApiClient } from './client';

/**
 * The cross-project-dependency endpoints — PROJ / x309, gated on `project.manage`. Nested under a
 * project: every path names the project the edges belong to, tenant-scoped by the API, which derives
 * the project for the relation gate.
 *
 * - **An edge is created and removed, never edited.** `POST …/projects/:id/dependencies` records
 *   that the path project blocks another (that other project depends on it);
 *   `DELETE …/projects/:id/dependencies/:blockedProjectId` removes it.
 * - **The list is one project's graph.** `GET …/projects/:id/dependencies` returns the projects the
 *   path project blocks (`blocking`) and the projects that block it (`blockedBy`), each in creation
 *   order, tenant-scoped by the API.
 */

export interface ProjectDependency {
  readonly edgeId: string;
  readonly blockerProjectId: string;
  readonly blockedProjectId: string;
  /** The name of the neighbouring project this edge points at. */
  readonly projectName: string;
  readonly projectStatus: string;
  readonly note: string | null;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

export interface ProjectDependencyGraph {
  readonly blocking: readonly ProjectDependency[];
  readonly blockedBy: readonly ProjectDependency[];
}

export async function listProjectDependencies(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  query: { readonly limit?: number } = {},
): Promise<ProjectDependencyGraph> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<ProjectDependencyGraph>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/dependencies${suffix}`,
  });
  return data;
}

export async function createProjectDependency(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: { readonly blockedProjectId: string; readonly note?: string | null },
): Promise<ProjectDependency> {
  const { data } = await client.request<ProjectDependency>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/dependencies`,
    body: {
      blockedProjectId: input.blockedProjectId,
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
  });
  return data;
}

export async function deleteProjectDependency(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  blockedProjectId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/dependencies/${encodeURIComponent(blockedProjectId)}`,
  });
}
