import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ConversationReadStateRepository } from './read-state.repository.js';
import { ConversationReadStateService } from './read-state.service.js';
import type { ConversationRow, MessageRow } from '../../common/database/schema.js';
import {
  CHANNEL_ROW_DEFAULTS,
  MESSAGE_ROW_DEFAULTS,
} from '../../../test/support/conversation-fixtures.js';

/**
 * x250 refusal: a mark-read whose `lastReadMessageId` names a message in a *different* conversation
 * is a 400, and nothing is written.
 *
 * The message exists in the tenant, so it resolves; the caller can reach the target channel, so the
 * authorize gate passes. The only thing standing between the request and an upsert is the service's
 * own check that a read position may point only at a message in its own channel. This proves that
 * check runs before the write — the fake store records every upsert, and the assertion is that it
 * recorded none.
 */

const ORG = '0198f100-0000-7000-8000-000000000001';
const USER = '0198f100-0000-7000-8000-0000000000a1';
const MEMBERSHIP = '0198f100-0000-7000-8000-000000000e01';
const PROJECT = '0198f100-0000-7000-8000-000000000b01';
const CHANNEL = '0198f100-0000-7000-8000-000000000c01';
const OTHER_CHANNEL = '0198f100-0000-7000-8000-000000000c02';
const MESSAGE_IN_OTHER = '0198f100-0000-7000-8000-000000000f01';

const CONTEXT = { organizationId: ORG, userId: USER } as unknown as TenantContext;

/** An Owner: org-wide scope, so `mayReach` passes without a conversation-membership row. */
const PRINCIPAL: Principal = {
  userId: USER,
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
    projectId: PROJECT,
    ...CHANNEL_ROW_DEFAULTS,
    name: id,
    nextSequenceNo: 1,
    createdByUserId: USER,
    version: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

/** A message that lives in `OTHER_CHANNEL`, not the channel the request targets. */
function messageInOther(): MessageRow {
  const now = new Date('2026-09-19T00:00:00.000Z');
  return {
    id: MESSAGE_IN_OTHER,
    organizationId: ORG,
    conversationId: OTHER_CHANNEL,
    authorUserId: USER,
    sequenceNo: 1,
    parentMessageId: null,
    depth: 0,
    parentDepth: null,
    ...MESSAGE_ROW_DEFAULTS,
    body: 'elsewhere',
    bodyRich: null,
    clientGeneratedId: null,
    editedAt: null,
    deletedAt: null,
    deletedByUserId: null,
    createdAt: now,
    updatedAt: now,
    deletedReason: null,
    purgeAfter: null,
  };
}

class FakeConversations extends ConversationsRepository {
  override async findById(): Promise<ConversationRow | null> {
    return conversationRow(CHANNEL);
  }
  override async findMessageById(): Promise<MessageRow | null> {
    return messageInOther();
  }
}

class RecordingReadState extends ConversationReadStateRepository {
  upserts = 0;
  override async upsert(): Promise<void> {
    this.upserts += 1;
  }
}

function build(): { service: ConversationReadStateService; store: RecordingReadState } {
  const store = new RecordingReadState();
  const database = {
    read: <T>(_c: TenantContext, work: (db: unknown) => Promise<T>) => work({}),
    transaction: <T>(_c: TenantContext, work: (tx: unknown) => Promise<T>) => work({}),
  } as unknown as TenantDatabase;
  const service = new ConversationReadStateService(database, new FakeConversations(), store);
  return { service, store };
}

describe('x250 conversation read-state refuses a foreign message', () => {
  it('answers 400 and never upserts when the message is in another conversation', async () => {
    const { service, store } = build();

    const call = service.markRead(CONTEXT, PRINCIPAL, CHANNEL, MESSAGE_IN_OTHER);

    await expect(call).rejects.toBeInstanceOf(ApiError);
    await expect(call).rejects.toMatchObject({ status: 400 });
    expect(store.upserts).toBe(0);
  });
});
