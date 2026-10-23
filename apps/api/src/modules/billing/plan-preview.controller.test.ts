import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PlanPreviewService } from './plan-preview.service.js';
import type { SubscriptionRepository } from './subscription.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SubscriptionRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';

// Billing / module 19 (x198), feature budget — one assertion per key behaviour: an upgrade delta, a
// downgrade credit, the off-catalog 400, the refusal without org.manage, and that the current plan is
// read from the acting tenant's row.

const ORG = 'org-under-test';

function ownerPrincipal(): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG } as TenantContext;

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

/** A repository stub that asserts the tenant of the read and returns a canned row (or none). */
function fakeRepo(row: SubscriptionRow | null): SubscriptionRepository {
  return {
    find: (_r: never, ctx: TenantContext) => {
      expect(ctx.organizationId).toBe(ORG);
      return Promise.resolve(row);
    },
  } as unknown as SubscriptionRepository;
}

function row(planId: string, currentPeriodEnd: Date | null = null): SubscriptionRow {
  return { planId, status: 'active', currentPeriodEnd } as unknown as SubscriptionRow;
}

describe('PlanPreviewService.preview', () => {
  it('estimates a flat upgrade delta, seats never change it (free to studio, 3 seats)', async () => {
    const service = new PlanPreviewService(fakeDatabase(), fakeRepo(row('free')));
    await expect(
      service.preview(context, ownerPrincipal(), { target: 'studio', seats: 3 }),
    ).resolves.toEqual({
      currentPlanId: 'free',
      targetPlanId: 'studio',
      seats: 3,
      currency: 'usd',
      currentMonthlyCents: 0,
      targetMonthlyCents: 4900,
      baseDeltaCents: 4900,
      seatDeltaCents: 0,
      estimatedDeltaCents: 4900,
      currentPeriodEnd: null,
    });
  });

  it('estimates a downgrade as a negative delta and echoes the stored period end', async () => {
    const end = new Date('2026-10-01T00:00:00.000Z');
    const service = new PlanPreviewService(fakeDatabase(), fakeRepo(row('pro', end)));
    const view = await service.preview(context, ownerPrincipal(), { target: 'starter', seats: 2 });
    expect(view.currentPlanId).toBe('studio');
    expect(view.estimatedDeltaCents).toBe(1900 - 4900);
    expect(view.currentPeriodEnd).toBe(end.toISOString());
  });

  it('rejects Enterprise, which is priced per contract, with a 400', async () => {
    const service = new PlanPreviewService(fakeDatabase(), fakeRepo(row('studio')));
    await expect(
      service.preview(context, ownerPrincipal(), { target: 'enterprise', seats: 1 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an off-catalog target with a 400', async () => {
    const service = new PlanPreviewService(fakeDatabase(), fakeRepo(row('free')));
    await expect(
      service.preview(context, ownerPrincipal(), { target: 'enterprise-unlimited', seats: 1 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a seat count outside the bound with a 400', async () => {
    const service = new PlanPreviewService(fakeDatabase(), fakeRepo(row('free')));
    await expect(
      service.preview(context, ownerPrincipal(), { target: 'studio', seats: 0 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a principal without org.manage', async () => {
    const notManager: Principal = { ...ownerPrincipal(), role: 'workspace_admin' };
    const service = new PlanPreviewService(fakeDatabase(), fakeRepo(row('free')));
    await expect(
      service.preview(context, notManager, { target: 'studio', seats: 1 }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
