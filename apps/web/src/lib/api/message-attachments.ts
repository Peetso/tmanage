import type { ApiClient } from './client';

/**
 * x275 — CH-06's composer attachments. A message author links an already-uploaded file to their
 * message and detaches it; any reader of the conversation lists a message's attachments. There is
 * no upload here — the file already exists in the file store.
 *
 * Two shapes are the API's own and worth stating before a screen uses them:
 *
 * - **Attach is idempotent.** `POST …/attachments {fileId}` answers 201 for a new link and 200 for
 *   one that already existed, and `DELETE …/attachments/:fileId` answers 204 whether or not there
 *   was a link to remove. A composer that retries never double-links.
 * - **Only the author may attach or detach.** A caller who can read the conversation but did not
 *   author the message is refused (403); a caller with no relation to the conversation, or a file
 *   not in the tenant or not yet ready, is a 404. The list follows `conversation.read`.
 */

export interface MessageAttachmentSummary {
  readonly fileAssetId: string;
  readonly name: string;
  /** `null` before the file's first completed version. */
  readonly sizeBytes: number | null;
  readonly attachedAt: string;
  /**
   * L2 — the virus scan's word on the file, as the download door treats it. `clean` downloads;
   * `not_scanned` downloads marked "Not scanned" (B5); `being_checked` is refused until the scan is
   * done ("Block until scanned"); `unavailable` is never served. Absent from an older API: clean.
   */
  readonly scanStatus?: MessageAttachmentScanStatus;
}

export type MessageAttachmentScanStatus = 'clean' | 'not_scanned' | 'being_checked' | 'unavailable';

function attachmentsPath(
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): string {
  return (
    `/v1/organizations/${encodeURIComponent(organizationSlug)}` +
    `/conversations/${encodeURIComponent(conversationId)}` +
    `/messages/${encodeURIComponent(messageId)}/attachments`
  );
}

export async function attachMessageFile(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
  fileId: string,
): Promise<MessageAttachmentSummary> {
  const { data } = await client.request<MessageAttachmentSummary>({
    method: 'POST',
    path: attachmentsPath(organizationSlug, conversationId, messageId),
    body: { fileId },
  });
  return data;
}

export async function detachMessageFile(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
  fileId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${attachmentsPath(organizationSlug, conversationId, messageId)}/${encodeURIComponent(fileId)}`,
  });
}

export async function listMessageAttachments(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): Promise<readonly MessageAttachmentSummary[]> {
  const { data } = await client.request<{ attachments: readonly MessageAttachmentSummary[] }>({
    path: attachmentsPath(organizationSlug, conversationId, messageId),
  });
  return data.attachments;
}

/** L2: how many message ids one batched read names — one channel page, the API's own ceiling. */
export const ATTACHMENT_BATCH_LIMIT = 200;

/** L2: the attachments of several messages of one conversation, in one request. */
export async function listAttachmentsForMessages(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageIds: readonly string[],
): Promise<
  readonly {
    readonly messageId: string;
    readonly attachments: readonly MessageAttachmentSummary[];
  }[]
> {
  const parameters = new URLSearchParams({ messageIds: messageIds.join(',') });
  const { data } = await client.request<{
    messages?: readonly {
      readonly messageId: string;
      readonly attachments: readonly MessageAttachmentSummary[];
    }[];
  }>({
    path:
      `/v1/organizations/${encodeURIComponent(organizationSlug)}` +
      `/conversations/${encodeURIComponent(conversationId)}/attachments?${parameters.toString()}`,
  });
  return Array.isArray(data?.messages) ? data.messages : [];
}

interface PendingAttachments {
  readonly resolve: (attachments: readonly MessageAttachmentSummary[]) => void;
  readonly reject: (error: unknown) => void;
}

const pendingByClient = new WeakMap<ApiClient, Map<string, Map<string, PendingAttachments[]>>>();

/**
 * L2 — one message's attachments, read together with every other message asked for in the same
 * tick (C5's reactions pattern). A channel page mounts all its rows at once, so its rows' asks are
 * sent as one `…/attachments?messageIds=` read (in chunks of {@link ATTACHMENT_BATCH_LIMIT}); each
 * caller gets its own message's list back, an empty one when nothing is attached.
 */
export function getMessageAttachmentsBatched(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): Promise<readonly MessageAttachmentSummary[]> {
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
        void flushAttachments(client, organizationSlug, conversationId, batch);
      });
    }
    const callers = waiting.get(messageId) ?? [];
    callers.push({ resolve, reject });
    waiting.set(messageId, callers);
  });
}

async function flushAttachments(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  batch: ReadonlyMap<string, readonly PendingAttachments[]>,
): Promise<void> {
  const ids = [...batch.keys()];
  for (let start = 0; start < ids.length; start += ATTACHMENT_BATCH_LIMIT) {
    const chunk = ids.slice(start, start + ATTACHMENT_BATCH_LIMIT);
    try {
      const listed = await listAttachmentsForMessages(
        client,
        organizationSlug,
        conversationId,
        chunk,
      );
      const byId = new Map(listed.map((entry) => [entry.messageId, entry.attachments]));
      for (const id of chunk) {
        const attachments = byId.get(id) ?? [];
        for (const caller of batch.get(id) ?? []) caller.resolve(attachments);
      }
    } catch (error) {
      for (const id of chunk) for (const caller of batch.get(id) ?? []) caller.reject(error);
    }
  }
}
