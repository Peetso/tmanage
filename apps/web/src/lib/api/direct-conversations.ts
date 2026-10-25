import type { ApiClient } from './client';

/**
 * Direct messages — BK3 (COL-03) and its read-state half (0dece203).
 *
 * `…/direct-conversations` is the caller's own list (most recent first, each with its unread
 * count), create-or-get by the other person's user id, the transcript on the sequence-number
 * cursor, a post that dedupes on `clientGeneratedId`, and a forward-only mark-read. A pair the
 * relation rule refuses — a client and a teammate who share no project — is a 404, the same
 * answer as a person who does not exist, so the screen words it as the rule, never as "not found".
 */

export interface DirectConversationSummary {
  readonly id: string;
  readonly otherUserId: string;
  readonly otherDisplayName: string | null;
  /** C5: the other person's job title in this studio, when they set one. */
  readonly otherJobTitle: string | null;
  /** C5: the client company of a client participant; null for a team member. */
  readonly otherClientCompanyName: string | null;
  /** C5: whether the other person posted in this studio in the last five minutes. */
  readonly otherOnline: boolean;
  readonly lastMessageAt: string | null;
  readonly createdAt: string;
  readonly lastSequenceNo: number;
  readonly lastReadSequenceNo: number;
  readonly unreadCount: number;
}

export interface DirectMessageSummary {
  readonly id: string;
  readonly directConversationId: string;
  readonly authorUserId: string;
  readonly sequenceNo: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface DirectReadState {
  readonly directConversationId: string;
  readonly lastSequenceNo: number;
  readonly lastReadSequenceNo: number;
  readonly unreadCount: number;
}

/** The API's page ceiling for a transcript read. */
export const MAX_DIRECT_PAGE = 200;

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/direct-conversations`;
}

export async function listDirectConversations(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly DirectConversationSummary[]> {
  return (await fetchDirectConversations(client, organizationSlug)).conversations;
}

/** C5: the list plus the caller's own user id, which "New message" leaves out of its lists. */
export interface DirectConversationsOverview {
  readonly conversations: readonly DirectConversationSummary[];
  readonly viewerUserId: string | null;
}

export async function fetchDirectConversations(
  client: ApiClient,
  organizationSlug: string,
): Promise<DirectConversationsOverview> {
  const { data } = await client.request<{
    conversations?: readonly DirectConversationSummary[];
    viewerUserId?: unknown;
  }>({
    path: base(organizationSlug),
  });
  return {
    conversations: Array.isArray(data?.conversations) ? data.conversations : [],
    viewerUserId: typeof data?.viewerUserId === 'string' ? data.viewerUserId : null,
  };
}

/** Create-or-get the conversation with `userId`. The same row comes back on a second call. */
export async function openDirectConversation(
  client: ApiClient,
  organizationSlug: string,
  userId: string,
): Promise<DirectConversationSummary> {
  const { data } = await client.request<DirectConversationSummary>({
    method: 'POST',
    path: base(organizationSlug),
    body: { userId },
  });
  return data;
}

export async function listDirectMessages(
  client: ApiClient,
  organizationSlug: string,
  directConversationId: string,
  options: { readonly afterSequenceNo?: number; readonly limit?: number } = {},
): Promise<readonly DirectMessageSummary[]> {
  const parameters = new URLSearchParams();
  if (options.afterSequenceNo !== undefined) {
    parameters.set('afterSequenceNo', String(options.afterSequenceNo));
  }
  if (options.limit !== undefined) parameters.set('limit', String(options.limit));
  const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
  const { data } = await client.request<{ messages?: readonly DirectMessageSummary[] }>({
    path: `${base(organizationSlug)}/${encodeURIComponent(directConversationId)}/messages${suffix}`,
  });
  return Array.isArray(data?.messages) ? data.messages : [];
}

/**
 * Post a message. `clientGeneratedId` is minted once per send attempt and kept across its
 * retries, so a retry after a lost answer is the same message (200), never a second one.
 */
export async function postDirectMessage(
  client: ApiClient,
  organizationSlug: string,
  directConversationId: string,
  input: { readonly body: string; readonly clientGeneratedId: string },
): Promise<DirectMessageSummary> {
  const { data } = await client.request<DirectMessageSummary>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(directConversationId)}/messages`,
    body: input,
  });
  return data;
}

/** Mark read up to `lastReadSequenceNo`, or to the latest message when it is omitted. */
export async function markDirectConversationRead(
  client: ApiClient,
  organizationSlug: string,
  directConversationId: string,
  lastReadSequenceNo?: number,
): Promise<DirectReadState> {
  const { data } = await client.request<DirectReadState>({
    method: 'PUT',
    path: `${base(organizationSlug)}/${encodeURIComponent(directConversationId)}/read-state`,
    body: lastReadSequenceNo === undefined ? {} : { lastReadSequenceNo },
  });
  return data;
}

export const directKeys = {
  list: (organizationSlug: string) => ['direct-conversations', organizationSlug] as const,
  /** C5: the list with the viewer's id — under `list`, so invalidating the list refreshes it. */
  overview: (organizationSlug: string) =>
    ['direct-conversations', organizationSlug, 'overview'] as const,
  messages: (organizationSlug: string, directConversationId: string) =>
    ['direct-messages', organizationSlug, directConversationId] as const,
};
