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

/**
 * R7 slice 4: the curated reaction set the API's `ALLOWED_REACTIONS` admits, in its order (the
 * earlier quick reactions first). The reaction picker offers exactly these, so a pick never
 * answers 400. One code point each except the heart, which keeps its variation selector.
 */
export const REACTION_SET: readonly string[] = Object.freeze(
  [
    0x1f44d, 0x1f44e, -1, 0x1f389, 0x1f604, 0x1f615, 0x1f680, 0x1f440, 0x2713, 0x263a, 0x2605,
    0x1f602, 0x1f60d, 0x1f622, 0x1f62e, 0x1f621, 0x1f64f, 0x1f44f, 0x1f525, 0x1f4af, 0x2705, 0x274c,
    0x1f914, 0x1f60a, 0x1f60e, 0x1f973, 0x1f929, 0x1f605, 0x1f923, 0x1f610, 0x1f634, 0x1f62c,
    0x1f917, 0x1f64c, 0x1f4aa, 0x1f91d, 0x1f44c, 0x270c, 0x1f44b, 0x1f449, 0x261d, 0x2b50, 0x2728,
    0x1f4a1, 0x1f4cc, 0x1f4ce, 0x23f0, 0x1f4c5, 0x1f381, 0x1f3c6, 0x1f947, 0x1f48e, 0x1f4b0,
    0x1f4c8, 0x1f6a9, 0x26a0, 0x2757, 0x2753, 0x1f4ac, 0x1f49c,
  ].map((code) => (code === -1 ? '❤️' : String.fromCodePoint(code))),
);

/** The six reactions the quick row offers before the full picker. */
export const QUICK_ROW: readonly string[] = REACTION_SET.filter((_, index) =>
  [0, 2, 11, 14, 16, 3].includes(index),
);
