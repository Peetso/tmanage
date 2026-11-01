import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import { insertNotification } from '../common/database/notifications-store.js';
import { isNotificationKindEnabled } from '../common/database/collaboration-store.js';
import { findDirectParty, mayReadDirect } from '../common/database/direct-message-store.js';
import type { WorkerDirectParty } from '../common/database/direct-message-store.js';
import type { OutboxHandler } from '../outbox/dispatcher.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import { findDirectPair } from '../common/database/direct-chat-store.js';

/**
 * BK3-left — `direct_message.created.v1` → an in-app notice for the one other participant.
 *
 * The event names the recipient, but receipt authorizes nothing (§6): the recipient is re-read
 * from current rows and told only if the relation with the author still holds and, for an
 * internal person, their role still reads conversations (`mayReadDirect`, the API's rule). An
 * internal recipient's "message" opt-out (`notification_kind_prefs`) is honoured. The row names
 * the conversation, never the text; a redelivery collides on the message's dedupe key.
 *
 * In-app only: there is no direct-message email template, and the realtime frame plus the
 * unread count already carry the live half.
 */

export interface DirectMessageNoticeFacts {
  readonly directConversationId: string;
  readonly messageId: string;
  readonly authorUserId: string;
  readonly recipientUserId: string;
}

function factsOf(event: ClaimedOutboxEvent): DirectMessageNoticeFacts {
  const payload = event.payload;
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`event ${event.id} has no readable payload`);
  }
  const record = payload as Record<string, unknown>;
  const read = (key: string): string => {
    const value = record[key];
    if (typeof value !== 'string') throw new Error(`event ${event.id} has no readable ${key}`);
    return value;
  };
  return {
    directConversationId: read('directConversationId'),
    messageId: read('messageId'),
    authorUserId: read('authorUserId'),
    recipientUserId: read('recipientUserId'),
  };
}

/** Pure: whether the recipient is told, given both current parties. */
export function shouldNotifyRecipient(
  facts: DirectMessageNoticeFacts,
  recipient: WorkerDirectParty | null,
  author: WorkerDirectParty | null,
): boolean {
  if (facts.recipientUserId === facts.authorUserId) return false;
  return mayReadDirect(recipient, author);
}

export const directMessageNoticesConsumer: OutboxHandler = async (event, tx) => {
  await notifyDirect(event, tx, factsOf(event));
};

/**
 * R7 slice 6: since 0276 a direct message is a `message.created.v1` on a `kind = 'direct'`
 * conversation (`direct_message.created.v1` is no longer written). Same rule and same notice as
 * above; any other conversation (a channel, a group) is left to the mention planner.
 */
export const directConversationMessageNoticesConsumer: OutboxHandler = async (event, tx) => {
  const payload = event.payload as Record<string, unknown> | null;
  if (payload === null || typeof payload !== 'object' || payload['projectId'] != null) return;
  const conversationId = payload['conversationId'];
  const messageId = payload['messageId'];
  const authorUserId = payload['authorUserId'];
  if (
    typeof conversationId !== 'string' ||
    typeof messageId !== 'string' ||
    typeof authorUserId !== 'string'
  ) {
    return;
  }
  const pair = await findDirectPair(tx, event.organizationId, conversationId);
  if (pair === null) return;
  const recipientUserId = pair.lowUserId === authorUserId ? pair.highUserId : pair.lowUserId;
  await notifyDirect(event, tx, {
    directConversationId: conversationId,
    messageId,
    authorUserId,
    recipientUserId,
  });
};

async function notifyDirect(
  event: ClaimedOutboxEvent,
  tx: WorkerTransaction,
  facts: DirectMessageNoticeFacts,
): Promise<void> {
  const recipient = await findDirectParty(tx, event.organizationId, facts.recipientUserId);
  const author = await findDirectParty(tx, event.organizationId, facts.authorUserId);
  if (!shouldNotifyRecipient(facts, recipient, author) || recipient === null) return;
  if (
    recipient.membershipId !== null &&
    !(await isNotificationKindEnabled(tx, event.organizationId, recipient.membershipId, 'message'))
  ) {
    return; // The person turned "message" notices off.
  }
  await insertNotification(tx, {
    organizationId: event.organizationId,
    recipientUserId: facts.recipientUserId,
    type: 'direct_message.created.v1',
    objectType: 'direct_conversation',
    objectId: facts.directConversationId,
    dedupeKey: `direct_message:${facts.messageId}`,
  });
}
