import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { CapacityHeatmapController } from './capacity-heatmap.controller.js';
import { CapacityHeatmapService } from './capacity-heatmap.service.js';
import type { CapacityHeatmapRepository } from './capacity-heatmap.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PersonAllocationRow, PersonCapacityRow } from '../../common/database/schema.js';

/**
 * Team capacity heatmap (x193) controller/service proofs, database-free over fakes with the *real*
 * `authorize`. The migration and the tenant-scoped SQL are the chain's DB suite, not here; this file
 * proves the read's own logic: the deterministic utilisation fold, the over-allocation flag, the
 * bounded-window 400, that only the acting tenant's rows are folded, and the client 403.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';
const MEMBER_A = 'membership-0000-0000-0000-00000000000a';
const MEMBER_B = 'membership-0000-0000-0000-00000000000b';
const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function principal(role: Principal['role'], kind: Principal['kind'] = 'internal'): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind,
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: kind === 'client' ? 'client-org-0000-0000-000000000001' : null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function capacityRow(
  membershipId: string,
  organizationId: string,
  weeklyHours: number,
): PersonCapacityRow {
  return {
    id: `cap-${membershipId}`,
    organizationId,
    membershipId,
    weeklyHours,
    effectiveFrom: '2026-01-01',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  } as unknown as PersonCapacityRow;
}

function allocationRow(
  membershipId: string,
  organizationId: string,
  percent: number,
): PersonAllocationRow {
  return {
    id: `alloc-${membershipId}-${percent}`,
    organizationId,
    projectId: 'project-0000-0000-0000-000000000001',
    membershipId,
    percent,
    startDate: '2026-01-01',
    endDate: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  } as unknown as PersonAllocationRow;
}

function controllerWith(
  capacity: readonly PersonCapacityRow[],
  allocations: readonly PersonAllocationRow[],
) {
  const database = {
    read: async (_ctx: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  // Tenant-scoped fakes: only rows for the acting org are returned, exactly as the real repository's
  // WHERE organization_id predicate does.
  const repository = {
    listCapacity: async (_r: unknown, ctx: TenantContext) =>
      capacity.filter((c) => c.organizationId === ctx.organizationId),
    listAllocationsInWindow: async (_r: unknown, ctx: TenantContext) =>
      allocations.filter((a) => a.organizationId === ctx.organizationId),
  } as unknown as CapacityHeatmapRepository;
  const service = new CapacityHeatmapService(database, repository);
  return new CapacityHeatmapController(service);
}

describe('CapacityHeatmapController', () => {
  it('folds capacity × allocations into deterministic per-week utilisation and flags over-allocation', async () => {
    const controller = controllerWith(
      [capacityRow(MEMBER_A, ORG, 40)],
      [allocationRow(MEMBER_A, ORG, 60), allocationRow(MEMBER_A, ORG, 60)],
    );

    const view = await controller.read(context, principal('owner'), '2026-01-05', '2');
    expect(view.from).toBe('2026-01-05');
    expect(view.weeks).toBe(2);
    expect(view.weekStarts).toEqual(['2026-01-05', '2026-01-12']);
    expect(view.members).toHaveLength(1);

    const cell = view.members[0]!.cells[0]!;
    expect(cell.allocatedPercent).toBe(120);
    expect(cell.capacityHours).toBe(40);
    expect(cell.allocatedHours).toBe(48); // 40 × 120 / 100
    expect(cell.utilisation).toBe(1.2);
    expect(cell.overAllocated).toBe(true);
    expect(view.members[0]!).not.toHaveProperty('organizationId');
  });

  it('reports null utilisation for a member with allocations but no capacity', async () => {
    const controller = controllerWith([], [allocationRow(MEMBER_B, ORG, 50)]);
    const view = await controller.read(context, principal('owner'), '2026-01-05', '1');
    const cell = view.members[0]!.cells[0]!;
    expect(cell.allocatedPercent).toBe(50);
    expect(cell.capacityHours).toBe(0);
    expect(cell.utilisation).toBeNull();
    expect(cell.overAllocated).toBe(false);
  });

  it('rejects an out-of-range weeks window with 400', async () => {
    const controller = controllerWith([capacityRow(MEMBER_A, ORG, 40)], []);
    await expect(
      controller.read(context, principal('owner'), '2026-01-05', '999'),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a malformed from date with 400', async () => {
    const controller = controllerWith([capacityRow(MEMBER_A, ORG, 40)], []);
    await expect(
      controller.read(context, principal('owner'), 'not-a-date', '2'),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('folds only the acting tenant rows, never another org', async () => {
    const controller = controllerWith(
      [capacityRow(MEMBER_A, ORG, 40), capacityRow(MEMBER_B, OTHER_ORG, 40)],
      [allocationRow(MEMBER_A, ORG, 30), allocationRow(MEMBER_B, OTHER_ORG, 90)],
    );
    const view = await controller.read(context, principal('owner'), '2026-01-05', '1');
    expect(view.members.map((m) => m.membershipId)).toEqual([MEMBER_A]);
  });

  it('refuses the read for a client principal (no work.read) with 403', async () => {
    const controller = controllerWith([capacityRow(MEMBER_A, ORG, 40)], []);
    await expect(
      controller.read(context, principal('client_member', 'client'), '2026-01-05', '2'),
    ).rejects.toMatchObject({ status: 403 });
  });
});
