import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkloadHoursService } from './workload-hours.service.js';
import type { WorkloadHoursRepository } from './workload-hours.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

const ORG = 'organization-0000-0000-0000-000000000001';
const context = { organizationId: ORG } as unknown as TenantContext;
const database = {
  read: (_c: unknown, work: (r: unknown) => unknown) => work({}),
  transaction: (_c: unknown, work: (r: unknown) => unknown) => work({}),
} as unknown as TenantDatabase;

function principal(role: string): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  } as Principal;
}

function repository(overrides: Partial<Record<keyof WorkloadHoursRepository, unknown>> = {}) {
  return {
    listMembers: vi.fn(async () => [
      { membershipId: 'm-1', userId: 'u-1', displayName: 'Sara', role: 'member', status: 'active' },
      { membershipId: 'm-2', userId: 'u-2', displayName: 'Omar', role: 'member', status: 'active' },
    ]),
    listCapacity: vi.fn(async () => [{ membershipId: 'm-1', weeklyHours: 4 }]),
    listOpenOwnedItems: vi.fn(async () => [
      {
        id: 'w-1',
        organizationId: ORG,
        projectId: 'p',
        audience: 'internal',
        state: 'ready',
        ownerUserId: 'u-1',
        dueAt: new Date(),
        deletedAt: null,
      },
      {
        id: 'w-2',
        organizationId: 'other-org',
        projectId: 'p',
        audience: 'internal',
        state: 'ready',
        ownerUserId: 'u-1',
        dueAt: new Date(),
        deletedAt: null,
      },
    ]),
    remainingMinutes: vi.fn(
      async () =>
        new Map([
          ['w-1', 300],
          ['w-2', 6000],
        ]),
    ),
    findMember: vi.fn(async () => ({ id: 'm-1' })),
    setCapacity: vi.fn(async () => ({
      membershipId: 'm-1',
      weeklyHours: 30,
      effectiveFrom: '2026-11-08',
    })),
    ...overrides,
  } as unknown as WorkloadHoursRepository & { setCapacity: ReturnType<typeof vi.fn> };
}

describe('WorkloadHoursService', () => {
  it('sums planned hours per person, skips foreign rows and flags over capacity', async () => {
    const view = await new WorkloadHoursService(database, repository()).view(
      context,
      principal('owner'),
    );
    const sara = view.people.find((p) => p.membershipId === 'm-1');
    expect(sara).toMatchObject({ plannedHours: 5, capacityHours: 4, overCapacity: true });
    expect(view.people.find((p) => p.membershipId === 'm-2')?.capacityHours).toBeNull();
    expect(view.canEditCapacity).toBe(true);
  });

  it('refuses a capacity write from a non-admin with 403 and writes nothing', async () => {
    const repo = repository();
    const service = new WorkloadHoursService(database, repo);
    await expect(
      service.setCapacity(context, principal('manager'), 'm-1', 30),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.setCapacity).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown member before authorizing, and 400 for out-of-range hours', async () => {
    const missing = repository({ findMember: vi.fn(async () => null) });
    await expect(
      new WorkloadHoursService(database, missing).setCapacity(
        context,
        principal('manager'),
        'x',
        30,
      ),
    ).rejects.toMatchObject({ status: 404 });
    const repo = repository();
    await expect(
      new WorkloadHoursService(database, repo).setCapacity(context, principal('owner'), 'm-1', 169),
    ).rejects.toMatchObject({ status: 400 });
    expect(repo.setCapacity).not.toHaveBeenCalled();
  });
});
