import { describe, expect, it } from 'vitest';
import type { DirectParty, Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DirectConversationRow } from '../../common/database/schema.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { DirectConversationsRepository } from './direct-conversations.repository.js';
import { DirectConversationsService } from './direct-conversations.service.js';
import { DirectConversationsController } from './direct-conversations.controller.js';

/** BK3-left: unread counts, mark-read and the outbox event behind live delivery (0216). */

const ORG = 'org-1';
const ME = 'user-a';
const OTHER = 'user-b';
const context = { organizationId: ORG, userId: ME } as unknown as TenantContext;
const member = { userId: ME, organizationId: ORG, kind: 'internal', role: 'member' } as Principal;
const database = {
  read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;
const internal = (userId: string): DirectParty => ({
  userId,
  kind: 'internal',
  clientOrganizationIds: [],
  projectIds: [],
});

function row(overrides: Partial<DirectConversationRow> = {}): DirectConversationRow {
  return {
    id: 'dm-1',
    organizationId: ORG,
    userLowId: ME,
    userHighId: OTHER,
    // Seven messages handed out; I have read three, the other person all seven.
    nextSequenceNo: 8,
    userLowLastReadSequenceNo: 3,
    userHighLastReadSequenceNo: 7,
    createdByUserId: ME,
    lastMessageAt: new Date('2026-10-22T10:00:00Z'),
    createdAt: new Date('2026-10-22T00:00:00Z'),
    updatedAt: new Date('2026-10-22T10:00:00Z'),
    deletedAt: null,
    deletedByUserId: null,
    deletedReason: null,
    purgeAfter: null,
    ...overrides,
  };
}

function fixture(current: DirectConversationRow) {
  const calls: { markRead: unknown[]; outbox: unknown[] } = { markRead: [], outbox: [] };
  let state = current;
  const repository = {
    findParty: async (_r: unknown, _c: unknown, id: string) => internal(id),
    findById: async () => state,
    listForUser: async () => [state],
    participantDetails: async () =>
      new Map([
        [OTHER, { displayName: 'Bea', jobTitle: null, clientCompanyName: null, online: false }],
      ]),
    markRead: async (_r: unknown, _c: unknown, id: string, side: string, upTo: number) => {
      calls.markRead.push([id, side, upTo]);
      state = { ...state, userLowLastReadSequenceNo: Math.min(upTo, state.nextSequenceNo - 1) };
    },
    appendMessage: async () => ({
      id: 'msg-8',
      directConversationId: 'dm-1',
      authorUserId: ME,
      sequenceNo: 8,
      body: 'hi',
      createdAt: new Date('2026-10-22T11:00:00Z'),
    }),
  } as unknown as DirectConversationsRepository;
  const outbox = {
    append: async (_r: unknown, _c: unknown, input: unknown) => {
      calls.outbox.push(input);
      return 'evt-1';
    },
  } as unknown as OutboxEventsRepository;
  return { svc: new DirectConversationsService(database, repository, outbox), calls };
}

describe('direct messages — unread counts and live delivery', () => {
  it('lists each conversation with the caller’s own marker and unread count', async () => {
    const { svc } = fixture(row());
    const [view] = await svc.list(context, member);
    expect(view).toMatchObject({ lastSequenceNo: 7, lastReadSequenceNo: 3, unreadCount: 4 });
  });

  it('marks read on the caller’s side, to the latest when no number is given', async () => {
    const { svc, calls } = fixture(row());
    const result = await svc.markRead(context, member, 'dm-1');
    expect(calls.markRead).toEqual([['dm-1', 'low', Number.MAX_SAFE_INTEGER]]);
    expect(result).toEqual({
      directConversationId: 'dm-1',
      lastSequenceNo: 7,
      lastReadSequenceNo: 7,
      unreadCount: 0,
    });
  });

  it('writes direct_message.created.v1 naming the other participant with the post', async () => {
    const { svc, calls } = fixture(row());
    const result = await svc.post(context, member, 'dm-1', { body: 'hi' });
    expect(result.created).toBe(true);
    expect(calls.outbox).toEqual([
      {
        type: 'direct_message.created.v1',
        aggregateId: 'dm-1',
        payload: {
          directConversationId: 'dm-1',
          messageId: 'msg-8',
          sequenceNo: 8,
          authorUserId: ME,
          recipientUserId: OTHER,
        },
      },
    ]);
  });

  it('rejects a negative or non-integer lastReadSequenceNo with 400', async () => {
    const { svc } = fixture(row());
    const controller = new DirectConversationsController(svc);
    await expect(
      controller.markRead(context, member, 'dm-1', { lastReadSequenceNo: -1 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.markRead(context, member, 'dm-1', { lastReadSequenceNo: '3' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
