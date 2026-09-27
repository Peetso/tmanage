import type { RichTextDocument } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * x248 — CH-07's "Save" message action. A member privately saves/unsaves a chat message and lists
 * their saved messages across conversations. Distinct from document bookmarks (x242).
 *
 * Two shapes are the API's own and worth stating before a screen uses them:
 *
 * - **The toggle is idempotent.** `PUT …/bookmark` answers 200 whether or not the message was
 *   already saved, and `DELETE …/bookmark` answers 204 whether or not there was a save to remove.
 *   A screen never has to distinguish "already saved" from "just saved".
 * - **The list follows readability.** `GET /message-bookmarks` returns only saved messages in
 *   conversations the caller still reads; a message in a channel they have since left drops out,
 *   and a moderated message comes back with `body`/`bodyRich` `null` — the tombstone is the
 *   screen's to draw, exactly as the channel view draws it.
 */

export interface SavedMessageSummary {
  readonly messageId: string;
  readonly conversationId: string;
  readonly authorUserId: string;
  readonly sequenceNo: number;
  /** `null` once the message has been moderated. */
  readonly body: string | null;
  readonly bodyRich: RichTextDocument | null;
  readonly bookmarkedAt: string;
}

function bookmarkPath(organizationSlug: string, conversationId: string, messageId: string): string {
  return (
    `/v1/organizations/${encodeURIComponent(organizationSlug)}` +
    `/conversations/${encodeURIComponent(conversationId)}` +
    `/messages/${encodeURIComponent(messageId)}/bookmark`
  );
}

export async function saveMessageBookmark(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  await client.request<{ saved: true }>({
    method: 'PUT',
    path: bookmarkPath(organizationSlug, conversationId, messageId),
  });
}

export async function removeMessageBookmark(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: bookmarkPath(organizationSlug, conversationId, messageId),
  });
}

export async function listMyMessageBookmarks(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly SavedMessageSummary[]> {
  const { data } = await client.request<{ messages: readonly SavedMessageSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/message-bookmarks`,
  });
  return data.messages;
}
