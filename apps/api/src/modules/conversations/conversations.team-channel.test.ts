import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationRow, MessageRow, ProjectRow } from '../../common/database/schema.js';
import { ConversationsService } from './conversations.service.js';
import { ConversationsRepository } from './conversations.repository.js';
import type { AppendMessageInput, CreateConversationInput } from './conversations.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import {
  CHANNEL_ROW_DEFAULTS,
  MESSAGE_ROW_DEFAULTS,
} from '../../../test/support/conversation-fixtures.js';

/**
 * CQ-12 — COL-01 (a new channel is the project team's room, not only its creator's) and COL-05
 * (a posted message names the people it mentions, as ids). Fakes for every repository; the SQL
 * round trip and the 0207 backfill are the database suite's.
 */

const ORG = '0198f100-0000-7000-8000-000000000001';
const SARA = '0198f100-0000-7000-8000-0000000000a1';
const MONA = '0198f100-0000-7000-8000-0000000000a2';
const OMAR = '0198f100-0000-7000-8000-0000000000a3';
const PROJECT = '0198f100-0000-7000-8000-000000000b01';
const CHANNEL = '0198f100-0000-7000-8000-000000000c01';

const CONTEXT = {
  organizationId: ORG,
  userId: SARA,
  membershipId: 'membership-sara',
  correlationId: 'corr-1',
} as unknown as TenantContext;

const PRINCIPAL: Principal = {
  userId: SARA,
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: 'membership-sara',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
};

const NOW = new Date('2026-10-19T00:00:00.000Z');

function channel(): ConversationRow {
  return {
    id: CHANNEL,
    organizationId: ORG,
    projectId: PROJECT,
    ...CHANNEL_ROW_DEFAULTS,
    name: 'design',
    nextSequenceNo: 1,
    createdByUserId: SARA,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  };
}

class FakeConversations extends ConversationsRepository {
  readonly members: string[] = [];
  override async create(
    _runner: unknown,
    _context: TenantContext,
    _input: CreateConversationInput,
  ): Promise<ConversationRow> {
    return channel();
  }
  override async findById(): Promise<ConversationRow | null> {
    return channel();
  }
  override async addMember(
    _runner: unknown,
    _context: TenantContext,
    _conversationId: string,
    userId: string,
  ): Promise<never> {
    this.members.push(userId);
    return undefined as never;
  }
  override async appendMessage(
    _tx: unknown,
    _context: TenantContext,
    input: AppendMessageInput,
  ): Promise<MessageRow> {
    return {
      id: 'message-1',
      organizationId: ORG,
      conversationId: input.conversationId,
      authorUserId: input.authorUserId,
      sequenceNo: 1,
      parentMessageId: null,
      depth: 0,
      parentDepth: null,
      ...MESSAGE_ROW_DEFAULTS,
      body: input.body,
      bodyRich: null,
      clientGeneratedId: null,
      editedAt: null,
      deletedAt: null,
      deletedByUserId: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedReason: null,
      purgeAfter: null,
    };
  }
}

function build() {
  const conversations = new FakeConversations();
  const events: { type: string; payload: unknown }[] = [];
  const database = {
    read: <T>(_c: TenantContext, work: (db: unknown) => Promise<T>) => work({}),
    transaction: <T>(_c: TenantContext, work: (tx: unknown) => Promise<T>) => work({}),
  } as unknown as TenantDatabase;
  const projects = Object.assign(new ProjectsRepository(), {
    findById: async () => ({ id: PROJECT, organizationId: ORG, archivedAt: null }) as ProjectRow,
  });
  const team = Object.assign(new ProjectMembershipsRepository(), {
    listUserIdsByProject: async () => [SARA, MONA, OMAR],
  });
  const outbox = {
    append: async (_tx: unknown, _c: TenantContext, input: { type: string; payload: unknown }) => {
      events.push(input);
      return 'event-1';
    },
  } as unknown as OutboxEventsRepository;
  const service = new ConversationsService(
    database,
    conversations,
    undefined,
    projects,
    team,
    new WorkItemsRepository(),
    outbox,
  );
  return { service, conversations, events };
}

describe('CQ-12 project channels', () => {
  it('R7: refuses a non-admin post when only admins can send', async () => {
    const { service, conversations } = build();
    Object.assign(conversations, {
      findById: async () => ({ ...channel(), onlyAdminsCanSend: 1 }),
      findMembership: async () => ({ role: 'member' }),
    });
    await expect(
      service.postMessage(CONTEXT, PRINCIPAL, CHANNEL, { body: 'hi' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('COL-01: a new channel holds the whole project team, not only its creator', async () => {
    const { service, conversations } = build();
    await service.create(CONTEXT, PRINCIPAL, { projectId: PROJECT, name: 'design' });
    expect(conversations.members).toEqual([SARA, MONA, OMAR]);
  });

  it('COL-05: a message carries the ids it mentions, never the author, and the author id', async () => {
    const { service, events } = build();
    await service.postMessage(CONTEXT, PRINCIPAL, CHANNEL, {
      body: `@${MONA} and @${SARA}, can you look? @${MONA}`,
    });
    expect(events[0]).toMatchObject({
      type: 'message.created.v1',
      payload: { mentionedUserIds: [MONA], authorUserId: SARA },
    });
  });
});
