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

/** C5: how many message ids one batched read names (the API's ceiling is 200). */
export const REACTION_BATCH_LIMIT = 100;

/** C5: the tallies of several messages of one conversation, in one request. */
export async function listMessageReactions(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageIds: readonly string[],
): Promise<readonly MessageReactionTally[]> {
  const parameters = new URLSearchParams({ messageIds: messageIds.join(',') });
  const { data } = await client.request<{ tallies?: readonly MessageReactionTally[] }>({
    path:
      `/v1/organizations/${encodeURIComponent(organizationSlug)}` +
      `/conversations/${encodeURIComponent(conversationId)}/reactions?${parameters.toString()}`,
  });
  return Array.isArray(data?.tallies) ? data.tallies : [];
}

interface PendingTally {
  readonly resolve: (tally: MessageReactionTally) => void;
  readonly reject: (error: unknown) => void;
}

const pendingByClient = new WeakMap<ApiClient, Map<string, Map<string, PendingTally[]>>>();

/**
 * C5 — one message's tally, read together with every other message asked for in the same tick.
 *
 * Each message's reaction pills ask for their own tally when they mount, so a channel of fifty
 * messages used to send fifty GETs. Here the asks of one tick are collected per conversation and
 * sent as one `…/reactions?messageIds=` read (in chunks of {@link REACTION_BATCH_LIMIT}); each
 * caller gets its own message's tally back, an empty one when nobody reacted.
 */
export function getMessageReactionsBatched(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): Promise<MessageReactionTally> {
  return new Promise((resolve, reject) => {
    let byConversation = pendingByClient.get(client);
    if (byConversation === undefined) {
      byConversation = new Map();
      pendingByClient.set(client, byConversation);
    }
    const key = `${organizationSlug}\n${conversationId}`;
    let waiting = byConversation.get(key);
    if (waiting === undefined) {
      waiting = new Map();
      byConversation.set(key, waiting);
      const batch = waiting;
      const owner = byConversation;
      queueMicrotask(() => {
        owner.delete(key);
        void flushTallies(client, organizationSlug, conversationId, batch);
      });
    }
    const callers = waiting.get(messageId) ?? [];
    callers.push({ resolve, reject });
    waiting.set(messageId, callers);
  });
}

async function flushTallies(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  batch: ReadonlyMap<string, readonly PendingTally[]>,
): Promise<void> {
  const ids = [...batch.keys()];
  for (let start = 0; start < ids.length; start += REACTION_BATCH_LIMIT) {
    const chunk = ids.slice(start, start + REACTION_BATCH_LIMIT);
    try {
      const tallies = await listMessageReactions(client, organizationSlug, conversationId, chunk);
      const byId = new Map(tallies.map((tally) => [tally.messageId, tally]));
      for (const id of chunk) {
        const tally = byId.get(id) ?? { messageId: id, reactions: [] };
        for (const caller of batch.get(id) ?? []) caller.resolve(tally);
      }
    } catch (error) {
      for (const id of chunk) for (const caller of batch.get(id) ?? []) caller.reject(error);
    }
  }
}
