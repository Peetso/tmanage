import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { BudgetBurnService } from './budget-burn.service.js';
import type { BudgetBurnRepository } from './budget-burn.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/** 52-05 burn report over fakes with the real `authorize()`: money gate, person gate, phase 422. */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const context = { organizationId: ORG, userId: 'u' } as unknown as TenantContext;

function principal(role: Principal['role']): Principal {
  return {
    userId: 'u',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

function service(): BudgetBurnService {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    buckets: async () => [
      {
        key: '2026-10-26',
        minutes: 120,
        billableMinutes: 90,
        amountMinor: 1500,
        unpricedMinutes: 30,
      },
    ],
    facts: async () => [],
  } as unknown as BudgetBurnRepository;
  const projects = { findById: async () => ({ id: PROJECT }) } as unknown as ProjectsRepository;
  return new BudgetBurnService(database, repository, projects, undefined, () => '2026-11-02');
}

describe('52-05 burn report', () => {
  it('drops money keys without finance.view and keeps them with it', async () => {
    const member = await service().burn(context, principal('member'), PROJECT, {});
    expect(member.buckets[0]).not.toHaveProperty('amountMinor');
    const manager = await service().burn(context, principal('manager'), PROJECT, {});
    expect(manager.buckets[0]?.amountMinor).toBe(1500);
  });

  it('keeps burn by person for managers and answers phase grouping with 422', async () => {
    await expect(
      service().burn(context, principal('member'), PROJECT, { groupBy: 'person' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service().burn(context, principal('manager'), PROJECT, { groupBy: 'phase' }),
    ).rejects.toMatchObject({ status: 422, message: 'phase_grouping_unavailable' });
    await expect(
      service().burn(context, principal('manager'), PROJECT, { from: '2020-01-01' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
