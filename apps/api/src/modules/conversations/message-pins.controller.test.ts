import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationRow, MessageRow } from '../../common/database/schema.js';
import { ConversationsRepository } from './conversations.repository.js';
import { MessagePinsRepository } from './message-pins.repository.js';
import { MessagePinsService, MAX_PINS } from './message-pins.service.js';
import { MessagePinsController } from './message-pins.controller.js';

/**
 * x247 — the database-free proof of the pin write's authorization boundary.
 *
 * The load-bearing assertion the acceptance names: a `PUT …/pin` from a principal without
 * `conversation.moderate` is a 403 and **no pin is inserted**. The service resolves the
 * conversation and the message tenant-scoped first (so the refusal is about capability, not
 * existence), then authorizes — and the fake repository below records every insert, so the test
 * can prove the write never happened. The cap and the resolve-before-authorize 404 ride along on
 * the same fakes.
 */

const ORG = '0198f247-0000-7000-8000-000000000001';
const USER = '0198f247-0000-7000-8000-0000000000a1';
const PROJECT = '0198f247-0000-7000-8000-000000000b01';
const CHANNEL = '0198f247-0000-7000-8000-000000000c01';
const MESSAGE = '0198f247-0000-7000-8000-000000000d01';

const CONTEXT = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function principal(role: Principal['role'], hasOrgWideScope: boolean): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: '0198f247-0000-7000-8000-000000000e01',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope,
  };
}

/** A member holds conversation.read/write but NOT conversation.moderate. */
const MEMBER = principal('member', false);
/** A manager holds conversation.moderate, over its own projects. */
const MANAGER = principal('manager', false);

function conversationRow(): ConversationRow {
  return {
    id: CHANNEL,
    organizationId: ORG,
    projectId: PROJECT,
    archivedAt: null,
  } as unknown as ConversationRow;
}

function messageRow(conversationId: string): MessageRow {
  return { id: MESSAGE, organizationId: ORG, conversationId } as unknown as MessageRow;
}

/** Resolves the conversation and the message; a null message id models "not in this tenant". */
class FakeConversations extends ConversationsRepository {
  constructor(private readonly messageConversationId: string | null) {
    super();
  }

  override async findById(): Promise<ConversationRow | null> {
    return conversationRow();
  }

  override async findMessageById(): Promise<MessageRow | null> {
    return this.messageConversationId === null ? null : messageRow(this.messageConversationId);
  }
}

/** Records every insert so a test can assert the write never happened, and models the count/cap. */
class RecordingPins extends MessagePinsRepository {
  readonly inserted: string[] = [];
  constructor(private pinnedCount = 0) {
    super();
  }

  override async findPin(): Promise<null> {
    return null;
  }

  override async count(): Promise<number> {
    return this.pinnedCount;
  }

  override async pin(
    _tx: unknown,
    _context: TenantContext,
    input: { conversationId: string; messageId: string; pinnedByUserId: string },
  ): Promise<never> {
    this.inserted.push(input.messageId);
    // The tests that reach here assert on `inserted`, not on the returned row.
    return { id: 'p1', ...input } as unknown as never;
  }
}

function build(options: { messageConversationId?: string | null; pinnedCount?: number } = {}) {
  const conversations = new FakeConversations(
    options.messageConversationId === undefined ? CHANNEL : options.messageConversationId,
  );
  const pins = new RecordingPins(options.pinnedCount ?? 0);
  const database = {
    read: <T>(_c: TenantContext, work: (db: unknown) => Promise<T>) => work({}),
    transaction: <T>(_c: TenantContext, work: (tx: unknown) => Promise<T>) => work({}),
  } as unknown as TenantDatabase;
  const service = new MessagePinsService(database, pins, conversations);
  return { controller: new MessagePinsController(service), pins };
}

async function statusOf(work: () => Promise<unknown>): Promise<number> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('MessagePinsController — the pin write is behind conversation.moderate', () => {
  let harness: ReturnType<typeof build>;

  beforeEach(() => {
    harness = build();
  });

  it('refuses a pin from a principal without conversation.moderate with 403 and no insert', async () => {
    const status = await statusOf(() => harness.controller.pin(CONTEXT, MEMBER, CHANNEL, MESSAGE));
    expect(status).toBe(403);
    // The whole of the acceptance: the write never ran.
    expect(harness.pins.inserted).toEqual([]);
  });

  it('lets a moderator pin the message', async () => {
    await harness.controller.pin(CONTEXT, MANAGER, CHANNEL, MESSAGE);
    expect(harness.pins.inserted).toEqual([MESSAGE]);
  });

  it('is 404 when the message is not in this tenant, before any capability check', async () => {
    const notFound = build({ messageConversationId: null });
    const status = await statusOf(() => notFound.controller.pin(CONTEXT, MEMBER, CHANNEL, MESSAGE));
    expect(status).toBe(404);
    expect(notFound.pins.inserted).toEqual([]);
  });

  it('is 404 when the message belongs to another conversation', async () => {
    const other = build({ messageConversationId: '0198f247-0000-7000-8000-000000000c99' });
    const status = await statusOf(() => other.controller.pin(CONTEXT, MANAGER, CHANNEL, MESSAGE));
    expect(status).toBe(404);
    expect(other.pins.inserted).toEqual([]);
  });

  it('refuses a pin past the cap with 409 and no insert', async () => {
    const full = build({ pinnedCount: MAX_PINS });
    const status = await statusOf(() => full.controller.pin(CONTEXT, MANAGER, CHANNEL, MESSAGE));
    expect(status).toBe(409);
    expect(full.pins.inserted).toEqual([]);
  });
});
