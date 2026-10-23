import type { ApiClient } from './client';

/**
 * The @ picker's search — BK3 (COL-02), `GET …/conversations/:id/mention-candidates?q=`.
 *
 * Only people who can read the channel come back, the caller excluded. `mention` is the token to
 * put in the message body (`@<userId>`): the form the API reads when the message is posted, which
 * is what turns it into a mention notification.
 */

export interface MentionCandidate {
  readonly userId: string;
  readonly displayName: string;
  readonly mention: string;
}

export async function searchMentionCandidates(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  query: string,
  limit = 10,
): Promise<readonly MentionCandidate[]> {
  const parameters = new URLSearchParams();
  const q = query.trim().replace(/^@/u, '');
  if (q !== '') parameters.set('q', q);
  parameters.set('limit', String(limit));
  const { data } = await client.request<{ candidates?: readonly MentionCandidate[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(
      conversationId,
    )}/mention-candidates?${parameters.toString()}`,
  });
  return Array.isArray(data?.candidates) ? data.candidates : [];
}
