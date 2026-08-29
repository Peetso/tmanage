import type { ApiClient } from './client';

/**
 * The one client-organization endpoint a non-portal screen needs today: whether — and to
 * whom — a project is shared. CLIENT-001's `GET projects/:id/clients`, behind
 * `project.manage`.
 *
 * The rest of CLIENT-001's thirteen routes (client organizations, their people, the shares'
 * create and delete) have no internal screen yet; functions for them belong to the session
 * that builds one, not here on speculation.
 */

export interface ProjectShare {
  readonly id: string;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  readonly createdAt: string;
}

export async function listProjectShares(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly ProjectShare[]> {
  const { data } = await client.request<{ clients: readonly ProjectShare[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/clients`,
  });
  return data.clients;
}
