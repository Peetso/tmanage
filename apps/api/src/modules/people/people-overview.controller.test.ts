import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PeopleOverviewController, foldRoster, parseWindow } from './people-overview.controller.js';
import type { PeopleOverviewRepository } from './people-overview.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

// A13 org-wide People reads, database-free over a fake repository with the real `authorize`.
const ORG = 'organization-0000-0000-0000-000000000001';
const context = { organizationId: ORG, userId: 'user-1' } as unknown as TenantContext;
const principal = (orgWide: boolean, kind: Principal['kind'] = 'internal'): Principal => ({
  userId: 'user-1',
  organizationId: ORG,
  kind,
  role: kind === 'client' ? 'client_viewer' : 'member',
  membershipId: 'membership-1',
  membershipStatus: 'active',
  clientOrganizationId: kind === 'client' ? 'client-org-1' : null,
  projectIds: ['project-mine'],
  hasOrgWideScope: orgWide,
});
const row = (projectId: string) => ({ id: `a-${projectId}`, projectId }) as never;
const database = { read: async (_c: unknown, work: (r: unknown) => unknown) => work({}) };
const controller = new PeopleOverviewController(
  database as unknown as TenantDatabase,
  {
    allocations: async () => [row('project-mine'), row('project-other')],
  } as unknown as PeopleOverviewRepository,
);

describe('people overview', () => {
  it('narrows allocations to readable projects unless the caller has org-wide scope', async () => {
    const mine = await controller.allocations(context, principal(false));
    expect(mine.allocations.map((a) => a.projectId)).toEqual(['project-mine']);
    const all = await controller.allocations(context, principal(true));
    expect(all.allocations).toHaveLength(2);
  });

  it('refuses a client principal', async () => {
    await expect(controller.allocations(context, principal(false, 'client'))).rejects.toMatchObject(
      {
        status: 403,
      },
    );
  });

  it('bounds the window and folds the week per member', () => {
    expect(() => parseWindow('2026-01-01', '2027-06-01', new Date())).toThrow();
    expect(() => parseWindow('2026-01-01', undefined, new Date())).toThrow();
    const member = {
      membershipId: 'm',
      userId: 'u',
      displayName: 'A',
      weeklyHours: 40,
      effectiveFrom: null,
    };
    const [entry] = foldRoster(
      [member],
      [
        { membershipId: 'm', percent: 60, status: 'confirmed' },
        { membershipId: 'm', percent: 20, status: 'tentative' },
      ],
      [{ personUserId: 'u' }],
    );
    expect(entry).toMatchObject({ allocatedPercent: 60, tentativePercent: 20, awayThisWeek: true });
  });
});
