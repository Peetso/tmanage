import { describe, expect, it } from 'vitest';
import { customRoleKey } from '@tmanage/domain';
import type { Principal, PrincipalRole } from '@tmanage/domain';
import { SearchService } from './search.service.js';
import type { SearchIndexHitRow, SearchIndexRepository } from './search-index.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Wave 10 R3 / F22 residual. A `message` hit is channel text, so it is authorized with the
 * channel's own capability, `conversation.read`, on top of the channel-row narrowing. Before the
 * fix it was authorized with `work.read`, so a custom role {search.use, work.read} that held a
 * channel row read chat text through search without ever being granted chat.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const CHANNEL = 'conversation-0000-0000-0000-000000000001';
const NOW = new Date('2026-10-26T12:00:00.000Z');
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

const HITS: readonly SearchIndexHitRow[] = [
  {
    organizationId: ORG,
    projectId: PROJECT,
    targetKind: 'message',
    targetId: 'message-1',
    title: 'Salary bands for the launch team',
    audience: 'internal',
    updatedAt: NOW,
    conversationId: CHANNEL,
  },
  {
    organizationId: ORG,
    projectId: PROJECT,
    targetKind: 'work_item',
    targetId: 'work-1',
    title: 'Launch checklist',
    audience: 'internal',
    updatedAt: NOW,
  },
];

function service(): SearchService {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    searchRanked: async () => HITS,
    // The caller holds a row in the channel: the row must not be enough on its own.
    listMemberConversationIds: async () => new Set([CHANNEL]),
  } as unknown as SearchIndexRepository;
  const projects = {
    findById: async (_r: unknown, _c: unknown, id: string) => ({ id, organizationId: ORG }),
  } as unknown as ProjectsRepository;
  return new SearchService(database, repository, projects, () => NOW);
}

describe('wave10 R3 F22: message hits need conversation.read', () => {
  it('a custom role {search.use, work.read} with a channel row gets no message hits', async () => {
    const reader = principal(customRoleKey(CUSTOM_ROLE_ID, ['search.use', 'work.read']));
    const results = await service().search(context, reader, { q: 'launch' });
    expect(results.map((r) => [r.kind, r.id])).toEqual([['work_item', 'work-1']]);
    expect(JSON.stringify(results)).not.toContain('Salary bands');
  });

  it('a normal member with the channel row still gets the message hit', async () => {
    const results = await service().search(context, principal('member'), { q: 'launch' });
    expect(results.map((r) => [r.kind, r.id])).toEqual([
      ['message', 'message-1'],
      ['work_item', 'work-1'],
    ]);
  });
});
