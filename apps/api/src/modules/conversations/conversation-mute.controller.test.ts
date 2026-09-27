import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ConversationMuteController } from './conversation-mute.controller.js';
import { ConversationMuteService } from './conversation-mute.service.js';
import type { ConversationMuteRepository } from './conversation-mute.repository.js';
import type { ConversationsRepository } from './conversations.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationMuteRow, ConversationRow } from '../../common/database/schema.js';

/**
 * CH-09 conversation mute (x252) — read/upsert over fakes, always the caller's own, and a
 * conversation in another studio is a 404 with no write. The database and repositories are faked;
 * the properties proved are the ones the slice owns: absence reads `false`, a valid save persists and
 * reads back scoped to `principal.membershipId`, a non-boolean body is a 400 with no upsert, an
 * unreachable conversation (another tenant, or one the caller is not a member of) is a 404 with no
 * upsert, and both routes sit behind `conversation.read`.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const CONVERSATION = '00000000-0000-4000-8000-0000000000d1';
const OTHER_TENANT_CONVERSATION = '00000000-0000-4000-8000-0000000000d9';
const MY_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const MY_USER = '00000000-0000-4000-8000-0000000000c1';

function member(): Principal {
  return {
    userId: MY_USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: MY_MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, membershipId: MY_MEMBERSHIP } as unknown as TenantContext;

function conversationRow(): ConversationRow {
  return {
    id: CONVERSATION,
    organizationId: ORG,
    projectId: PROJECT,
    archivedAt: null,
  } as unknown as ConversationRow;
}

class FakeConversationsRepository {
  isMember = true;
  findById(_r: unknown, _c: unknown, conversationId: string): Promise<ConversationRow | null> {
    // Only this tenant's conversation exists here — a tenant-scoped query returns null otherwise.
    return Promise.resolve(conversationId === CONVERSATION ? conversationRow() : null);
  }
  findMembership(_r: unknown, _c: unknown, _id: string, _u: string): Promise<unknown> {
    return Promise.resolve(this.isMember ? { id: 'm' } : null);
  }
}

class FakeConversationMuteRepository {
  readonly rows = new Map<string, boolean>();
  upsertCalls: { conversationId: string; membershipId: string; muted: boolean }[] = [];

  findMute(
    _r: unknown,
    _c: unknown,
    conversationId: string,
    membershipId: string,
  ): Promise<ConversationMuteRow | null> {
    const muted = this.rows.get(`${conversationId}:${membershipId}`);
    return Promise.resolve(muted === undefined ? null : ({ muted } as ConversationMuteRow));
  }

  upsert(
    _r: unknown,
    _c: unknown,
    conversationId: string,
    membershipId: string,
    muted: boolean,
  ): Promise<void> {
    this.upsertCalls.push({ conversationId, membershipId, muted });
    this.rows.set(`${conversationId}:${membershipId}`, muted);
    return Promise.resolve();
  }
}

function controllerWith(
  mutes: FakeConversationMuteRepository,
  conversations: FakeConversationsRepository = new FakeConversationsRepository(),
): ConversationMuteController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new ConversationMuteService(
    database,
    mutes as unknown as ConversationMuteRepository,
    conversations as unknown as ConversationsRepository,
  );
  return new ConversationMuteController(service);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('ConversationMuteController (CH-09, x252)', () => {
  it('reads false when the member has never muted the conversation', async () => {
    const result = await controllerWith(new FakeConversationMuteRepository()).get(
      context,
      member(),
      CONVERSATION,
    );
    expect(result).toEqual({ muted: false });
  });

  it('persists a mute and reads it back — scoped to the caller’s own membership', async () => {
    const mutes = new FakeConversationMuteRepository();
    const controller = controllerWith(mutes);

    const saved = await controller.put(context, member(), CONVERSATION, { muted: true });
    expect(saved).toEqual({ muted: true });
    expect(mutes.upsertCalls).toHaveLength(1);
    expect(mutes.upsertCalls[0]).toMatchObject({
      conversationId: CONVERSATION,
      membershipId: MY_MEMBERSHIP,
      muted: true,
    });

    expect(await controller.get(context, member(), CONVERSATION)).toEqual({ muted: true });
  });

  it('400s a non-boolean muted and writes nothing', async () => {
    const mutes = new FakeConversationMuteRepository();
    await expectStatus(
      controllerWith(mutes).put(context, member(), CONVERSATION, { muted: 'yes' } as unknown),
      400,
    );
    await expectStatus(controllerWith(mutes).put(context, member(), CONVERSATION, {}), 400);
    expect(mutes.upsertCalls).toHaveLength(0);
  });

  it('404s muting a conversation in another tenant and never upserts (the refusal)', async () => {
    const mutes = new FakeConversationMuteRepository();
    await expectStatus(
      controllerWith(mutes).put(context, member(), OTHER_TENANT_CONVERSATION, { muted: true }),
      404,
    );
    expect(mutes.upsertCalls).toHaveLength(0);
  });

  it('404s when the caller is not a member of the conversation and never upserts', async () => {
    const mutes = new FakeConversationMuteRepository();
    const conversations = new FakeConversationsRepository();
    conversations.isMember = false;
    await expectStatus(
      controllerWith(mutes, conversations).put(context, member(), CONVERSATION, { muted: true }),
      404,
    );
    expect(mutes.upsertCalls).toHaveLength(0);
  });

  it('guards both routes with conversation.read', () => {
    for (const method of ['get', 'put'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        ConversationMuteController.prototype[method],
      );
      expect(capability).toBe('conversation.read');
    }
  });
});
