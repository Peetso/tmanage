import type { ApiClient } from './client';

/** R7 receipts (F4): "Delivered to / Read by" for one message, and the delivered marker. */

export interface ReceiptEntry {
  readonly userId: string;
  readonly displayName: string;
  readonly at: string;
}

export interface MessageReceipts {
  /** Everyone the message reached; readers are always here too. */
  readonly deliveredTo: readonly ReceiptEntry[];
  readonly readBy: readonly ReceiptEntry[];
}

const conversationPath = (organizationSlug: string, conversationId: string): string =>
  `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(
    conversationId,
  )}`;

export async function getMessageReceipts(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): Promise<MessageReceipts> {
  const { data } = await client.request<MessageReceipts>({
    path: `${conversationPath(organizationSlug, conversationId)}/messages/${encodeURIComponent(
      messageId,
    )}/receipts`,
  });
  return data;
}

/**
 * Record that a message reached this device while the pane was not visible. When the pane is
 * visible the screen marks it read instead (`markConversationRead`). The server never moves a
 * position backwards, so a late call is harmless.
 */
export async function markConversationDelivered(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  lastDeliveredMessageId: string,
): Promise<void> {
  await client.request<unknown>({
    method: 'PUT',
    path: `${conversationPath(organizationSlug, conversationId)}/read-state`,
    body: { lastDeliveredMessageId },
  });
}
