import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxHandler } from '../outbox/dispatcher.js';
import type { RealtimeHub } from './hub.js';

/**
 * The relay-to-socket seam: `message.created.v1` becomes a hub frame.
 *
 * A factory rather than a constant, because the handler closes over the process's hub —
 * the registry stays a plain map and `main.ts` adds this entry only when a socket server
 * actually exists. Delivery to zero subscribers is success (the frame is a convenience;
 * the durable truth already committed), and a frame is ids only: event type, object id,
 * sequence, the parent id as the minimal safe patch. Never a body — §2's "safe
 * projections of durable events".
 *
 * The frame is published from inside the claiming transaction, which means a crash
 * between publish and commit can show a subscriber a frame for an event that will be
 * redelivered. That is at-least-once seen from the socket, and the client contract
 * already absorbs it: frames carry sequences, and a duplicate sequence is ignored the
 * way a gap is refetched.
 */
export function createMessageFanOut(hub: RealtimeHub): OutboxHandler {
  return async (event: ClaimedOutboxEvent): Promise<void> => {
    const payload = event.payload;
    if (payload === null || typeof payload !== 'object') {
      throw new Error(`event ${event.id} has no readable payload`);
    }
    const record = payload as Record<string, unknown>;
    const conversationId = record['conversationId'];
    const messageId = record['messageId'];
    if (typeof conversationId !== 'string' || typeof messageId !== 'string') {
      throw new Error(`event ${event.id} has no readable conversationId/messageId`);
    }
    const sequence = record['sequenceNo'];
    const parent = record['parentMessageId'];

    hub.publish(event.organizationId, conversationId, {
      type: 'event',
      eventType: event.type,
      conversationId,
      objectId: messageId,
      sequence: typeof sequence === 'number' ? sequence : null,
      patch: { parentMessageId: typeof parent === 'string' ? parent : null },
    });
  };
}
