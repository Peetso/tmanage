import type { ApiClient } from './client';

/**
 * 53-11 — the @ picker on a work item's comments,
 * `GET …/work-items/:workItemId/comments/mention-candidates?q=`.
 *
 * Only people who can see the item come back (staff on its project and members with
 * organization-wide scope), the caller excluded. `mention` is the token to send in the body
 * (`@<userId>`): the API turns it into a mention notice for that person.
 */

export interface WorkMentionCandidate {
  readonly userId: string;
  readonly displayName: string;
  readonly mention: string;
}

export async function searchWorkMentionCandidates(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  query: string,
  limit = 8,
): Promise<readonly WorkMentionCandidate[]> {
  const parameters = new URLSearchParams();
  const q = query.trim().replace(/^@/u, '');
  if (q !== '') parameters.set('q', q);
  parameters.set('limit', String(limit));
  const { data } = await client.request<{ candidates?: readonly WorkMentionCandidate[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(
      workItemId,
    )}/comments/mention-candidates?${parameters.toString()}`,
  });
  return Array.isArray(data?.candidates) ? data.candidates : [];
}
