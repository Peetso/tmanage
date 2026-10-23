import type { ApiClient } from './client';
import type { MessageSummary } from './conversations';

/**
 * A16 (chat basics) — the three channel calls the redesigned channel screen needs that
 * `conversations.ts` does not wrap yet: who is in the channel (the Members panel), adding a
 * person to it ("Add people"), and editing one's own message in place (the inline edit card).
 * All three are existing API routes (`conversations.controller.ts`); nothing new server-side.
 */

// Not exported: the API side is `ConversationMemberView`, already paired by its own reader; a
// second exported web projection would need its own contracts-check pairing for no gain.
interface ChannelMemberSummary {
  readonly userId: string;
  readonly joinedAt: string;
}

function conversationPath(organizationSlug: string, conversationId: string): string {
  return (
    `/v1/organizations/${encodeURIComponent(organizationSlug)}` +
    `/conversations/${encodeURIComponent(conversationId)}`
  );
}

export async function listChannelMembers(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
): Promise<readonly ChannelMemberSummary[]> {
  const { data } = await client.request<{ members: readonly ChannelMemberSummary[] }>({
    path: `${conversationPath(organizationSlug, conversationId)}/members`,
  });
  return data.members;
}

export async function addChannelMember(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  userId: string,
): Promise<ChannelMemberSummary> {
  const { data } = await client.request<ChannelMemberSummary>({
    method: 'POST',
    path: `${conversationPath(organizationSlug, conversationId)}/members`,
    body: { userId },
  });
  return data;
}

/** PATCH a plain-text message's body. The API keeps the replaced version as a revision. */
export async function editChannelMessage(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
  body: string,
): Promise<MessageSummary> {
  const { data } = await client.request<MessageSummary>({
    method: 'PATCH',
    path: `${conversationPath(organizationSlug, conversationId)}/messages/${encodeURIComponent(messageId)}`,
    body: { body },
  });
  return data;
}
