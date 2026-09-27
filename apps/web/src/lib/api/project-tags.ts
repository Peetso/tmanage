import type { ApiClient } from './client';

/**
 * Project tags / labels (Projects / portfolio module, x267).
 *
 * This module wraps the project-tags API: list and define org-scoped tag definitions, and
 * assign / list / remove tags on a project. Two response shapes are exported and paired Exact with
 * the API's projections — {@link ProjectTag} (a definition, Exact with `ProjectTagView`) and
 * {@link ProjectTagAssignment} (a tag on a project, Exact with `ProjectTagAssignmentView`).
 * `organizationId` is absent on both, as on every wire projection.
 */

/** One tag definition — paired Exact with the API's `ProjectTagView`. */
export interface ProjectTag {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** One tag assigned to a project — paired Exact with the API's `ProjectTagAssignmentView`. */
export interface ProjectTagAssignment {
  readonly id: string;
  readonly projectId: string;
  readonly tagId: string;
  readonly name: string;
  readonly createdAt: string;
}

function orgBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

/** List the organization's tag definitions, name-ascending. */
export async function listProjectTags(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ProjectTag[]> {
  const { data } = await client.request<{ tags: readonly ProjectTag[] }>({
    path: `${orgBase(organizationSlug)}/projects/tags`,
  });
  return data.tags;
}

/** Define a tag. */
export async function defineProjectTag(
  client: ApiClient,
  organizationSlug: string,
  name: string,
): Promise<ProjectTag> {
  const { data } = await client.request<ProjectTag>({
    method: 'POST',
    path: `${orgBase(organizationSlug)}/projects/tags`,
    body: { name },
  });
  return data;
}

/** List the tags assigned to a project. */
export async function listProjectTagAssignments(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly ProjectTagAssignment[]> {
  const { data } = await client.request<{ tags: readonly ProjectTagAssignment[] }>({
    path: `${orgBase(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tags`,
  });
  return data.tags;
}

/** Tag a project (idempotent). */
export async function assignProjectTag(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  tagId: string,
): Promise<ProjectTagAssignment> {
  const { data } = await client.request<ProjectTagAssignment>({
    method: 'PUT',
    path: `${orgBase(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tags/${encodeURIComponent(tagId)}`,
  });
  return data;
}

/** Untag a project. */
export async function removeProjectTag(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  tagId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${orgBase(organizationSlug)}/projects/${encodeURIComponent(projectId)}/tags/${encodeURIComponent(tagId)}`,
  });
}
