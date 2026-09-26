import type { ApiClient } from './client';

/**
 * The objective→work-links endpoints — PROJ / module 8 (x138), gated on `project.manage` (link,
 * unlink) / `work.read` (list). Nested under an objective: every path names the objective the links
 * belong to, tenant-scoped by the API, which derives the objective's project for the relation gate.
 *
 * - **A link is created and removed, never edited.** `POST …/objectives/:id/work-links` records that a
 *   work item advances the objective; `DELETE …/objectives/:id/work-links/:linkId` removes it.
 * - **The list is one objective's.** `GET …/objectives/:id/work-links` lists the work linked to one
 *   objective in creation order, tenant-scoped by the API.
 */

export interface ObjectiveWorkLink {
  readonly linkId: string;
  readonly objectiveId: string;
  readonly workItemId: string;
  readonly workItemTitle: string;
  readonly workItemState: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

export async function listObjectiveWorkLinks(
  client: ApiClient,
  organizationSlug: string,
  objectiveId: string,
  query: { readonly limit?: number } = {},
): Promise<readonly ObjectiveWorkLink[]> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<{ workLinks: readonly ObjectiveWorkLink[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/objectives/${encodeURIComponent(objectiveId)}/work-links${suffix}`,
  });
  return data.workLinks;
}

export async function linkWorkItemToObjective(
  client: ApiClient,
  organizationSlug: string,
  objectiveId: string,
  workItemId: string,
): Promise<ObjectiveWorkLink> {
  const { data } = await client.request<ObjectiveWorkLink>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/objectives/${encodeURIComponent(objectiveId)}/work-links`,
    body: { workItemId },
  });
  return data;
}

export async function unlinkWorkItemFromObjective(
  client: ApiClient,
  organizationSlug: string,
  objectiveId: string,
  linkId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/objectives/${encodeURIComponent(objectiveId)}/work-links/${encodeURIComponent(linkId)}`,
  });
}
