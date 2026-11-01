import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { MessageDraftsController } from './message-drafts.controller.js';
import { MessageDraftsService } from './message-drafts.service.js';
import type { ConversationsRepository } from './conversations.repository.js';
import type { MessageDraftsRepository } from './message-drafts.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationMessageDraftRow, ConversationRow } from '../../common/database/schema.js';
import { CHANNEL_ROW_DEFAULTS } from '../../../test/support/conversation-fixtures.js';

/**
 * x251 chat-message-draft proofs — database-free over fakes with the *real* `authorize`. The
 * migration and the tenant-scoped SQL round-trip are the chain's DB suite, not here; this file
 * proves the controller and service's own security logic: the length cap refuses an over-long
 * draft with 400 and never upserts (the required refusal), and resolve-before-authorize turns an
 * unknown/cross-tenant conversation id into a 404 with no write.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-0000000000a1';

const principal: Principal = {
  userId: USER,
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: 'membership-0000-0000-00000000a1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
};

const context = {
  organizationId: ORG,
  userId: USER,
  membershipId: 'membership-0000-0000-00000000a1',
} as unknown as TenantContext;

function conversation(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: 'conversation-0000-0000-00000001',
    organizationId: ORG,
    projectId: 'project-0000-0000-0000-00000001',
    ...CHANNEL_ROW_DEFAULTS,
    name: 'atlas-relaunch',
    nextSequenceNo: 1,
    createdByUserId: USER,
    version: 1,
    createdAt: new Date('2026-09-27T10:00:00.000Z'),
    updatedAt: new Date('2026-09-27T10:00:00.000Z'),
    archivedAt: null,
    ...overrides,
  };
}

function build(conversations: readonly ConversationRow[]) {
  const store: ConversationMessageDraftRow[] = [];
  let upserts = 0;

  const database = {
    read: async (_ctx: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const conversationsRepository = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      conversations.find((c) => c.organizationId === ctx.organizationId && c.id === id) ?? null,
    findMembership: async () => ({}) as unknown,
  } as unknown as ConversationsRepository;

  const draftsRepository = {
    find: async (_r: unknown, _ctx: TenantContext, cid: string, mid: string) =>
      store.find((d) => d.conversationId === cid && d.membershipId === mid) ?? null,
    upsert: async (
      _r: unknown,
      ctx: TenantContext,
      input: { conversationId: string; membershipId: string; bodyJson: unknown },
    ) => {
      upserts += 1;
      const row = {
        id: `draft-${upserts}`,
        organizationId: ctx.organizationId,
        conversationId: input.conversationId,
        membershipId: input.membershipId,
        bodyJson: input.bodyJson,
        updatedAt: new Date('2026-09-27T11:00:00.000Z'),
      } as ConversationMessageDraftRow;
      store.push(row);
      return row;
    },
    remove: async () => true,
  } as unknown as MessageDraftsRepository;

  const service = new MessageDraftsService(database, draftsRepository, conversationsRepository);
  return { controller: new MessageDraftsController(service), upsertCount: () => upserts };
}

describe('MessageDraftsController.save', () => {
  it('refuses a draft over the length cap with 400 and never upserts', async () => {
    const { controller, upsertCount } = build([conversation()]);
    const overLong = 'x'.repeat(16_001);

    await expect(
      controller.save(context, principal, conversation().id, { body: overLong }),
    ).rejects.toMatchObject({ status: 400 });
    expect(upsertCount()).toBe(0);
  });

  it('turns an unknown conversation into 404 before any write', async () => {
    const { controller, upsertCount } = build([conversation()]);

    await expect(
      controller.save(context, principal, 'conversation-does-not-exist', { body: 'hi' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(upsertCount()).toBe(0);
  });

  it('saves a valid draft and returns its body', async () => {
    const { controller, upsertCount } = build([conversation()]);

    const saved = await controller.save(context, principal, conversation().id, { body: 'draft' });
    expect(saved.body).toBe('draft');
    expect(upsertCount()).toBe(1);
  });
});
