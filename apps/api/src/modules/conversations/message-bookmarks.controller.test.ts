import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { MessageBookmarksController } from './message-bookmarks.controller.js';
import { MessageBookmarksService } from './message-bookmarks.service.js';
import type { ConversationsRepository } from './conversations.repository.js';
import type { MessageBookmarksRepository } from './message-bookmarks.repository.js';
import type { ConversationRow, MessageRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x248 saved messages (CH-07 "Save"). Database-free proofs of the authorization spine: every route
 * is gated on `conversation.read` (a caller without it is the guard's 403), and saving a message in
 * a conversation the caller is not a member of is a 404 from the relation gate — before any insert.
 * The DB predicates themselves are the chain's `.db.test.ts`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-00000000-0000-0000-0000-00000000001';
const CONVERSATION = 'conversation-0000-0000-0000-00000000001';
const MESSAGE = 'message-000000000-0000-0000-00000000001';

const context = { organizationId: ORG, membershipId: 'm1' } as unknown as TenantContext;

/** An internal member of PROJECT, not org-wide — passes `conversation.read`, needs a channel row. */
const MEMBER: Principal = {
  userId: 'user-0000-0000-0000-0000-000000000001',
  organizationId: ORG,
  kind: 'internal',
  role: 'member',
  membershipId: 'm1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT],
  hasOrgWideScope: false,
};

const conversation = {
  id: CONVERSATION,
  organizationId: ORG,
  projectId: PROJECT,
  archivedAt: null,
} as unknown as ConversationRow;
const message = {
  id: MESSAGE,
  organizationId: ORG,
  conversationId: CONVERSATION,
} as unknown as MessageRow;

/** A service over a fake database (runs work with a stub runner) and the given stub repositories. */
function serviceWith(
  bookmarks: Partial<MessageBookmarksRepository>,
  conversations: Partial<ConversationsRepository>,
): MessageBookmarksService {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new MessageBookmarksService(
    database,
    bookmarks as MessageBookmarksRepository,
    conversations as ConversationsRepository,
  );
}

describe('MessageBookmarksController capability wiring', () => {
  it('gates every route on conversation.read', () => {
    const reflector = new Reflector();
    for (const handler of [
      MessageBookmarksController.prototype.save,
      MessageBookmarksController.prototype.unsave,
      MessageBookmarksController.prototype.listMine,
    ]) {
      expect(reflector.get(REQUIRED_CAPABILITY, handler)).toBe('conversation.read');
    }
  });
});

describe('MessageBookmarksService relation gate', () => {
  it('answers 404 and never inserts when the caller is not a member of the conversation', async () => {
    const insert = vi.fn();
    const service = serviceWith({ insert }, {
      findById: async () => conversation,
      findMessageById: async () => message,
      // Not a member, and the principal is not org-wide, so the read gate denies.
      findMembership: async () => null,
    } as Partial<ConversationsRepository>);
    await expect(service.bookmark(context, MEMBER, CONVERSATION, MESSAGE)).rejects.toMatchObject({
      status: 404,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('saves when the caller is a member of the conversation', async () => {
    const insert = vi.fn(async () => ({}) as never);
    const service = serviceWith({ insert }, {
      findById: async () => conversation,
      findMessageById: async () => message,
      findMembership: async () => ({}) as never,
    } as Partial<ConversationsRepository>);
    await expect(service.bookmark(context, MEMBER, CONVERSATION, MESSAGE)).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledOnce();
  });

  it('answers 404 for a message that belongs to a different conversation', async () => {
    const insert = vi.fn();
    const service = serviceWith({ insert }, {
      findById: async () => conversation,
      findMessageById: async () => ({ ...message, conversationId: 'other' }) as MessageRow,
      findMembership: async () => ({}) as never,
    } as Partial<ConversationsRepository>);
    await expect(service.bookmark(context, MEMBER, CONVERSATION, MESSAGE)).rejects.toMatchObject({
      status: 404,
    });
    expect(insert).not.toHaveBeenCalled();
  });
});
