import type { ApiClient } from './client';

/**
 * The message-reaction endpoints — x246, CH-07 "Message actions".
 *
 * A reaction is the acting member's own: adding one the member already holds is a no-op, and a
 * member can only remove their own. Both the add and the tally return the whole tally, so a
 * screen redraws its counts from one answer rather than tracking them itself. `reacted` is
 * whether *this* member reacted with that emoji — what the chip's pressed state is drawn from.
 */

export interface MessageReactionTally {
  readonly messageId: string;
  readonly reactions: readonly {
    readonly emoji: string;
    readonly count: number;
    /** Whether the acting member reacted with this emoji. */
    readonly reacted: boolean;
  }[];
}

function base(organizationSlug: string, conversationId: string, messageId: string): string {
  return (
    `/v1/organizations/${encodeURIComponent(organizationSlug)}` +
    `/conversations/${encodeURIComponent(conversationId)}` +
    `/messages/${encodeURIComponent(messageId)}/reactions`
  );
}

/** Read a message's reaction tally. */
export async function getMessageReactions(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): Promise<MessageReactionTally> {
  const { data } = await client.request<MessageReactionTally>({
    path: base(organizationSlug, conversationId, messageId),
  });
  return data;
}

/** Add the acting member's reaction (idempotent). Returns the updated tally. */
export async function addMessageReaction(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
  emoji: string,
): Promise<MessageReactionTally> {
  const { data } = await client.request<MessageReactionTally>({
    method: 'PUT',
    path: base(organizationSlug, conversationId, messageId),
    body: { emoji },
  });
  return data;
}

/** Remove the acting member's reaction (idempotent). The API answers 204. */
export async function removeMessageReaction(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug, conversationId, messageId)}/${encodeURIComponent(emoji)}`,
  });
}
