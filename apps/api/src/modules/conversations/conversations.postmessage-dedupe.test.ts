import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ConversationsService } from './conversations.service.js';
import { ConversationsRepository, DuplicateMessageError } from './conversations.repository.js';
import type { AppendMessageInput } from './conversations.repository.js';
import type { ConversationRow, MessageRow } from '../../common/database/schema.js';

/**
 * R03 / F4: message idempotency must be bound to the destination conversation.
 *
 * The database suite (`chat-004-message-dedupe-scope.db.test.ts`) proves the whole thing over
 * real HTTP against the real `uq_messages_client_generated`. What *this* file proves, and what
 * the database suite cannot show precisely, is the service's own contribution: `postMessage`
 * hands the **destination** conversation id to the dedupe read, not the author id alone.
 *
 * `uq_messages_client_generated` is `(organization_id, author_user_id, client_generated_id)` —
 * it does not include the conversation. So an author's key is unique across every channel they
 * can write to. If the dedupe read is scoped only by author and key, a replay through a second
 * channel finds the first channel's message and returns its body; that is the leak. The fix is
 * to scope the read to the destination conversation, so a key from another channel misses here
 * and falls through to the append, where the unique key turns it into a 409.
 *
 * The fake repository below models exactly that split: {@link RecordingConversations.appendMessage}
 * enforces the author+key uniqueness across conversations (the engine's constraint), while
 * {@link RecordingConversations.findByClientGeneratedId} answers only for the conversation it is
 * asked about (the scoped read). The load-bearing assertion is which conversation id the service
 * passes into that read.
 */

const ORG = '0198f100-0000-7000-8000-000000000001';
const USER = '0198f100-0000-7000-8000-0000000000a1';
const PROJECT = '0198f100-0000-7000-8000-000000000b01';
const CHANNEL_A = '0198f100-0000-7000-8000-000000000c01';
const CHANNEL_B = '0198f100-0000-7000-8000-000000000c02';
const KEY = '0198f100-0000-7000-8000-000000000d01';

const CONTEXT = {
  organizationId: ORG,
  userId: USER,
  principalKind: 'internal',
  membershipId: '0198f100-0000-7000-8000-000000000e01',
  capabilities: [],
  policyVersion: '1',
  correlationId: '0198f100-0000-7000-8000-000000000f01',
} as unknown as TenantContext;

/** An Owner: org-wide scope, so `mayReach` passes without a conversation-membership row. */
const PRINCIPAL: Principal = {
  userId: USER,
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: '0198f100-0000-7000-8000-000000000e01',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
};

