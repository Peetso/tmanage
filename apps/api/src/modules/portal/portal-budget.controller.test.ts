import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PortalBudgetController } from './portal-budget.controller.js';
import { BudgetBurnService } from '../projects/budget-burn.service.js';
import type { BudgetBurnRepository } from '../projects/budget-burn.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/** AUTH-52-06 — the client budget projection: three fields only, 404 unless the team shares it. */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const client: Principal = {
  userId: 'client-user-1',
  organizationId: ORG,
  kind: 'client',
  role: 'client_viewer',
  membershipId: 'membership-client-1',
  membershipStatus: 'active',
  clientOrganizationId: 'client-org',
  projectIds: [PROJECT],
  hasOrgWideScope: false,
};
const context = { organizationId: ORG, userId: client.userId } as unknown as TenantContext;

function controller(clientVisible: boolean): PortalBudgetController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    facts: async () => [
      {
        projectId: PROJECT,
        budgetType: 'both',
        budgetMinutes: 600,
        budgetAmountMinor: 4_000_000,
        includeExpenses: true,
        clientVisible,
        usedMinutesCache: 450,
        usedAmountCacheMinor: 2_480_000,
      },
    ],
  } as unknown as BudgetBurnRepository;
  return new PortalBudgetController(new BudgetBurnService(database, repository));
}

describe('AUTH-52-06 portal budget projection', () => {
  it('returns only percentUsed, remainingHours and status — no amount, rate, cost or minor key', async () => {
    const body = await controller(true).get(context, client, PROJECT);
    expect(body).toEqual({ percentUsed: 75, remainingHours: 2.5, status: 'on_track' });
    expect(JSON.stringify(body)).not.toMatch(/amount|rate|cost|minor/i);
  });

  it('is a 404 when the team has not switched client visibility on', async () => {
    await expect(controller(false).get(context, client, PROJECT)).rejects.toMatchObject({
      status: 404,
    });
  });
});
