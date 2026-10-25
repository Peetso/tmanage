import { describe, expect, it } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectMembershipRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { ConversationsRepository } from '../conversations/conversations.repository.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { ProjectMembershipsRepository } from './project-memberships.repository.js';
import { ProjectMembershipsService } from './project-memberships.service.js';

/**
 * CQ-12 — putting someone on a project puts them in its open channels (COL-01) and tells them
 * (COL-05, `project.member_added.v1`); adding yourself tells nobody. Fakes only.
 */

const CONTEXT = { organizationId: 'org-1', userId: 'sara' } as unknown as TenantContext;

function build() {
  const joined: string[] = [];
  const events: { type: string; payload: unknown }[] = [];
  const database = {
    transaction: <T>(_c: TenantContext, work: (tx: unknown) => Promise<T>) => work({}),
  } as unknown as TenantDatabase;
  const audit = { record: async () => undefined } as unknown as AuditService;
  const memberships = Object.assign(new ProjectMembershipsRepository(), {
    add: async (_tx: unknown, _c: TenantContext, input: { projectId: string; userId: string }) =>
      ({
        id: 'pm-1',
        projectId: input.projectId,
        userId: input.userId,
        role: 'member',
      }) as ProjectMembershipRow,
  });
  const conversations = Object.assign(new ConversationsRepository(), {
    listOpenIdsByProject: async () => ['channel-a', 'channel-b'],
    addMember: async (_tx: unknown, _c: TenantContext, conversationId: string, userId: string) => {
      joined.push(`${conversationId}:${userId}`);
      return undefined as never;
    },
  });
  const outbox = {
    append: async (_tx: unknown, _c: TenantContext, input: { type: string; payload: unknown }) => {
      events.push(input);
      return 'event-1';
    },
  } as unknown as OutboxEventsRepository;
  const service = new ProjectMembershipsService(
    database,
    audit,
    memberships,
    outbox,
    conversations,
  );
  return { service, joined, events };
}

describe('ProjectMembershipsService.add (CQ-12)', () => {
  it('joins the project channels and tells the person added', async () => {
    const { service, joined, events } = build();
    await service.add(CONTEXT, { projectId: 'proj-1', userId: 'mona', role: 'member' });
    expect(joined).toEqual(['channel-a:mona', 'channel-b:mona']);
    expect(events).toEqual([
      {
        type: 'project.member_added.v1',
        aggregateId: 'proj-1',
        payload: { projectId: 'proj-1', userId: 'mona', addedByUserId: 'sara' },
      },
    ]);
  });

  it('writes no notice when you add yourself', async () => {
    const { service, events } = build();
    await service.add(CONTEXT, { projectId: 'proj-1', userId: 'sara', role: 'member' });
    expect(events).toHaveLength(0);
  });
});

describe('ProjectMembershipsService.remove (F13)', () => {
  it('revokes the person’s channel rows for that project in the same transaction', async () => {
    const left: string[] = [];
    let inTransaction = false;
    const database = {
      transaction: async <T>(_c: TenantContext, work: (tx: unknown) => Promise<T>) => {
        inTransaction = true;
        try {
          return await work({});
        } finally {
          inTransaction = false;
        }
      },
    } as unknown as TenantDatabase;
    const audit = { record: async () => undefined } as unknown as AuditService;
    const memberships = Object.assign(new ProjectMembershipsRepository(), {
      findById: async () =>
        ({
          id: 'pm-1',
          projectId: 'proj-1',
          userId: 'mona',
          role: 'member',
        }) as ProjectMembershipRow,
      remove: async () => true,
    });
    const conversations = Object.assign(new ConversationsRepository(), {
      removeMemberFromProjectChannels: async (
        _tx: unknown,
        _c: TenantContext,
        projectId: string,
        userId: string,
      ) => {
        expect(inTransaction).toBe(true);
        left.push(`${projectId}:${userId}`);
        return 2;
      },
    });
    const service = new ProjectMembershipsService(
      database,
      audit,
      memberships,
      undefined,
      conversations,
    );
    await expect(service.remove(CONTEXT, 'pm-1')).resolves.toBe(true);
    expect(left).toEqual(['proj-1:mona']);
  });
});
