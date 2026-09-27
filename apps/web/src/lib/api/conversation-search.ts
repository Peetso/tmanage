import type { ApiClient } from './client';

/**
 * CH-10 "Search in conversation" (x253). One read endpoint: find the messages of a single
 * conversation whose body matches a term, with a permission-safe snippet.
 *
 * The API resolves the conversation and applies `conversation.read` before it reads anything, so
 * a channel in another tenant answers 404 exactly as one that does not exist — a link to a
 * search result is a link a colleague who can read the channel can follow. A blank query returns
 * an empty result rather than an error.
 */

export interface MessageSearchMatch {
  readonly id: string;
  readonly conversationId: string;
  readonly authorUserId: string;
  readonly sequenceNo: number;
  readonly createdAt: string;
  /** A window of the body around the match, truncated with ellipses when clipped. */
  readonly snippet: string;
}

export interface SearchMessagesQuery {
  readonly q: string;
  /** 1-based page number. */
  readonly page?: number;
  readonly limit?: number;
}

export async function searchConversationMessages(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  query: SearchMessagesQuery,
): Promise<readonly MessageSearchMatch[]> {
  const parameters = new URLSearchParams();
  parameters.set('q', query.q);
  if (query.page !== undefined) parameters.set('page', String(query.page));
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));

  const { data } = await client.request<{ results: readonly MessageSearchMatch[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(conversationId)}/messages/search?${parameters.toString()}`,
  });
  return data.results;
}
