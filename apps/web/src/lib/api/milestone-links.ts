import type { ApiClient } from './client';

/**
 * The milestone-dependency endpoints — PROJ / module 8 (x236), gated on `project.manage`. Nested
 * under a milestone: every path names the milestone the dependencies belong to, tenant-scoped by the
 * API, which derives the milestone's project for the relation gate.
 *
 * - **A dependency is created and removed, never edited.** `POST …/milestones/:id/links` records that
 *   a milestone depends on another; `DELETE …/milestones/:id/links/:dependsOnMilestoneId` removes it.
 * - **The list is one milestone's.** `GET …/milestones/:id/links` lists the milestones one milestone
 *   depends on, in creation order, tenant-scoped by the API.
 */

/** A milestone's lifecycle state, mirroring the API's `ProjectMilestoneStatus`. */
export type MilestoneLinkStatus = 'planned' | 'met' | 'missed';

export interface MilestoneLink {
  readonly linkId: string;
  readonly milestoneId: string;
  readonly dependsOnMilestoneId: string;
  readonly dependsOnTitle: string;
  readonly dependsOnStatus: MilestoneLinkStatus;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

export async function listMilestoneDependencies(
  client: ApiClient,
  organizationSlug: string,
  milestoneId: string,
  query: { readonly limit?: number } = {},
): Promise<readonly MilestoneLink[]> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<{ dependencies: readonly MilestoneLink[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/milestones/${encodeURIComponent(milestoneId)}/links${suffix}`,
  });
  return data.dependencies;
}

export async function linkMilestoneDependency(
  client: ApiClient,
  organizationSlug: string,
  milestoneId: string,
  dependsOnMilestoneId: string,
): Promise<MilestoneLink> {
  const { data } = await client.request<MilestoneLink>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/milestones/${encodeURIComponent(milestoneId)}/links`,
    body: { dependsOnMilestoneId },
  });
  return data;
}

export async function unlinkMilestoneDependency(
  client: ApiClient,
  organizationSlug: string,
  milestoneId: string,
  dependsOnMilestoneId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/milestones/${encodeURIComponent(milestoneId)}/links/${encodeURIComponent(dependsOnMilestoneId)}`,
  });
}
