import { describe, expect, it } from 'vitest';
import { defaultWorkingCalendar } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PersonLoadController } from './person-load.controller.js';
import { PersonLoadService } from './person-load.service.js';
import type { PersonLoadRepository } from './person-load.repository.js';

/**
 * 53-08 (R20-b) — the person-load read over fakes with the real `authorize()`: the route ceiling,
 * a client principal's 403, the 404 for an unknown member, and the per-reader bucket (an item on a
 * project the reader cannot read appears only as hours, never as a project id).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const MINE = 'project-0000-0000-0000-0000-000000000001';
const SECRET = 'project-0000-0000-0000-0000-0000000000ff';
const MEMBER = 'membership-0000-0000-0000-00000000aa01';
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

function build(): PersonLoadController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const at = (iso: string) => new Date(`${iso}T10:00:00Z`);
  const repository = {
    orgCalendar: async () => defaultWorkingCalendar('UTC'),
    listOpenItemsForOwner: async () => [
      { id: 'w1', projectId: MINE, audience: 'internal', startAt: null, dueAt: at('2026-11-03') },
      { id: 'w2', projectId: SECRET, audience: 'internal', startAt: null, dueAt: at('2026-11-03') },
    ],
    estimatesFor: async () =>
      new Map([
        ['w1', 240],
        ['w2', 180],
      ]),
    capacityFor: async () => ({ weeklyHours: 40, effectiveFrom: '2026-01-01' }),
    allocationsFor: async () => [],
    timeOffFor: async () => [],
  } as unknown as PersonLoadRepository;
  const memberships = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      id === MEMBER ? { id: MEMBER, userId: 'user-member' } : null,
  };
  return new PersonLoadController(
    new PersonLoadService(database, repository, memberships as never),
  );
}

describe('GET …/people/:membershipId/load', () => {
  it('itemises readable work and buckets the rest without a project id', async () => {
    const view = await build().read(context, principal(), MEMBER, '2026-11-02', '2026-11-08');
    const week = view.weeks[0]!;
    expect(week.plannedHours).toBe(4);
    expect(week.otherProjectsHours).toBe(3);
    expect(week.projects).toEqual([{ projectId: MINE, hours: 4 }]);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it('a client principal is a 403; an unknown member a 404; a 27-week window a 400', async () => {
    const controller = build();
    await expect(
      controller.read(
        context,
        principal({ kind: 'client', role: 'client_viewer' }),
        MEMBER,
        '2026-11-02',
        '2026-11-08',
      ),
    ).rejects.toEqual(expect.objectContaining({ status: 403 }));
    await expect(
      controller.read(context, principal(), 'nobody', '2026-11-02', '2026-11-08'),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    await expect(
      controller.read(context, principal(), MEMBER, '2026-11-02', '2027-05-03'),
    ).rejects.toEqual(expect.objectContaining({ status: 400 }));
  });

  it('sits behind work.read', () => {
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, PersonLoadController.prototype.read)).toBe(
      'work.read',
    );
  });
});
