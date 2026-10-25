import { describe, expect, it } from 'vitest';
import { customRoleKey } from '@tmanage/domain';
import type { Principal, PrincipalRole } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { DecisionsService } from './decisions.service.js';
import type { DecisionsRepository } from './decisions.repository.js';
import type { DecisionSupersessionsRepository } from './decision-supersessions.repository.js';
import type { DecisionLocksRepository } from './decision-lock.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { MeetingsRepository } from '../calendar/meetings.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DecisionRow } from '../../common/database/schema.js';

/**
 * Wave 10 R3 / F34 residual. Citing or showing a channel message on a decision needs the
 * channel's own read in full: `authorize(conversation.read)` on the channel's project, then
 * org-wide scope or a channel row. Before the fix the channel row alone was enough, so a custom
 * role granted `work.create` + `work.read` (no chat capability) that still held a channel row
 * could quote the channel through a decision.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const CHANNEL = 'conversation-0000-0000-0000-000000000001';
const SOURCE_MESSAGE = 'message-0000-0000-0000-0000-000000000001';
const QUOTE = 'Can we also see the mobile booking flow before launch?';
const CUSTOM_ROLE_ID = '0198f100-0000-7000-8000-00000000c0de';

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function principal(role: PrincipalRole): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

/** A custom role that files and reads work but holds no chat capability. */
const workOnly = principal(customRoleKey(CUSTOM_ROLE_ID, ['work.create', 'work.read']));
const member = principal('member');

function harness(seed: readonly DecisionRow[] = []) {
  const store: DecisionRow[] = [...seed];
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    findMemberName: async () => 'Omar Adel',
    findSourceMessage: async (_r: unknown, _c: unknown, projectId: string, messageId: string) =>
      projectId === PROJECT && messageId === SOURCE_MESSAGE
        ? {
            kind: 'channel' as const,
            messageId,
            conversationId: CHANNEL,
            channelName: 'atlas-relaunch',
            authorName: 'Salma Riad',
            body: QUOTE,
            createdAt: new Date('2026-10-15T10:51:00.000Z'),
          }
        : null,
    findSourceDirectMessage: async () => null,
    isActiveMember: async () => true,
    findById: async (_r: unknown, _c: unknown, id: string) =>
      store.find((row) => row.id === id) ?? null,
    create: async (_r: unknown, ctx: TenantContext, input: Record<string, unknown>) => {
      const row = {
        id: `decision-0000-0000-0000-00000000000${store.length + 1}`,
        organizationId: ctx.organizationId,
        number: store.length + 1,
        rationale: null,
        meetingId: null,
        audience: 'internal',
        createdAt: new Date(),
        ...input,
      } as unknown as DecisionRow;
      store.push(row);
      return row;
    },
  } as unknown as DecisionsRepository;
  const projects = {
    findById: async (_r: unknown, _c: unknown, id: string) => (id === PROJECT ? { id } : null),
  } as unknown as ProjectsRepository;
  const meetings = { findById: async () => null } as unknown as MeetingsRepository;
  const supersessions = {
    findSupersededBy: async () => null,
    listSupersedes: async () => [],
  } as unknown as DecisionSupersessionsRepository;
  const locks = { findByDecisionId: async () => null } as unknown as DecisionLocksRepository;
  // Both principals hold a row in the channel: the row must not be enough on its own.
  const conversations = {
    findMembership: async (_r: unknown, _c: unknown, conversationId: string, userId: string) =>
      conversationId === CHANNEL && userId === USER ? {} : null,
  };
  const service = new DecisionsService(
    database,
    repository,
    projects,
    meetings,
    supersessions,
    locks,
    conversations as never,
  );
  return { service, store };
}

const citing = {
  projectId: PROJECT,
  title: 'Mobile booking first',
  statement: 'We launch the mobile booking flow first.',
  status: 'proposed' as const,
  decidedAt: new Date('2026-10-20T09:00:00.000Z'),
  sourceMessageId: SOURCE_MESSAGE,
};

describe('wave10 R3 F34: a decision source needs conversation.read, not just a channel row', () => {
  it('a work-only custom role with a channel row cannot cite the message: 404, nothing written', async () => {
    const { service, store } = harness();
    const error = await service.create(context, workOnly, citing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).auditCode).toBe('message_not_visible');
    expect(store).toHaveLength(0);
  });

  it('the detail shows that custom role no source card and no quote', async () => {
    const recorded = harness();
    const created = await recorded.service.create(context, member, citing);
    const viewer = harness(recorded.store);
    const detail = await viewer.service.detail(context, workOnly, created.id);
    expect(detail.source).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('mobile booking flow before launch');
  });

  it('a member with the channel row still cites it and sees the quote', async () => {
    const { service } = harness();
    const created = await service.create(context, member, citing);
    expect(created.sourceMessageId).toBe(SOURCE_MESSAGE);
    const detail = await service.detail(context, member, created.id);
    expect(JSON.stringify(detail)).toContain('mobile booking flow before launch');
  });
});
