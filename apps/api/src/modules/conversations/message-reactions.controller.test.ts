import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationRow, MessageRow } from '../../common/database/schema.js';
import { ConversationsRepository } from './conversations.repository.js';
import { MessageReactionsRepository } from './message-reactions.repository.js';
import { MessageReactionsService } from './message-reactions.service.js';

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
