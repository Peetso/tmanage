import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SubscriptionRow } from '../../common/database/schema.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { assertWithinPlanLimit, entitlementsFor } from './billing-mode.js';
import { PLAN_LIMITS } from './plan-catalog.js';
import type { PlanVersion } from './plan-versions.js';
import type { PlanVersionsStore } from './plan-versions.repository.js';
import { PlanVersionsService } from './plan-versions.service.js';
import type { SubscriptionRepository } from './subscription.repository.js';

// 57-02 money path: one assertion per key behaviour.
afterEach(() => vi.unstubAllEnvs());

const ORG = 'org-1';
const context = { organizationId: ORG } as TenantContext;
const owner = {
  userId: 'u',
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: 'm',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
} as Principal;
const version = (n: number, people: number, monthlyCents: number): PlanVersion => ({
  id: `v${n}`,
  planId: 'starter',
  version: n,
  currency: 'USD',
  monthlyCents,
  yearlyCents: null,
  limits: { ...PLAN_LIMITS.starter, people },
  features: [],
  effectiveFrom: new Date('2026-01-01'),
});
const store = {
  all: vi.fn(),
  forPlan: async () => [version(2, 8, 2900), version(1, 10, 1900)],
  create: vi.fn(),
} as PlanVersionsStore;
const database = {
  read: <T>(_c: TenantContext, work: (db: never) => Promise<T>) => work({} as never),
} as unknown as TenantDatabase;
const subscriptions = {
  find: async () => ({ planId: 'starter', planVersion: 1, currency: 'USD' }) as SubscriptionRow,
} as unknown as SubscriptionRepository;
const service = new PlanVersionsService(database, store, subscriptions);

describe('57-02 versioned plan ladder', () => {
  it('ladder off (the beta) keeps every workspace on the free beta plan', async () => {
    vi.stubEnv('BILLING_MODE', 'paid');
    const plan = await service.current(context, owner);
    expect([plan.ladder, plan.planVersion]).toEqual(['off', null]);
    vi.stubEnv('BILLING_MODE', 'beta_free');
    vi.stubEnv('PLAN_LADDER', 'on');
    const beta = await service.current(context, owner);
    expect([beta.ladder, beta.planId, beta.monthlyCents]).toEqual(['off', 'enterprise', 0]);
  });

  it('a grandfathered workspace keeps the version it subscribed under', async () => {
    vi.stubEnv('BILLING_MODE', 'paid');
    vi.stubEnv('PLAN_LADDER', 'on');
    const plan = await service.current(context, owner);
    expect([plan.planVersion, plan.grandfathered, plan.monthlyCents, plan.limits.people]).toEqual([
      1,
      true,
      1900,
      10,
    ]);
  });

  it('refuses a platform admin who is not a super admin, with no write', async () => {
    const actor = {
      account: { userId: 'p', email: 'p@x' },
      preset: 'support',
    } as PlatformAdminActor;
    await expect(
      service.create(actor, {}, { correlationId: 'c', ip: null, userAgent: null }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('enforces the version limit through the central helper', () => {
    const entitlements = entitlementsFor('starter', 'paid', null, version(2, 8, 2900));
    expect(() => assertWithinPlanLimit(entitlements, 'people', 7)).not.toThrow();
    expect(() => assertWithinPlanLimit(entitlements, 'people', 8)).toThrow(
      expect.objectContaining({ code: 'plan_limit_people' }),
    );
  });
});
