import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { ConversationMembershipRow, ConversationRow } from '../../common/database/schema.js';
import type { ConversationsRepository } from './conversations.repository.js';
import type { DirectConversationsRepository } from './direct-conversations.repository.js';
import type { GroupSettingsRepository } from './group-settings.repository.js';
import { GroupSettingsService } from './group-settings.service.js';
import { PortalChatRepository } from '../portal/portal-chat.repository.js';

const ORG = uuidv7();
const ME = uuidv7();
const context = { organizationId: ORG, userId: ME } as unknown as TenantContext;
const database = {
  read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;
const group = {
  id: 'g1',
  organizationId: ORG,
  kind: 'group',
  archivedAt: null,
  name: 'G',
  onlyAdminsCanSend: 0,
} as unknown as ConversationRow;
const member = (userId: string, role: 'admin' | 'member', at: number) =>
  ({ userId, role, createdAt: new Date(at) }) as unknown as ConversationMembershipRow;
const principal = (kind: 'internal' | 'client', role: string): Principal =>
  ({
    userId: ME,
    organizationId: ORG,
    kind,
    role,
    membershipStatus: 'active',
    projectIds: [],
    hasOrgWideScope: false,
    clientOrganizationId: kind === 'client' ? 'c1' : null,
  }) as unknown as Principal;

function service(members: ConversationMembershipRow[], clients: string[] = []) {
  const roles: string[] = [];
  const conversations = {
    findById: async () => group,
    findMembership: async (_r: unknown, _c: unknown, _id: string, userId: string) =>
      members.find((m) => m.userId === userId) ?? null,
    removeMember: async (_r: unknown, _c: unknown, _id: string, userId: string) => (
      members.splice(
        members.findIndex((m) => m.userId === userId),
        1,
      ),
      true
    ),
    appendMessage: async () => ({ id: uuidv7(), sequenceNo: 1 }),
  } as unknown as ConversationsRepository;
  const groups = {
    listMembersOldestFirst: async () => [...members],
    clientUserIds: async () => new Set(clients),
    setRole: async (_r: unknown, _c: unknown, _id: string, userId: string, role: string) => (
      roles.push(`${userId}:${role}`),
      true
    ),
    findGroupByInviteToken: async () => group,
  } as unknown as GroupSettingsRepository;
  const people = {
    displayNames: async () => new Map(),
  } as unknown as DirectConversationsRepository;
  return { roles, svc: new GroupSettingsService(database, groups, conversations, people) };
}

describe('GroupSettingsService', () => {
  it('refuses a settings change from a member who is not an admin (403)', async () => {
    const { svc } = service([member(ME, 'member', 1)]);
    await expect(
      svc.update(context, principal('internal', 'member'), 'g1', { name: 'X' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('promotes the oldest internal member when the last admin leaves', async () => {
    const { svc, roles } = service(
      [member(ME, 'admin', 1), member('client-1', 'member', 2), member('u-old', 'member', 3)],
      ['client-1'],
    );
    await svc.leave(context, principal('internal', 'member'), 'g1');
    expect(roles).toEqual(['u-old:admin']);
  });

  it('never lets a client join by invite link', async () => {
    const { svc } = service([]);
    await expect(
      svc.joinByInvite(context, principal('client', 'client_member'), 'x'.repeat(43)),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('PortalChatRepository', () => {
  it('lists only group conversations the caller is a member of, tenant-anchored', async () => {
    const captured: { sql: string; params: readonly unknown[] }[] = [];
    const respond = ((sql: string, params: readonly unknown[]) => (
      captured.push({ sql, params }),
      Promise.resolve([])
    )) as unknown;
    const runner = { query: respond, execute: respond } as unknown as TenantQueryRunner;
    await new PortalChatRepository().listGroupsForMember(runner, context, ME);
    const statement = captured[0];
    expect(statement?.sql).toMatch(/`conversations`\.`kind` = \?/);
    expect(statement?.params).toEqual(expect.arrayContaining(['group', ME, ORG]));
    expect(analyzeStatement(statement?.sql ?? '', statement?.params ?? [], ORG).violations).toEqual(
      [],
    );
  });
});
