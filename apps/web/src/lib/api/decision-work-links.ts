import type { ApiClient } from './client';

/**
 * The decision→work-links endpoints — DEC / module 12 (x149), gated on `meeting.write` (link, unlink)
 * / `work.read` (list). Nested under a decision: every path names the decision the links belong to,
 * tenant-scoped by the API, which derives the decision's project for the relation gate.
 *
 * - **A link is created and removed, never edited.** `POST …/decisions/:id/work-links` records that a
 *   work item was set in motion by the decision; `DELETE …/decisions/:id/work-links/:linkId` removes it.
 * - **The list is one decision's.** `GET …/decisions/:id/work-links` lists the work linked to one
 *   decision in creation order, tenant-scoped by the API.
 */

export interface DecisionWorkLink {
  readonly linkId: string;
  readonly decisionId: string;
  readonly workItemId: string;
  readonly workItemTitle: string;
  readonly workItemState: string;
  /** A15. The work item's owner by name; `null` when unowned. */
  readonly workItemOwnerName: string | null;
  /** A15. The work item's due instant (ISO-8601); `null` when it has none. */
  readonly workItemDueAt: string | null;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

export async function listDecisionWorkLinks(
  client: ApiClient,
  organizationSlug: string,
  decisionId: string,
  query: { readonly limit?: number } = {},
): Promise<readonly DecisionWorkLink[]> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<{ workLinks: readonly DecisionWorkLink[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/decisions/${encodeURIComponent(decisionId)}/work-links${suffix}`,
  });
  return data.workLinks;
}

export async function linkWorkItemToDecision(
  client: ApiClient,
  organizationSlug: string,
  decisionId: string,
  workItemId: string,
): Promise<DecisionWorkLink> {
  const { data } = await client.request<DecisionWorkLink>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/decisions/${encodeURIComponent(decisionId)}/work-links`,
    body: { workItemId },
  });
  return data;
}

export async function unlinkWorkItemFromDecision(
  client: ApiClient,
  organizationSlug: string,
  decisionId: string,
  linkId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/decisions/${encodeURIComponent(decisionId)}/work-links/${encodeURIComponent(linkId)}`,
  });
}