function conversationRow(id: string): ConversationRow {
  const now = new Date('2026-09-13T00:00:00.000Z');
  return {
    id,
    organizationId: ORG,
    projectId: PROJECT,
    name: id === CHANNEL_A ? 'atlas-relaunch' : 'atlas-launch',
    nextSequenceNo: 1,
    createdByUserId: USER,
    version: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

let messageCounter = 0;

function messageRow(input: AppendMessageInput): MessageRow {
  const now = new Date('2026-09-13T00:00:00.000Z');
  messageCounter += 1;
  return {
    id: `0198f100-0000-7000-8000-00000000ff${String(messageCounter).padStart(2, '0')}`,
    organizationId: ORG,
    conversationId: input.conversationId,
    authorUserId: input.authorUserId,
    sequenceNo: 1,
    parentMessageId: input.parentMessageId ?? null,
    depth: 0,
    parentDepth: null,
    body: input.body,
    bodyRich: input.bodyRich ?? null,
    clientGeneratedId: input.clientGeneratedId ?? null,
    editedAt: null,
    deletedAt: null,
    deletedByUserId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A fake that splits the two halves the real schema splits: the append enforces uniqueness on
 * (author, key) across every conversation, while the dedupe read answers only for the
 * conversation it is handed.
 */
class RecordingConversations extends ConversationsRepository {
  readonly stored: MessageRow[] = [];
  /** The conversation id passed to each dedupe read, in call order. */
  readonly dedupeScopes: string[] = [];

  override async findById(
    _runner: unknown,
    _context: TenantContext,
    conversationId: string,
  ): Promise<ConversationRow | null> {
    if (conversationId === CHANNEL_A || conversationId === CHANNEL_B) {
      return conversationRow(conversationId);
    }
    return null;
  }

  override async findByClientGeneratedId(
    _runner: unknown,
    _context: TenantContext,
    conversationId: string,
    authorUserId: string,
    clientGeneratedId: string,
  ): Promise<MessageRow | null> {
    this.dedupeScopes.push(conversationId);
    return (
      this.stored.find(
        (row) =>
          row.conversationId === conversationId &&
          row.authorUserId === authorUserId &&
          row.clientGeneratedId === clientGeneratedId,
      ) ?? null
    );
  }

  override async appendMessage(
    _tx: unknown,
    _context: TenantContext,
    input: AppendMessageInput,
  ): Promise<MessageRow> {
    // `uq_messages_client_generated` is (org, author, client_generated_id) — not scoped by
    // conversation. A key this author has used in *any* channel collides here.
    if (
      input.clientGeneratedId !== null &&
      input.clientGeneratedId !== undefined &&
      this.stored.some(
        (row) =>
          row.authorUserId === input.authorUserId &&
          row.clientGeneratedId === input.clientGeneratedId,
      )
    ) {
      throw new DuplicateMessageError(input.clientGeneratedId);
    }
    const row = messageRow(input);
    this.stored.push(row);
    return row;
  }
}

// Casts are safe because every method that would touch a runner is overridden above.
function build(): { service: ConversationsService; repo: RecordingConversations } {
  const repo = new RecordingConversations();
  const database = {
    read: <T>(_context: TenantContext, work: (db: unknown) => Promise<T>) => work({}),
    transaction: <T>(_context: TenantContext, work: (tx: unknown) => Promise<T>) => work({}),
  } as unknown as TenantDatabase;
  const service = new ConversationsService(database, repo);
  return { service, repo };
}

describe('postMessage dedupe is bound to the destination conversation', () => {
  it('scopes the dedupe read to the channel being posted to, not the author alone', async () => {
    const { service, repo } = build();

    const first = await service.postMessage(CONTEXT, PRINCIPAL, CHANNEL_A, {
      body: 'Sent once',
      clientGeneratedId: KEY,
    });
    expect(first.created).toBe(true);

    const retry = await service.postMessage(CONTEXT, PRINCIPAL, CHANNEL_A, {
      body: 'Sent once',
      clientGeneratedId: KEY,
    });
    expect(retry.created).toBe(false);
    expect(retry.message.id).toBe(first.message.id);

    // The whole of the fix: every dedupe read named the destination channel, never the user.
    expect(repo.dedupeScopes).toEqual([CHANNEL_A, CHANNEL_A]);
    expect(repo.dedupeScopes).not.toContain(USER);
  });

  it('does not serve a key replayed through another channel from the first channel', async () => {
    const { service, repo } = build();

    const original = await service.postMessage(CONTEXT, PRINCIPAL, CHANNEL_A, {
      body: 'Only in A',
      clientGeneratedId: KEY,
    });
    expect(original.created).toBe(true);

    // The same key, a different channel. The read must be scoped to B — where the key does not
    // exist — so it misses and the append collides on the unique key, surfacing as a 409. The
    // caller must never get channel A's body back through channel B.
    const replay = service.postMessage(CONTEXT, PRINCIPAL, CHANNEL_B, {
      body: 'Replayed into B',
      clientGeneratedId: KEY,
    });

    await expect(replay).rejects.toBeInstanceOf(ApiError);
    await expect(replay).rejects.toMatchObject({ status: 409 });

    // The dedupe read for the replay was scoped to the destination, B — not A, and not the user.
    expect(repo.dedupeScopes).toContain(CHANNEL_B);
    expect(repo.dedupeScopes).not.toContain(USER);
    // Only channel A's message was ever stored; nothing from A leaked out through B.
    expect(repo.stored).toHaveLength(1);
    expect(repo.stored[0]?.conversationId).toBe(CHANNEL_A);
  });
});
