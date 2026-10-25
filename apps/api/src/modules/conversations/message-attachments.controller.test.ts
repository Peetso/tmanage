import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { MessageAttachmentsController } from './message-attachments.controller.js';
import { MessageAttachmentsService } from './message-attachments.service.js';
import type { ConversationsRepository } from './conversations.repository.js';
import type { MessageAttachmentsRepository } from './message-attachments.repository.js';
import type { FileAssetsRepository } from '../files/file-assets.repository.js';
import type { ConversationRow, FileAssetRow, MessageRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x275 composer attachments (CH-06). Database-free proofs of the authorization spine: attach/detach
 * are gated on `conversation.write` and list on `conversation.read` (a caller without the ceiling is
 * the guard's 403), attaching a file that belongs to another tenant is a 404 from the file resolve
 * — before any insert — and a non-author is a 403. The DB predicates are the chain's `.db.test.ts`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-00000000-0000-0000-0000-00000000001';
const CONVERSATION = 'conversation-0000-0000-0000-00000000001';
const MESSAGE = 'message-000000000-0000-0000-00000000001';
const FILE = 'file-0000000000-0000-0000-0000-00000000001';

const context = { organizationId: ORG, membershipId: 'm1' } as unknown as TenantContext;

/** An internal member of PROJECT, not org-wide — passes the gate, needs a channel row. */
const AUTHOR: Principal = {
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
  authorUserId: AUTHOR.userId,
  deletedAt: null,
} as unknown as MessageRow;

function serviceWith(
  attachments: Partial<MessageAttachmentsRepository>,
  conversations: Partial<ConversationsRepository>,
  files: Partial<FileAssetsRepository>,
): MessageAttachmentsService {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new MessageAttachmentsService(
    database,
    attachments as MessageAttachmentsRepository,
    conversations as ConversationsRepository,
    files as FileAssetsRepository,
  );
}

const reachableConversation: Partial<ConversationsRepository> = {
  findById: async () => conversation,
  findMessageById: async () => message,
  findMembership: async () => ({}) as never,
};

describe('MessageAttachmentsController capability wiring', () => {
  it('gates attach/detach on conversation.write and list on conversation.read', () => {
    const reflector = new Reflector();
    expect(reflector.get(REQUIRED_CAPABILITY, MessageAttachmentsController.prototype.attach)).toBe(
      'conversation.write',
    );
    expect(reflector.get(REQUIRED_CAPABILITY, MessageAttachmentsController.prototype.detach)).toBe(
      'conversation.write',
    );
    expect(reflector.get(REQUIRED_CAPABILITY, MessageAttachmentsController.prototype.list)).toBe(
      'conversation.read',
    );
  });
});

describe('MessageAttachmentsService file resolution', () => {
  it('answers 404 and never inserts when the file belongs to another tenant', async () => {
    const insert = vi.fn();
    const service = serviceWith(
      { insert },
      reachableConversation,
      // A cross-tenant file id resolves to no row under the tenant-scoped read.
      { findById: async () => null },
    );
    await expect(
      service.attach(context, AUTHOR, CONVERSATION, MESSAGE, FILE),
    ).rejects.toMatchObject({ status: 404 });
    expect(insert).not.toHaveBeenCalled();
  });

  it('answers 404 and never inserts when the file is not yet ready', async () => {
    const insert = vi.fn();
    const service = serviceWith({ insert }, reachableConversation, {
      findById: async () => ({ id: FILE, organizationId: ORG, status: 'scanning' }) as FileAssetRow,
    });
    await expect(
      service.attach(context, AUTHOR, CONVERSATION, MESSAGE, FILE),
    ).rejects.toMatchObject({ status: 404 });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('MessageAttachmentsService author gate', () => {
  it('answers 403 and never inserts when the caller is not the message author', async () => {
    const insert = vi.fn();
    const service = serviceWith(
      { insert },
      {
        findById: async () => conversation,
        findMessageById: async () => ({ ...message, authorUserId: 'someone-else' }) as MessageRow,
        findMembership: async () => ({}) as never,
      },
      {
        findById: async () => ({ id: FILE, organizationId: ORG, status: 'ready' }) as FileAssetRow,
      },
    );
    await expect(
      service.attach(context, AUTHOR, CONVERSATION, MESSAGE, FILE),
    ).rejects.toMatchObject({ status: 403 });
    expect(insert).not.toHaveBeenCalled();
  });
});

/** A ready internal file of PROJECT — what an author may attach. */
const readyFile = {
  id: FILE,
  organizationId: ORG,
  projectId: PROJECT,
  audience: 'internal',
  clientOrganizationId: null,
  status: 'ready',
} as unknown as FileAssetRow;

describe('F40: a taken-down message keeps nothing attached', () => {
  const takenDown = { ...message, deletedAt: new Date('2026-10-25T11:00:00.000Z') } as MessageRow;
  const reachTakenDown: Partial<ConversationsRepository> = {
    ...reachableConversation,
    findMessageById: async () => takenDown,
  };

  it('lists no attachments for it', async () => {
    const listForMessage = vi.fn(async () => [{ fileAssetId: FILE }] as never);
    const service = serviceWith({ listForMessage }, reachTakenDown, {});
    await expect(service.list(context, AUTHOR, CONVERSATION, MESSAGE)).resolves.toEqual([]);
    expect(listForMessage).not.toHaveBeenCalled();
  });

  it('refuses a new attachment with 409 and writes nothing', async () => {
    const insert = vi.fn();
    const service = serviceWith({ insert }, reachTakenDown, { findById: async () => readyFile });
    await expect(
      service.attach(context, AUTHOR, CONVERSATION, MESSAGE, FILE),
    ).rejects.toMatchObject({ status: 409 });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('F54: the author must be able to read the file, in the channel’s project', () => {
  it('answers 404 and never inserts for a file of another project', async () => {
    const insert = vi.fn();
    const service = serviceWith({ insert }, reachableConversation, {
      findById: async () => ({ ...readyFile, projectId: 'project-p2' }) as FileAssetRow,
    });
    await expect(
      service.attach(context, AUTHOR, CONVERSATION, MESSAGE, FILE),
    ).rejects.toMatchObject({ status: 404 });
    expect(insert).not.toHaveBeenCalled();
  });

  it('answers 404 for a member removed from the project who kept a stale channel row', async () => {
    const insert = vi.fn();
    const removed: Principal = { ...AUTHOR, projectIds: [] };
    const service = serviceWith({ insert }, reachableConversation, {
      findById: async () => readyFile,
    });
    await expect(
      service.attach(context, removed, CONVERSATION, MESSAGE, FILE),
    ).rejects.toMatchObject({ status: 404 });
    expect(insert).not.toHaveBeenCalled();
  });

  it('attaches a readable file of the same project', async () => {
    const insert = vi.fn(async () => ({ row: { createdAt: new Date() }, created: true }) as never);
    const service = serviceWith({ insert, listForMessage: async () => [] }, reachableConversation, {
      findById: async () => readyFile,
    });
    const result = await service.attach(context, AUTHOR, CONVERSATION, MESSAGE, FILE);
    expect(result.created).toBe(true);
    expect(insert).toHaveBeenCalledOnce();
  });
});
