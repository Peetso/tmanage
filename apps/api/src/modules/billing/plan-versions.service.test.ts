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

describe('PLANWEB public figures and the sign-up pick', () => {
  const later = (n: number): PlanVersion => ({
    ...version(n, 8, 2900),
    effectiveFrom: new Date('2999-01-01'),
  });
  const free: PlanVersion = { ...version(1, 3, 0), id: 'f1', planId: 'free' };
  const enterprise: PlanVersion = {
    ...version(1, 0, 0),
    id: 'e1',
    planId: 'enterprise',
    monthlyCents: null,
  };
  const ladder = [later(3), version(2, 8, 2900), version(1, 10, 1900), free, enterprise];
  const all = vi.fn(async () => ladder);
  const publicService = new PlanVersionsService(database, {
    all,
    forPlan: async (planId: string) => ladder.filter((v) => v.planId === planId),
    create: vi.fn(),
  } as PlanVersionsStore);

  it('shows no plan and no price while the beta is free, without reading the table', async () => {
    vi.stubEnv('BILLING_MODE', 'beta_free');
    await expect(publicService.publishedPlans('c')).resolves.toEqual({ visible: false, plans: [] });
    expect(all).not.toHaveBeenCalled();
    await expect(publicService.signupChoice('starter', 'c')).resolves.toBeNull();
  });

  it('paid: each plan at the version in force now, in catalog order', async () => {
    vi.stubEnv('BILLING_MODE', 'paid');
    const view = await publicService.publishedPlans('c');
    expect(view.plans.map((p) => [p.planId, p.version, p.monthlyCents])).toEqual([
      ['free', 1, 0],
      ['starter', 2, 2900],
      ['enterprise', 1, null],
    ]);
  });

  it('a sign-up pick is checked, never trusted: unknown or not in force is ignored', async () => {
    vi.stubEnv('BILLING_MODE', 'paid');
    expect((await publicService.signupChoice('starter', 'c'))?.version).toBe(2);
    await expect(publicService.signupChoice('platinum', 'c')).resolves.toBeNull();
    await expect(publicService.signupChoice('studio', 'c')).resolves.toBeNull();
    await expect(publicService.signupChoice('enterprise', 'c')).resolves.toBeNull();
    await expect(publicService.signupChoice({ planId: 'free' }, 'c')).resolves.toBeNull();
  });
});
