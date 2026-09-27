import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { UsageAlertsController } from './usage-alerts.controller.js';
import { UsageAlertsService } from './usage-alerts.service.js';
import type { UsageAlertsRepository } from './usage-alerts.repository.js';
import type { UsageAlertMetric } from './usage-alerts.types.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingUsageAlertRow } from '../../common/database/schema.js';

/**
 * Billing usage-alerts (x200) proofs, database-free over a fake repository with the *real* `authorize`
 * (the controller delegates to a real {@link UsageAlertsService} built on the fake). The migration and
 * the tenant-scoped SQL round-trip are the chain's DB suite, not here; this file proves the slice's own
 * security logic: create→list, the off-list metric and out-of-range threshold 400s with no write, the
 * cross-tenant 404, the 403 for a role without `org.manage`, and that `status` flags a breached threshold
 * from a seeded usage band.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';

function principal(role: Principal['role']): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function controllerWith(
  seed: readonly BillingUsageAlertRow[] = [],
  bands: ReadonlyMap<UsageAlertMetric, number> = new Map(),
) {
  const store: BillingUsageAlertRow[] = [...seed];
  let seq = store.length;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    list: async (_runner: unknown, ctx: TenantContext) =>
      store
        .filter((row) => row.organizationId === ctx.organizationId)
        .sort((a, b) => a.metric.localeCompare(b.metric)),
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      store.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: { metric: string; thresholdPercent: number; active: boolean; createdBy: string },
    ) => {
      const now = new Date('2026-09-27T10:00:00.000Z');
      const row: BillingUsageAlertRow = {
        id: `billing-usage-alert-${(seq += 1).toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        metric: input.metric,
        thresholdPercent: input.thresholdPercent,
        active: input.active,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      };
      store.push(row);
      return row;
    },
    update: async (
      _runner: unknown,
      ctx: TenantContext,
      id: string,
      patch: { thresholdPercent?: number; active?: boolean },
    ) => {
      const row = store.find((r) => r.organizationId === ctx.organizationId && r.id === id);
      if (!row) throw new Error('vanished');
      if (patch.thresholdPercent !== undefined) row.thresholdPercent = patch.thresholdPercent;
      if (patch.active !== undefined) row.active = patch.active;
      return row;
    },
    readUsageBands: async () => bands,
  } as unknown as UsageAlertsRepository;

  const service = new UsageAlertsService(database, repository);
  return { controller: new UsageAlertsController(service), store };
}

describe('UsageAlertsController', () => {
  it('creates a rule and lists it, without echoing the tenant id', async () => {
    const { controller } = controllerWith();
    const actor = principal('owner');

    const created = await controller.create(context, actor, {
      metric: 'storage',
      thresholdPercent: 90,
    });
    expect(created.metric).toBe('storage');
    expect(created.active).toBe(true);
    expect(created).not.toHaveProperty('organizationId');

    const listed = await controller.list(context, actor);
    expect(listed.alerts.map((a) => a.id)).toContain(created.id);
  });

  it('rejects an unknown metric with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal('owner'), { metric: 'gpu', thresholdPercent: 50 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('rejects an out-of-range threshold with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal('owner'), { metric: 'seats', thresholdPercent: 0 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.create(context, principal('owner'), { metric: 'seats', thresholdPercent: 101 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('refuses a role without org.manage with 403 on create and list', async () => {
    const { controller, store } = controllerWith();
    const actor = principal('org_admin');
    await expect(controller.list(context, actor)).rejects.toMatchObject({ status: 403 });
    await expect(
      controller.create(context, actor, { metric: 'storage', thresholdPercent: 90 }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store).toHaveLength(0);
  });

  it('returns 404 when updating a rule of another tenant', async () => {
    const other: BillingUsageAlertRow = {
      id: 'billing-usage-alert-other',
      organizationId: OTHER_ORG,
      metric: 'storage',
      thresholdPercent: 80,
      active: true,
      createdBy: USER,
      createdAt: new Date('2026-09-27T10:00:00.000Z'),
      updatedAt: new Date('2026-09-27T10:00:00.000Z'),
    };
    const { controller } = controllerWith([other]);
    await expect(
      controller.update(context, principal('owner'), other.id, { active: false }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('status flags a breached active rule from the seeded usage band', async () => {
    const rule: BillingUsageAlertRow = {
      id: 'billing-usage-alert-01',
      organizationId: ORG,
      metric: 'storage',
      thresholdPercent: 90,
      active: true,
      createdBy: USER,
      createdAt: new Date('2026-09-27T10:00:00.000Z'),
      updatedAt: new Date('2026-09-27T10:00:00.000Z'),
    };
    const { controller } = controllerWith([rule], new Map([['storage', 95]]));
    const { statuses } = await controller.status(context, principal('owner'));
    expect(statuses).toEqual([
      { metric: 'storage', thresholdPercent: 90, active: true, currentPercent: 95, breached: true },
    ]);
  });
});
