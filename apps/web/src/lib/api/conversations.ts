import type { RichTextDocument } from '@tmanage/domain';
import type { ApiClient } from './client';
import type { WorkItemSummary } from './work-items';

/**
 * The conversation endpoints — CHAT-001 through CHAT-003, behind `TM-06`, `TM-08` and `TM-09`.
 *
 * Three shapes here are the API's own and worth stating before any screen uses them:
 *
 * - **A post can dedupe.** `POST …/messages` with a `clientGeneratedId` answers 201 for a new
 *   message and 200 with the original for a retry under the same id. This module does not
 *   surface the status; the message that comes back is the message that exists, which is all
 *   a screen needs. The composer's job is to keep the same id across retries of the same
 *   attempt — see `ProjectChannelScreen`.
 * - **A conversion can dedupe the same way.** `convertMessageToWork` returns `created: false`
 *   with the existing conversion when the message was already converted — INT-07's "one
 *   linked work item on retry". The screen shows the existing link rather than pretending a
 *   second item appeared.
 * - **A thread is a query, not a different resource.** `parentMessageId` absent reads the
 *   channel (top-level messages only); supplying a message id reads that message's replies.
 *   There is no way to ask for both, by the API's own design.
 */

export interface ConversationSummary {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdByUserId: string;
  /** The concurrency token. Present it to rename or archive. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface MessageSummary {
  readonly id: string;
  readonly conversationId: string;
  readonly authorUserId: string;
  readonly sequenceNo: number;
  readonly parentMessageId: string | null;
  /** `null` once the message has been moderated — the tombstone is the screen's to draw. */
  readonly body: string | null;
  /** The sanitised rich-text document, or `null` for a plain-text or moderated message. */
  readonly bodyRich: RichTextDocument | null;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
  readonly deletedByUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MessageRevisionSummary {
  readonly revisionNo: number;
  readonly body: string | null;
  readonly bodyRich: RichTextDocument | null;
  readonly writtenAt: string;
  readonly replacedAt: string;
}

/**
 * The largest page the API returns — `MAX_PAGE_SIZE` in `ConversationsRepository`, the same
 * 200 as work items. A screen that receives exactly this many knows there may be more;
 * `MAX_WORK_ITEM_PAGE`'s comment explains why saying so matters.
 */
export const MAX_MESSAGE_PAGE = 200;

export async function listConversations(
  client: ApiClient,
  organizationSlug: string,
  query: { readonly projectId?: string; readonly includeArchived?: boolean } = {},
): Promise<readonly ConversationSummary[]> {
  const parameters = new URLSearchParams();
  if (query.projectId) parameters.set('projectId', query.projectId);
  if (query.includeArchived) parameters.set('includeArchived', 'true');

  const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
  const { data } = await client.request<{ conversations: readonly ConversationSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations${suffix}`,
  });
  return data.conversations;
}

export async function getConversation(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const { data } = await client.request<ConversationSummary>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(conversationId)}`,
  });
  return data;
}

export async function createConversation(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly projectId: string; readonly name: string },
): Promise<ConversationSummary> {
  const { data } = await client.request<ConversationSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations`,
    body: input,
  });
  return data;
}

export interface ListMessagesQuery {
  /** A message id reads that message's replies — TM-08's thread pane. Absent reads the channel. */
  readonly parentMessageId?: string;
  readonly afterSequenceNo?: number;
  readonly limit?: number;
}

export async function listMessages(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  query: ListMessagesQuery = {},
): Promise<readonly MessageSummary[]> {
  const parameters = new URLSearchParams();
  if (query.parentMessageId) parameters.set('parentMessageId', query.parentMessageId);
  if (query.afterSequenceNo !== undefined) {
    parameters.set('afterSequenceNo', String(query.afterSequenceNo));
  }
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));

  const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
  const { data } = await client.request<{ messages: readonly MessageSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(conversationId)}/messages${suffix}`,
  });
  return data.messages;
}

export interface PostMessageInput {
  readonly body: string;
  readonly parentMessageId?: string;
  /**
   * The retry-dedupe key. The composer generates one per *attempt* and keeps it across
   * retries of that attempt, so a network failure followed by a resend cannot post twice.
   */
  readonly clientGeneratedId?: string;
}

export async function postMessage(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  input: PostMessageInput,
): Promise<MessageSummary> {
  const { data } = await client.request<MessageSummary>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(conversationId)}/messages`,
    body: input,
  });
  return data;
}

export async function listRevisions(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): Promise<readonly MessageRevisionSummary[]> {
  const { data } = await client.request<{ revisions: readonly MessageRevisionSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/revisions`,
  });
  return data.revisions;
}

/**
 * Take a message down. The API answers with the message rather than 204 — body withheld,
 * removal recorded — so the screen can show that something was removed rather than that
 * nothing was ever there.
 */
export async function moderateMessage(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
): Promise<MessageSummary> {
  const { data } = await client.request<MessageSummary>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
  });
  return data;
}

export interface ConvertMessageInput {
  readonly title?: string;
  readonly type?: string;
  readonly audience?: 'internal' | 'client_visible' | 'client_action_required';
  readonly dueAt?: string;
}

export interface ConvertMessageResult {
  readonly workItem: WorkItemSummary;
  readonly messageId: string;
  readonly convertedAt: string;
  /** `false` when this message had already been converted; `workItem` is the existing one. */
  readonly created: boolean;
}

/**
 * TM-09's submit. The project is not a parameter — the work is filed on the conversation's
 * project by the API's own rule, so the dialog shows the project and does not offer to change
 * it. `ownerUserId` is accepted by the API and not sent from here: there is no people
 * directory to choose an owner from, and a text field for a UUID is not a form.
 */
export async function convertMessageToWork(
  client: ApiClient,
  organizationSlug: string,
  conversationId: string,
  messageId: string,
  input: ConvertMessageInput = {},
): Promise<ConvertMessageResult> {
  const { data } = await client.request<ConvertMessageResult>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/work-items`,
    body: input,
  });
  return data;
}
