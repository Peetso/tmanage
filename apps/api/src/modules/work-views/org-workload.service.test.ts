import { describe, expect, it } from 'vitest';
import { defaultWorkingCalendar } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { OrgWorkloadService } from './org-workload.service.js';
import type { OrgWorkloadRepository } from './org-workload.repository.js';

/**
 * 53-08 part 2a (R21-a) — the org-wide grid over fakes with the real `authorize()`: the AUTH-03
 * oracle (hidden work only as rounded hours, never its id or title), the 404 for a project outside
 * the tenant, the page of 50 with its cursor, and the owner-less rows.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const MINE = '11111111-1111-4111-8111-111111111111';
const SECRET = '22222222-2222-4222-8222-2222222222ff';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const SECRET_TITLE = 'Acquisition of Project Falcon';
const context = { organizationId: ORG, userId: 'user-reader' } as unknown as TenantContext;

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-reader',
    organizationId: ORG,
    kind: 'internal',
    role: 'manager',
    membershipId: 'membership-reader',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [MINE],
    hasOrgWideScope: false,
    ...over,
  };
}

const at = (iso: string) => new Date(`${iso}T10:00:00Z`);
const item = (id: string, projectId: string, owner: string | null, title: string) => ({
  id,
  organizationId: ORG,
  projectId,
  ownerUserId: owner,
  audience: 'internal',
  state: 'in_progress',
  startAt: null,
  dueAt: at('2026-11-03'),
  deletedAt: null,
  title,
});

function build(memberCount = 2): OrgWorkloadService {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const members = Array.from({ length: memberCount }, (_, i) => ({
    membershipId: `m-${String(i).padStart(3, '0')}`,
    userId: `user-${i}`,
    displayName: `Person ${i}`,
  }));
  const repository = {
    listInternalMembers: async (
      _r: unknown,
      _c: unknown,
      options: { afterMembershipId: string | null; limit: number },
    ) =>
      members
        .filter(
          (m) => options.afterMembershipId === null || m.membershipId > options.afterMembershipId,
        )
        .slice(0, options.limit),
    listOpenItemsForOwners: async () => [
      item('w1', MINE, 'user-0', 'Visible task'),
      item('w2', SECRET, 'user-0', SECRET_TITLE),
    ],
    listOpenUnassignedItems: async () => [
      item('u1', MINE, null, 'Unowned visible'),
      item('u2', SECRET, null, SECRET_TITLE),
    ],
    capacitiesFor: async () => [],
    allocationsFor: async () => [],
    timeOffFor: async () => [],
  } as unknown as OrgWorkloadRepository;
  const personLoad = {
    orgCalendar: async () => defaultWorkingCalendar('UTC'),
    estimatesFor: async () =>
      new Map([
        ['w1', 240],
        ['w2', 725],
        ['u1', 120],
        ['u2', 600],
      ]),
  };
  const projects = {
    findById: async (_r: unknown, _c: unknown, id: string) => (id === MINE ? { id } : null),
  };
  return new OrgWorkloadService(database, repository, personLoad as never, projects as never);
}

const week = { from: '2026-11-02', to: '2026-11-08' };

describe('OrgWorkloadService.grid', () => {
  it('AUTH-03: hidden work is only rounded otherProjectsHours, never its id or title', async () => {
    const view = await build().grid(context, principal(), week);
    const first = view.people[0]!.weeks[0]!;
    expect(first.otherProjectsHours).toBe(12);
    expect(first.projects).toEqual([{ projectId: MINE, hours: 4 }]);
    const json = JSON.stringify(view);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(SECRET_TITLE);
    expect(json).not.toContain('Visible task');
  });

  it('owner-less readable work lands in Unassigned; unreadable owner-less work in no row', async () => {
    const view = await build().grid(context, principal(), week);
    expect(view.unassigned.weeks).toEqual([{ weekStart: '2026-11-02', hours: 2 }]);
  });

  it('pages 51 members as 50 rows + nextCursor; the second page starts after it', async () => {
    const service = build(51);
    const one = await service.grid(context, principal(), week);
    expect(one.people).toHaveLength(50);
    expect(one.nextCursor).toBe('m-049');
    const two = await service.grid(context, principal(), { ...week, cursor: one.nextCursor });
    expect(two.people.map((p) => p.membershipId)).toEqual(['m-050']);
    expect(two.nextCursor).toBeNull();
  });

  it('refuses: other-tenant project 404, bad scope 400, 27 weeks 400, client 403', async () => {
    const service = build();
    await expect(
      service.grid(context, principal(), { ...week, scope: `project:${OTHER_TENANT}` }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    await expect(service.grid(context, principal(), { ...week, scope: 'team:x' })).rejects.toEqual(
      expect.objectContaining({ status: 400 }),
    );
    await expect(
      service.grid(context, principal(), { from: '2026-11-02', to: '2027-05-03' }),
    ).rejects.toEqual(expect.objectContaining({ status: 400 }));
    await expect(
      service.grid(context, principal({ kind: 'client', role: 'client_viewer' }), week),
    ).rejects.toEqual(expect.objectContaining({ status: 403 }));
  });
});
