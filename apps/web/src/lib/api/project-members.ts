import type { ApiClient } from './client';

/**
 * ADM-02 — project member and role administration, behind `project.member.manage`.
 *
 * Tenant-scoped like `projects.ts`: the organization slug is in the path, resolved by the API's
 * `TenantContextGuard` against a membership row before any handler runs, and the project id is
 * resolved inside that tenant before any write. A caller who is not a member of the project, or
 * who names one from another tenant, is refused with the same not-found as a project that does
 * not exist — nothing here lets a non-member enumerate a studio's projects.
 *
 * These rows carry a `userId`, not a display name: `project_memberships` stores only the id, so
 * the screen resolves names against the member directory (`members.ts`) by `userId` rather than
 * asking this endpoint to duplicate them.
 */

export interface ProjectMemberSummary {
  readonly projectMembershipId: string;
  readonly userId: string;
  readonly role: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

export interface AddProjectMemberInput {
  readonly userId: string;
  readonly role: string;
}

export interface ChangeProjectMemberRoleInput {
  readonly role: string;
  /** The role the caller believes is current — the API's compare-and-swap token. */
  readonly expectedRole: string;
}

function base(organizationSlug: string, projectId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/members`;
}

export async function listProjectMembers(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly ProjectMemberSummary[]> {
  const { data } = await client.request<{ members: readonly ProjectMemberSummary[] }>({
    path: base(organizationSlug, projectId),
  });
  return data.members;
}

export async function addProjectMember(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: AddProjectMemberInput,
): Promise<ProjectMemberSummary> {
  const { data } = await client.request<ProjectMemberSummary>({
    method: 'POST',
    path: base(organizationSlug, projectId),
    body: input,
  });
  return data;
}

export async function changeProjectMemberRole(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  projectMembershipId: string,
  input: ChangeProjectMemberRoleInput,
): Promise<ProjectMemberSummary> {
  const { data } = await client.request<ProjectMemberSummary>({
    method: 'PATCH',
    path: `${base(organizationSlug, projectId)}/${encodeURIComponent(projectMembershipId)}`,
    body: input,
  });
  return data;
}

export async function removeProjectMember(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  projectMembershipId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug, projectId)}/${encodeURIComponent(projectMembershipId)}`,
  });
}
