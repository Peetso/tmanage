import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationRow, MessageRow } from '../../common/database/schema.js';
import { ConversationsRepository } from './conversations.repository.js';
import { MessageReactionsRepository } from './message-reactions.repository.js';
import { MessageReactionsService } from './message-reactions.service.js';
import {
  MAX_BATCH_MESSAGE_IDS,
  MessageReactionsController,
} from './message-reactions.controller.js';

/**
 * x246 refusal: reacting on a message in another tenant's conversation returns 404 — no leak,
 * no insert.
 *
 * The conversation read is org-scoped, so a conversation in another studio is simply not found
 * and the service answers 404 before the message is read or any reaction is written. The second
 * case proves the sibling boundary: a message that exists but belongs to a different channel is
 * a 404 too, so the (conversation, message) pair is resolved together rather than trusting the
 * message id alone. In both the reactions store is never touched — the assertion that there is
 * no write behind the refusal.
 */

const ORG = '0198f246-0000-7000-8000-000000000001';
const OTHER_CONVERSATION = '0198f246-0000-7000-8000-000000000c01';
const A_MESSAGE = '0198f246-0000-7000-8000-000000000m01';
const MEMBERSHIP = '0198f246-0000-7000-8000-000000000e01';

const CONTEXT = {
  organizationId: ORG,
  userId: '0198f246-0000-7000-8000-0000000000a1',
  membershipId: MEMBERSHIP,
} as unknown as TenantContext;

/** An Owner (org-wide scope), so a refusal here is the tenant/resolution boundary, not the gate. */
const PRINCIPAL: Principal = {
  userId: '0198f246-0000-7000-8000-0000000000a1',
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: MEMBERSHIP,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
};

function conversationRow(id: string): ConversationRow {
  const now = new Date('2026-09-19T00:00:00.000Z');
  return {
    id,
    organizationId: ORG,
    projectId: '0198f246-0000-7000-8000-000000000b01',
    name: 'atlas',
    nextSequenceNo: 1,
    createdByUserId: PRINCIPAL.userId,
    version: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  } as unknown as ConversationRow;
}

/** Records every add so the test can prove a refusal wrote nothing. */
class RecordingReactions extends MessageReactionsRepository {
  addCalls = 0;
  override async add(): Promise<void> {
    this.addCalls += 1;
  }
}

function build(conversations: ConversationsRepository): {
  service: MessageReactionsService;
  reactions: RecordingReactions;
} {
  const reactions = new RecordingReactions();
  const database = {
    read: <T>(_context: TenantContext, work: (db: unknown) => Promise<T>) => work({}),
    transaction: <T>(_context: TenantContext, work: (tx: unknown) => Promise<T>) => work({}),
  } as unknown as TenantDatabase;
  const service = new MessageReactionsService(database, conversations, reactions);
  return { service, reactions };
}

describe('message reactions refuse a cross-tenant target without leaking or writing', () => {
  it('answers 404 for a conversation not in the acting tenant, and writes nothing', async () => {
    // The org-scoped read finds no such conversation — exactly what a cross-tenant id looks like.
    class OtherTenant extends ConversationsRepository {
      override async findById(): Promise<ConversationRow | null> {
        return null;
      }
    }
    const { service, reactions } = build(new OtherTenant());

    const attempt = service.add(CONTEXT, PRINCIPAL, OTHER_CONVERSATION, A_MESSAGE, '\u{1F44D}');
    await expect(attempt).rejects.toBeInstanceOf(ApiError);
    await expect(attempt).rejects.toMatchObject({ status: 404 });
    expect(reactions.addCalls).toBe(0);
  });

  it('answers 404 when the message belongs to a different conversation, and writes nothing', async () => {
    // The conversation is reachable, but the message is another channel's — the pair does not
    // resolve, so it is a 404 and no reaction is written.
    class Mismatched extends ConversationsRepository {
      override async findById(
        _runner: unknown,
        _context: TenantContext,
        conversationId: string,
      ): Promise<ConversationRow | null> {
        return conversationRow(conversationId);
      }
      override async findMessageById(): Promise<MessageRow | null> {
        return {
          id: A_MESSAGE,
          conversationId: 'some-other-channel',
          deletedAt: null,
        } as MessageRow;
      }
    }
    const { service, reactions } = build(new Mismatched());

    const attempt = service.add(CONTEXT, PRINCIPAL, OTHER_CONVERSATION, A_MESSAGE, '\u{1F44D}');
    await expect(attempt).rejects.toBeInstanceOf(ApiError);
    await expect(attempt).rejects.toMatchObject({ status: 404 });
    expect(reactions.addCalls).toBe(0);
  });
});

