import type { ApiClient } from './client';

/**
 * Conversation read-state endpoints (module CHAT, CH-05 "unread position", x250).
 *
 * A member's own last-read position per channel, and the unread count computed from it. The subject
 * is always the authenticated caller — no shape here names another member — so a screen reads and
 * advances the viewer's own position. `markRead` is a PUT: the composer calls it when a channel is
 * opened, and the client's CSRF handling covers the unsafe method (see `ApiClient`).
 */

/** The read position and unread count for one conversation. */
export interface ConversationReadStateView {
  readonly conversationId: string;
  readonly lastReadMessageId: string | null;
  readonly readAt: string | null;
  readonly unreadCount: number;
}

/** One entry of the "all my conversations" unread view — what the sidebar badge is drawn from. */
export interface ConversationUnreadView {
  readonly conversationId: string;
  readonly lastReadMessageId: string | null;
  readonly unreadCount: number;
}

export async function getConversationReadState(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
): Promise<ConversationReadStateView> {
  const { data } = await client.request<ConversationReadStateView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(
      conversationId,
    )}/read-state`,
  });
  return data;
}

export async function listConversationUnread(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ConversationUnreadView[]> {
  const { data } = await client.request<{ conversations: readonly ConversationUnreadView[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/read-state`,
  });
  return data.conversations;
}

export async function markConversationRead(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  lastReadMessageId: string,
): Promise<ConversationReadStateView> {
  const { data } = await client.request<ConversationReadStateView>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(
      conversationId,
    )}/read-state`,
    body: { lastReadMessageId },
  });
  return data;
}
