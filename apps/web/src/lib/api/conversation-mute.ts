import type { ApiClient } from './client';

/**
 * CH-09 conversation mute (module Chat, x252) — the caller's own mute/unmute state for a
 * conversation, read and replaced. Behind `conversation.read` on the server (muting is a personal
 * notification preference, not a change to the channel); a caller without it gets the ordinary 403
 * the shared client turns into an error. The tenant is the slug in the path resolved against the
 * caller's membership, and the *member* is the authenticated principal — never a value this client
 * supplies — so it can only ever read or write the caller's own state. A conversation in another
 * studio is a 404.
 */

/** The caller's mute state for a conversation. Paired Exact with the API view. */
export interface ConversationMuteView {
  readonly muted: boolean;
}

function path(organizationSlug: string, conversationId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(
    conversationId,
  )}/mute`;
}

export async function getConversationMute(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
): Promise<ConversationMuteView> {
  const { data } = await client.request<ConversationMuteView>({
    path: path(organizationSlug, conversationId),
  });
  return data;
}

export async function setConversationMute(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  muted: boolean,
): Promise<ConversationMuteView> {
  const { data } = await client.request<ConversationMuteView>({
    method: 'PUT',
    path: path(organizationSlug, conversationId),
    body: { muted },
  });
  return data;
}
