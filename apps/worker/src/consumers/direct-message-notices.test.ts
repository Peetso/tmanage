import { describe, expect, it } from 'vitest';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxEffects } from '../outbox/dispatcher.js';
import { checkDirectConversationSubscription } from '../common/database/direct-message-store.js';
import { RealtimeHub } from '../realtime/hub.js';
import type { RealtimeEventFrame } from '../realtime/hub.js';
import { createDirectMessageFanOut } from '../realtime/fan-out.js';
import { directMessageNoticesConsumer } from './direct-message-notices.js';

/**
 * BK3-left — the worker half of direct messages: the recipient's notice, the socket
 * subscription check and the hub frame. A fake transaction answers each statement by the table it
 * reads; the real SQL against a real server is the database suites' business.
 */

const ORG = 'org-1';
const AUTHOR = 'user-a';
const RECIPIENT = 'user-b';

const event: ClaimedOutboxEvent = {
  id: 'event-1',
  organizationId: ORG,
  type: 'direct_message.created.v1',
  schemaVersion: 1,
  aggregateType: 'direct_conversation',
  aggregateId: 'dm-1',
  payload: {
    directConversationId: 'dm-1',
    messageId: 'msg-8',
    sequenceNo: 8,
    authorUserId: AUTHOR,
    recipientUserId: RECIPIENT,
  },
  correlationId: null,
  occurredAt: new Date('2026-10-23T00:00:00.000Z'),
  attempts: 1,
} as ClaimedOutboxEvent;

interface World {
  /** Active internal memberships by user id → role. */
  readonly internal: Record<string, string>;
  readonly optedOut?: boolean;
}

function fakeTx(world: World): { tx: WorkerTransaction; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const tx = {
    query: async <T>(sql: string, params: readonly unknown[] = []): Promise<T> => {
      if (sql.includes('FROM memberships')) {
        const role = world.internal[params[1] as string];
        return (role === undefined ? [] : [{ id: `m-${params[1] as string}`, role }]) as T;
      }
      if (sql.includes('FROM project_memberships')) return [] as T;
      if (sql.includes('FROM client_memberships')) return [] as T;
      if (sql.includes('FROM notification_kind_prefs')) {
        return (world.optedOut ? [{ enabled: 0 }] : []) as T;
      }
      if (sql.includes('FROM conversations c')) {
        const caller = params[0] as string;
        return (
          [AUTHOR, RECIPIENT].includes(caller)
            ? [
                {
                  kind: 'direct',
                  direct_user_low_id: AUTHOR,
                  direct_user_high_id: RECIPIENT,
                  next_sequence_no: 9,
                },
              ]
            : []
        ) as T;
      }
      if (sql.includes('notifications') && params.length === 7) {
        inserts.push([...params]);
        return { affectedRows: 1 } as T;
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  } as WorkerTransaction;
  return { tx, inserts };
}

const effects = { afterCommit: () => {} } as unknown as OutboxEffects;

describe('direct_message.created.v1 → recipient notice', () => {
  it('tells the other participant once, keyed by the message', async () => {
    const { tx, inserts } = fakeTx({ internal: { [AUTHOR]: 'member', [RECIPIENT]: 'member' } });
    await directMessageNoticesConsumer(event, tx, effects);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.slice(1)).toEqual([
      ORG,
      RECIPIENT,
      'direct_message.created.v1',
      'direct_conversation',
      'dm-1',
      'direct_message:msg-8',
    ]);
  });

  it('tells nobody when the recipient is no longer a member', async () => {
    const { tx, inserts } = fakeTx({ internal: { [AUTHOR]: 'member' } });
    await directMessageNoticesConsumer(event, tx, effects);
    expect(inserts).toEqual([]);
  });

  it('honours the recipient’s "message" opt-out', async () => {
    const { tx, inserts } = fakeTx({
      internal: { [AUTHOR]: 'member', [RECIPIENT]: 'member' },
      optedOut: true,
    });
    await directMessageNoticesConsumer(event, tx, effects);
    expect(inserts).toEqual([]);
  });
});

describe('direct conversation socket subscription', () => {
  it('lets a participant subscribe with the pair cursor and refuses anyone else', async () => {
    const { tx } = fakeTx({ internal: { [AUTHOR]: 'member', [RECIPIENT]: 'member', x: 'member' } });
    const input = { organizationId: ORG, conversationId: 'dm-1' };
    await expect(
      checkDirectConversationSubscription(tx, { ...input, userId: RECIPIENT }),
    ).resolves.toEqual({ allowed: true, cursor: 8 });
    await expect(
      checkDirectConversationSubscription(tx, { ...input, userId: 'x' }),
    ).resolves.toEqual({ allowed: false, cursor: 0 });
  });
});

describe('direct message fan-out', () => {
  it('publishes an ids-only frame on the direct conversation', async () => {
    const hub = new RealtimeHub();
    const frames: RealtimeEventFrame[] = [];
    hub.subscribe(ORG, 'dm-1', (frame) => frames.push(frame));
    await createDirectMessageFanOut(hub)(event, {} as WorkerTransaction, effects);
    expect(frames).toEqual([
      {
        type: 'event',
        eventType: 'direct_message.created.v1',
        conversationId: 'dm-1',
        objectId: 'msg-8',
        sequence: 8,
        patch: { authorUserId: AUTHOR },
      },
    ]);
  });
});
