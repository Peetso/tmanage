import type { ApiClient } from './client';

/**
 * PROJ project favorites (x268) — a member's private favorites over projects for the compact project
 * switcher. Read the caller's favorite status of one project, star/unstar it, and list the caller's
 * favorites. All are behind the `work.read` capability the API enforces (a member favorites a project
 * they may read); this module wraps only what the star toggle and the switcher consume, the discipline
 * the contracts gate enforces on this folder.
 */

/**
 * One of the caller's favorited projects — paired Exact with the API's `ProjectFavoriteView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`). `organizationId`/`membershipId` are absent on
 * both sides: the wire projection never echoes the tenant id, and the membership is always the
 * caller's own.
 */
export interface ProjectFavoriteSummary {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly status: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

function favoriteBase(organizationSlug: string, projectId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/favorite`;
}

function listBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/favorites`;
}

/** Whether the caller has favorited a project. */
export async function getProjectFavoriteStatus(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<boolean> {
  const { data } = await client.request<{ favorited: boolean }>({
    path: favoriteBase(organizationSlug, projectId),
  });
  return data.favorited;
}

/** Favorite a project for the caller. Idempotent: a repeated call returns the same summary. */
export async function addProjectFavorite(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<ProjectFavoriteSummary> {
  const { data } = await client.request<ProjectFavoriteSummary>({
    method: 'PUT',
    path: favoriteBase(organizationSlug, projectId),
  });
  return data;
}

/** Unfavorite a project for the caller. Idempotent: no favorite is still success. */
export async function removeProjectFavorite(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: favoriteBase(organizationSlug, projectId),
  });
}

/** List the caller's favorited projects, newest first, for the switcher. */
export async function listProjectFavorites(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ProjectFavoriteSummary[]> {
  const { data } = await client.request<{ favorites: readonly ProjectFavoriteSummary[] }>({
    path: listBase(organizationSlug),
  });
  return data.favorites;
}
