import type { WorkerTransaction } from '../common/database/worker-database.js';
import {
  insertNotification,
  isActiveInternalMember,
} from '../common/database/notifications-store.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxHandler } from '../outbox/dispatcher.js';

/**
 * WORK-003 × NOTIF-001: "blocker activated → … notification" (`24-EVENT-CATALOG` §4), and
 * US-B04's "relevant users notified once".
 *
 * The one relevant user a blocker names is its ask's owner — the person the work is
 * waiting on. No owner named means nobody is told: the blocker is on "the vendor" or the
 * weather, and broadcasting it to a project would be noise US-B04's "once" forbids. The
 * owner is checked against **current** membership at delivery (§6's rule, the same as the
 * request consumers beside this one), and "once" is the dedupe key: one blocker, one row,
 * however many times the relay redelivers the event.
 */
export const workItemBlockedConsumer: OutboxHandler = async (
  event: ClaimedOutboxEvent,
  tx: WorkerTransaction,
): Promise<void> => {
  const payload = event.payload;
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`event ${event.id} has no readable payload`);
  }
  const record = payload as Record<string, unknown>;
  const workItemId = record['workItemId'];
  const blockerId = record['blockerId'];
  if (typeof workItemId !== 'string' || typeof blockerId !== 'string') {
    throw new Error(`event ${event.id} has no readable workItemId/blockerId`);
  }

  const ownerUserId = record['ownerUserId'];
  if (typeof ownerUserId !== 'string') return; // No owner named: nobody to tell.

  const permitted = await isActiveInternalMember(tx, event.organizationId, ownerUserId);
  if (!permitted) return; // §6: suspended between event and delivery means silence.

  await insertNotification(tx, {
    organizationId: event.organizationId,
    recipientUserId: ownerUserId,
    type: event.type,
    objectType: 'work_item',
    objectId: workItemId,
    // One blocker, one notification, however many deliveries.
    dedupeKey: `work_item.blocked:${blockerId}`,
  });
};
