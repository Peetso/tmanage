import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PlanChangeRequestsController } from './plan-change-requests.controller.js';
import { PlanChangeRequestsService } from './plan-change-requests.service.js';
import type { PlanChangeRequestsRepository } from './plan-change-requests.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingPlanChangeRequestRow } from '../../common/database/schema.js';

/**
 * Billing plan-change-request (x284) proofs, database-free over a fake repository with the *real*
 * `authorize` (the controller delegates to a real {@link PlanChangeRequestsService} built on the
 * fake). The migration and the tenant-scoped SQL round-trip are the chain's DB suite, not here; this
 * file proves the slice's own security logic: create→list, the off-catalog target 400 with no write
 * and the 403 for a role without `org.manage` (the brief's required refusals), the past-date 400, the
 * second-pending 409, the cross-tenant 404, and the idempotent cancel.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';
const FUTURE = '2099-01-01';

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

function controllerWith(seed: readonly BillingPlanChangeRequestRow[] = []) {
  const store: BillingPlanChangeRequestRow[] = [...seed];
  let seq = store.length;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    list: async (_runner: unknown, ctx: TenantContext) =>
      store
        .filter((row) => row.organizationId === ctx.organizationId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      store.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
    findPending: async (_runner: unknown, ctx: TenantContext) =>
      store.find((row) => row.organizationId === ctx.organizationId && row.status === 'pending') ??
      null,
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        targetPlanCode: string;
        effectiveOn: string;
        note: string | null;
        createdBy: string;
      },
    ) => {
      const row: BillingPlanChangeRequestRow = {
        id: `billing-plan-change-request-${(seq += 1).toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        targetPlanCode: input.targetPlanCode,
        effectiveOn: input.effectiveOn,
        note: input.note,
        status: 'pending',
        createdBy: input.createdBy,
        createdAt: new Date('2026-09-27T10:00:00.000Z'),
        // Trigger-maintained (trg_billing_plan_change_requests_pending_guard): organization_id while
        // pending, NULL once cancelled.
        pendingGuard: ctx.organizationId,
      };
      store.push(row);
      return row;
    },
    cancel: async (_runner: unknown, ctx: TenantContext, id: string) => {
      const row = store.find((r) => r.organizationId === ctx.organizationId && r.id === id);
      if (!row) throw new Error('vanished');
      if (row.status === 'pending') {
        row.status = 'cancelled';
        // Trigger-maintained (trg_billing_plan_change_requests_pending_guard): pending_guard becomes
        // NULL once the request leaves pending.
        row.pendingGuard = null;
      }
      return row;
    },
  } as unknown as PlanChangeRequestsRepository;

  const service = new PlanChangeRequestsService(database, repository);
  return { controller: new PlanChangeRequestsController(service), store };
}

describe('PlanChangeRequestsController', () => {
  it('creates a request and lists it, without echoing the tenant id', async () => {
    const { controller } = controllerWith();
    const actor = principal('owner');

    const created = await controller.create(context, actor, {
      targetPlanCode: 'pro',
      effectiveOn: FUTURE,
      note: '  moving up  ',
    });
    expect(created.targetPlanCode).toBe('pro');
    expect(created.status).toBe('pending');
    expect(created.note).toBe('moving up');
    expect(created).not.toHaveProperty('organizationId');

    const { requests } = await controller.list(context, actor);
    expect(requests.map((r) => r.id)).toContain(created.id);
  });

  it('rejects an unknown target plan with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal('owner'), {
        targetPlanCode: 'enterprise',
        effectiveOn: FUTURE,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('rejects a past effective date with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal('owner'), {
        targetPlanCode: 'pro',
        effectiveOn: '2000-01-01',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('refuses a role without org.manage with 403 on create and list', async () => {
    const { controller, store } = controllerWith();
    const actor = principal('workspace_admin');
    await expect(controller.list(context, actor)).rejects.toMatchObject({ status: 403 });
    await expect(
      controller.create(context, actor, { targetPlanCode: 'pro', effectiveOn: FUTURE }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store).toHaveLength(0);
  });

  it('rejects a second request while one is pending with 409', async () => {
    const { controller, store } = controllerWith();
    const actor = principal('owner');
    await controller.create(context, actor, { targetPlanCode: 'pro', effectiveOn: FUTURE });
    await expect(
      controller.create(context, actor, { targetPlanCode: 'business', effectiveOn: FUTURE }),
    ).rejects.toMatchObject({ status: 409 });
    expect(store.filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('returns 404 when cancelling a request of another tenant', async () => {
    const other: BillingPlanChangeRequestRow = {
      id: 'billing-plan-change-request-other',
      organizationId: OTHER_ORG,
      targetPlanCode: 'pro',
      effectiveOn: FUTURE,
      note: null,
      status: 'pending',
      createdBy: USER,
      createdAt: new Date('2026-09-27T10:00:00.000Z'),
      // Trigger-maintained (trg_billing_plan_change_requests_pending_guard): organization_id while
      // pending, NULL once cancelled.
      pendingGuard: OTHER_ORG,
    };
    const { controller } = controllerWith([other]);
    await expect(controller.cancel(context, principal('owner'), other.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(other.status).toBe('pending');
  });

  it('cancels a pending request and is idempotent on a second cancel', async () => {
    const { controller } = controllerWith();
    const actor = principal('owner');
    const created = await controller.create(context, actor, {
      targetPlanCode: 'pro',
      effectiveOn: FUTURE,
    });

    const cancelled = await controller.cancel(context, actor, created.id);
    expect(cancelled.status).toBe('cancelled');

    const again = await controller.cancel(context, actor, created.id);
    expect(again.status).toBe('cancelled');
  });
});
