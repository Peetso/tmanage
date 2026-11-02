import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PortalRetainersController } from './portal-retainers.controller.js';
import { RetainersService } from '../finance/retainers.service.js';
import type { RetainersRepository } from '../finance/retainers.repository.js';
import type { TenantContext } from '../../common/database/tenant-context.js';

/** AUTH-52-07 — the client retainer projection: the dedicated shape only; another client's is 404. */

const ORG = 'organization-0000-0000-0000-000000000001';
const client = (clientOrganizationId: string): Principal => ({
  userId: 'client-user-1',
  organizationId: ORG,
  kind: 'client',
  role: 'client_viewer',
  membershipId: 'membership-client-1',
  membershipStatus: 'active',
  clientOrganizationId,
  projectIds: ['p1'],
  hasOrgWideScope: false,
});
const context = { organizationId: ORG } as unknown as TenantContext;

function controller(): PortalRetainersController {
  const repository = {
    find: async () => ({
      id: 'r1',
      clientOrganizationId: 'acme',
      name: 'Social media',
      state: 'active',
      clientVisible: true,
      endsOn: null,
      amountPerPeriodMinor: 800_000,
    }),
    projectsOf: async () => new Map([['r1', ['p1']]]),
    periods: async () => [
      {
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        state: 'open',
        allowanceMinutes: 2400,
        rolloverInMinutes: 0,
        usedMinutesCache: 0,
      },
    ],
    usedMinutes: async () => 1620,
    entries: async () => [
      {
        spentOn: '2026-10-20',
        minutes: 90,
        loggedBy: 'u9',
        projectId: 'p1',
        title: 'Post',
        audience: 'client_visible',
        itemDeleted: false,
      },
      {
        spentOn: '2026-10-19',
        minutes: 30,
        loggedBy: 'u9',
        projectId: 'p1',
        title: 'Pricing memo',
        audience: 'internal',
        itemDeleted: false,
      },
    ],
  } as unknown as RetainersRepository;
  const database = { read: async (_c: unknown, work: (r: unknown) => unknown) => work({}) };
  return new PortalRetainersController(
    new RetainersService({
      database: database as never,
      repository,
      finance: {} as never,
      audit: {} as never,
    }),
  );
}

describe('AUTH-52-07 portal retainer projection', () => {
  it('returns only the projection keys: no person, money or internal title', async () => {
    const body = await controller().get(context, client('acme'), 'r1');
    expect(body).toEqual({
      name: 'Social media',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      allowanceHours: 40,
      usedHours: 27,
      remainingHours: 13,
      renewsOn: '2026-11-01',
      entries: [
        { date: '2026-10-20', taskTitle: 'Post', hours: 1.5 },
        { date: '2026-10-19', taskTitle: 'Internal work', hours: 0.5 },
      ],
    });
    const keys = JSON.stringify(body)
      .match(/"(\w+)":/g)!
      .filter((k) => k !== '"name":');
    expect(keys.join(',')).not.toMatch(/amount|rate|cost|minor|member|name/i);
  });

  it("is a 404 for another client organization's retainer", async () => {
    await expect(controller().get(context, client('globex'), 'r1')).rejects.toMatchObject({
      status: 404,
    });
  });
});