describe('C5 — the batched tally reads many messages of one channel in one request', () => {
  class Reachable extends ConversationsRepository {
    override async findById(
      _runner: unknown,
      _context: TenantContext,
      conversationId: string,
    ): Promise<ConversationRow | null> {
      return conversationRow(conversationId);
    }
  }

  class Stored extends MessageReactionsRepository {
    tallied: (readonly string[])[] = [];
    override async messageIdsInConversation(
      _runner: unknown,
      _context: TenantContext,
      _conversationId: string,
      messageIds: readonly string[],
    ): Promise<readonly string[]> {
      return messageIds.filter((id) => id !== 'msg-elsewhere');
    }
    override async tallyMany(_runner: unknown, _context: TenantContext, ids: readonly string[]) {
      this.tallied.push(ids);
      return [
        { messageId: 'msg-1', emoji: '❤️', count: 3 },
        { messageId: 'msg-1', emoji: '\u{2713}', count: 1 },
        { messageId: 'msg-elsewhere', emoji: '❤️', count: 9 },
      ];
    }
    override async mineMany() {
      return [{ messageId: 'msg-1', emoji: '❤️' }];
    }
  }

  function batch(conversations: ConversationsRepository, reactions: MessageReactionsRepository) {
    const database = {
      read: <T>(_context: TenantContext, work: (db: unknown) => Promise<T>) => work({}),
    } as unknown as TenantDatabase;
    return new MessageReactionsService(database, conversations, reactions);
  }

  it('answers every asked message of the channel in order, and drops another channel’s', async () => {
    const reactions = new Stored();
    const service = batch(new Reachable(), reactions);
    const tallies = await service.tallyMany(CONTEXT, PRINCIPAL, OTHER_CONVERSATION, [
      'msg-2',
      'msg-1',
      'msg-elsewhere',
      'msg-1',
    ]);
    expect(reactions.tallied).toEqual([['msg-2', 'msg-1']]);
    expect(tallies).toEqual([
      { messageId: 'msg-2', reactions: [] },
      {
        messageId: 'msg-1',
        reactions: [
          { emoji: '❤️', count: 3, reacted: true },
          { emoji: '\u{2713}', count: 1, reacted: false },
        ],
      },
    ]);
  });

  it('is a 404 for a conversation outside the tenant, reading no reactions', async () => {
    class OtherTenant extends ConversationsRepository {
      override async findById(): Promise<ConversationRow | null> {
        return null;
      }
    }
    const reactions = new Stored();
    const attempt = batch(new OtherTenant(), reactions).tallyMany(
      CONTEXT,
      PRINCIPAL,
      OTHER_CONVERSATION,
      ['msg-1'],
    );
    await expect(attempt).rejects.toMatchObject({ status: 404 });
    expect(reactions.tallied).toEqual([]);
  });

  it('refuses an empty or oversized id list with 400 before the service runs', async () => {
    let called = 0;
    const controller = new MessageReactionsController({
      tallyMany: async () => {
        called += 1;
        return [];
      },
    } as unknown as MessageReactionsService);
    await expect(
      controller.tallyMany(CONTEXT, PRINCIPAL, OTHER_CONVERSATION, ''),
    ).rejects.toMatchObject({ status: 400 });
    const tooMany = Array.from({ length: MAX_BATCH_MESSAGE_IDS + 1 }, (_, i) => `m-${i}`).join(',');
    await expect(
      controller.tallyMany(CONTEXT, PRINCIPAL, OTHER_CONVERSATION, tooMany),
    ).rejects.toMatchObject({ status: 400 });
    expect(called).toBe(0);
    await expect(
      controller.tallyMany(CONTEXT, PRINCIPAL, OTHER_CONVERSATION, 'msg-1, msg-2'),
    ).resolves.toEqual({ tallies: [] });
    expect(called).toBe(1);
  });
});
