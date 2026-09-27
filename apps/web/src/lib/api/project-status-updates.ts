import type { ApiClient } from './client';

/**
 * The project internal status-update endpoints — PROJ / module 8 (x235), gated on `project.manage`
 * (post, list). Nested under a project: every path names the project the updates belong to,
 * tenant-scoped by the API.
 *
 * This is the **internal** status changelog — the studio's own running log of where a project stands
 * (`on_track` / `at_risk` / `off_track`) with a free-text `body`. It is distinct from the client-facing
 * portal updates (x125): a different path (`…/projects/:id/status-updates`) and never projected to a
 * client.
 *
 * - **An update is posted.** `POST …/projects/:id/status-updates` posts a status update
 *   (status band + body).
 * - **The list is a project's.** `GET …/projects/:id/status-updates` lists one project's updates
 *   newest-first, keyset-paged (`before` cursor + `limit`), tenant-scoped by the API.
 */

/** The status band an update records. Mirrors the API's `status_band` enum. */
export type ProjectStatusBand = 'on_track' | 'at_risk' | 'off_track';

export interface ProjectStatusUpdateSummary {
  readonly id: string;
  readonly projectId: string;
  readonly statusBand: ProjectStatusBand;
  readonly body: string;
  readonly postedBy: string;
  /** An ISO-8601 instant. */
  readonly postedAt: string;
}

/** One keyset page of the log, mirroring the API's `ProjectStatusUpdatePage`. */
export interface ProjectStatusUpdatePage {
  readonly updates: readonly ProjectStatusUpdateSummary[];
  /** The id to pass as `before` for the next (older) page, or `null` when the log is exhausted. */
  readonly nextCursor: string | null;
}

export async function listProjectStatusUpdates(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  query: { readonly limit?: number; readonly before?: string } = {},
): Promise<ProjectStatusUpdatePage> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  if (query.before !== undefined) parameters.set('before', query.before);
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<ProjectStatusUpdatePage>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/status-updates${suffix}`,
  });
  return data;
}

export interface CreateProjectStatusUpdateInput {
  readonly statusBand: ProjectStatusBand;
  readonly body: string;
}

export async function createProjectStatusUpdate(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: CreateProjectStatusUpdateInput,
): Promise<ProjectStatusUpdateSummary> {
  const { data } = await client.request<ProjectStatusUpdateSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/status-updates`,
    body: input,
  });
  return data;
}
