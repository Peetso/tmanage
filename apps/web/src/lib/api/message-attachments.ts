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
}

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
