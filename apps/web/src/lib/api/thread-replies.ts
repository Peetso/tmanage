import type { ApiClient } from './client';

/**
 * x249 — the thread-reply endpoints, both behind the conversation caps (planning ref CH-05
 * "Thread").
 *
 * Two calls: read a message's thread (`GET .../messages/:messageId/thread`, `conversation.read`)
 * and reply to it (`POST .../messages/:messageId/thread`, `conversation.write`). A conversation
 * or message the caller may not reach is 404 — the same 404 an unknown or cross-tenant id
 * answers, because the API resolves both ids tenant-scoped before the relation check — so the
 * panel never has to tell the cases apart.
 */

/**
 * A thread reply as the API projects it — paired Exact with the API's `ThreadReplyView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`). `organizationId` is deliberately absent:
 * the API never echoes the tenant id into a response body, and neither does this declaration.
 */
export interface ThreadReplyView {
  readonly id: string;
  readonly conversationId: string;
  readonly rootMessageId: string;
  readonly authorMembershipId: string;
  readonly body: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

/** A message's thread — its replies, oldest first, and how many there are. */
export interface ThreadView {
  readonly rootMessageId: string;
  readonly replies: readonly ThreadReplyView[];
  readonly count: number;
}

function base(organizationSlug: string, conversationId: string, messageId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/thread`;
}

/** Read a message's thread, oldest first. */
export async function listThreadReplies(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): Promise<ThreadView> {
  const { data } = await client.request<ThreadView>({
    path: base(organizationSlug, conversationId, messageId),
  });
  return data;
}

/** Reply to a message's thread. */
export async function appendThreadReply(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
  body: string,
): Promise<ThreadReplyView> {
  const { data } = await client.request<ThreadReplyView>({
    method: 'POST',
    path: base(organizationSlug, conversationId, messageId),
    body: { body },
  });
  return data;
}
