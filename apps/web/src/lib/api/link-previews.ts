import type { ApiClient } from './client';

/**
 * R7 slice 5 — what the worker unfurled for a message's first link. The browser never fetches the
 * linked page itself: it reads these rows, and refetches when the hub says `link_preview.ready` or,
 * while a row is still `pending`, on {@link LINK_PREVIEW_RETRY_MS}.
 */
export interface LinkPreview {
  readonly messageId: string;
  readonly url: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly imageUrl: string | null;
  readonly siteName: string | null;
  readonly status: 'pending' | 'ready' | 'failed';
}

/** The API's ceiling on one read. */
export const LINK_PREVIEW_BATCH_LIMIT = 50;

/** The backoff between refetches while a preview is pending. */
export const LINK_PREVIEW_RETRY_MS = 15_000;

/** The hub frame the worker sends once a preview is written. */
export const LINK_PREVIEW_READY_EVENT = 'link_preview.ready';

/** The previews of several messages of one conversation, in chunks of the API's ceiling. */
export async function listLinkPreviews(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageIds: readonly string[],
): Promise<readonly LinkPreview[]> {
  const found: LinkPreview[] = [];
  for (let start = 0; start < messageIds.length; start += LINK_PREVIEW_BATCH_LIMIT) {
    const chunk = messageIds.slice(start, start + LINK_PREVIEW_BATCH_LIMIT);
    const parameters = new URLSearchParams({ messageIds: chunk.join(',') });
    const { data } = await client.request<{ previews?: readonly LinkPreview[] }>({
      path:
        `/v1/organizations/${encodeURIComponent(organizationSlug)}` +
        `/conversations/${encodeURIComponent(conversationId)}/link-previews?${parameters.toString()}`,
    });
    if (Array.isArray(data?.previews)) found.push(...data.previews);
  }
  return found;
}

type Pending = Map<string, ((preview: LinkPreview | null) => void)[]>;
const pendingByClient = new WeakMap<ApiClient, Map<string, Pending>>();

/**
 * One message's preview, read together with every other message asked for in the same tick (the
 * attachments pattern): a page of cards is one request per 50 messages, not one per card.
 * `null` when the message has no preview row (no link, or the worker has not staged it yet).
 */
export function getLinkPreviewBatched(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): Promise<LinkPreview | null> {
  return new Promise((resolve) => {
    let byConversation = pendingByClient.get(client);
    if (byConversation === undefined) {
      byConversation = new Map();
      pendingByClient.set(client, byConversation);
    }
    const key = `${organizationSlug}\n${conversationId}`;
    let pending = byConversation.get(key);
    if (pending === undefined) {
      const batch: Pending = new Map();
      pending = batch;
      byConversation.set(key, batch);
      queueMicrotask(() => {
        byConversation?.delete(key);
        listLinkPreviews(client, organizationSlug, conversationId, [...batch.keys()])
          .then((previews) => {
            for (const [id, waiters] of batch) {
              const found = previews.find((preview) => preview.messageId === id) ?? null;
              waiters.forEach((done) => done(found));
            }
          })
          .catch(() => batch.forEach((waiters) => waiters.forEach((done) => done(null))));
      });
    }
    pending.set(messageId, [...(pending.get(messageId) ?? []), resolve]);
  });
}
