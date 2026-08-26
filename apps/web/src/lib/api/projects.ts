import type { ApiClient } from './client';

/**
 * The project and workspace endpoints — PROJ-001 and PROJ-002, behind `ON-03`.
 *
 * Every path here carries the organization slug, because these are the first **tenant-scoped**
 * endpoints this application calls. The slug is the claim under test: the API's
 * `TenantContextGuard` resolves it against a membership row before any handler runs, and a
 * slug the caller has no membership in produces the same refusal as one that does not exist.
 *
 * So the slug is safe to put in a URL — it is public, it is in every link a customer sends,
 * and holding it grants nothing. That is the opposite of the MFA challenge token, which is
 * deliberately kept out of URLs.
 */

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export async function listWorkspaces(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly WorkspaceSummary[]> {
  const { data } = await client.request<{ workspaces: readonly WorkspaceSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/workspaces`,
  });
  return data.workspaces;
}

export interface ProjectSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: string;
  readonly ownerUserId: string | null;
  /** A promise. Set when a milestone plan is confirmed, which is a later ticket. */
  readonly committedAt: string | null;
  /** An estimate. This is where `ON-03`'s target date lands. */
  readonly forecastAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface CreateProjectInput {
  readonly workspaceId: string;
  readonly name: string;
  /** `YYYY-MM-DD`. Named `targetDate` because that is what it is until a plan confirms it. */
  readonly targetDate?: string;
  readonly ownerUserId?: string;
}

export async function createProject(
  client: ApiClient,
  organizationSlug: string,
  input: CreateProjectInput,
): Promise<ProjectSummary> {
  const { data } = await client.request<ProjectSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects`,
    body: input,
  });
  return data;
}

export async function listProjects(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ProjectSummary[]> {
  const { data } = await client.request<{ projects: readonly ProjectSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects`,
  });
  return data.projects;
}
