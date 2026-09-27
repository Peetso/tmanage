import type { ApiClient } from './client';

/**
 * The chat message-pin endpoints — x247, CH-07 "Message actions" (pin) and CH-02 "pinned context".
 *
 * Pinning and unpinning are behind `conversation.moderate` (curating a channel's context is a
 * moderation act); reading the pinned strip is behind `conversation.read`. A pin is a *reference* —
 * its conversation and message ids — never a copy of the message body, so the pinned strip resolves
 * each pin against the messages the channel view already holds. The write resolves the message
 * tenant-scoped before it authorizes, so an unknown or cross-tenant id is a 404; the pinned set is
 * capped, so a pin past the cap is a 409.
 */

/**
 * One pinned message — the API's `PinnedMessageView`, exactly. A reference kept at the top of a
 * conversation, oldest first when listed.
 */
export interface PinnedMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly pinnedByUserId: string;
  readonly pinnedAt: string;
}

export async function listPins(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
): Promise<readonly PinnedMessage[]> {
  const { data } = await client.request<{ pins: readonly PinnedMessage[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(conversationId)}/pins`,
  });
  return data.pins;
}

/** Pin a message. Idempotent: pinning an already-pinned message returns the existing pin. */
export async function pinMessage(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): Promise<PinnedMessage> {
  const { data } = await client.request<PinnedMessage>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/pin`,
  });
  return data;
}

/** Unpin a message. Idempotent: unpinning a message that is not pinned still answers 204. */
export async function unpinMessage(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/pin`,
  });
}
