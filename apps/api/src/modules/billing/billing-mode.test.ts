import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import {
  TOP_PLAN_ID,
  assertBillingEnabled,
  billingMode,
  entitlementsFor,
  parseBillingMode,
} from './billing-mode.js';
import { PLAN_FEATURE_SET, PLAN_LIMITS } from './plan-catalog.js';
import { PlanUsageService } from './plan-usage.service.js';
import { SubscriptionService } from './subscription.service.js';
import { PlanChangeRequestsService } from './plan-change-requests.service.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import { CreditsService } from './credits.service.js';
import type { SubscriptionRepository } from './subscription.repository.js';
import type { PlanUsageRepository } from './plan-usage.repository.js';
import type { PlanChangeRequestsRepository } from './plan-change-requests.repository.js';
import type { UsageCountersRepository } from '../files/usage-counters.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SubscriptionRow, UsageCounterRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';

// BILLING_MODE — the public-beta switch. beta_free (the default) gives every organization the top
// plan's entitlements and refuses plan changes and purchases with 409 billing_disabled_beta; paid
// keeps the catalog as written.

const ORG = 'org-under-test';
const context = { organizationId: ORG } as TenantContext;

function owner(): Principal {
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

/** Reads run; any write transaction fails the test — a refusal must write nothing. */
function readOnlyDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: () => Promise.reject(new Error('a refused billing action must not write')),
  } as unknown as TenantDatabase;
}

/** A Free organization over its Free limits: 5 people, 4 projects, 3 GB stored. */
function freeOrgUsage(): PlanUsageService {
  const subscriptions = {
    find: () =>
      Promise.resolve({
        planId: 'free',
        status: 'active',
        currentPeriodEnd: null,
      } as SubscriptionRow),
    countInternalPeople: () => Promise.resolve(5),
  } as unknown as SubscriptionRepository;
  const usage = {
    countActiveProjects: () => Promise.resolve(4),
    countClientPeople: () => Promise.resolve(0),
  } as unknown as PlanUsageRepository;
  const counters = {
    find: () =>
      Promise.resolve({ usedValue: 3 * 1024 ** 3, reservedValue: 0 } as unknown as UsageCounterRow),
  } as unknown as UsageCountersRepository;
  return new PlanUsageService(readOnlyDatabase(), subscriptions, usage, counters);
}

async function refusal(action: () => Promise<unknown>): Promise<ApiError> {
  const error = await action().then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('billingMode', () => {
  it('is beta_free when unset or unrecognised, and paid only when asked for', () => {
    expect(billingMode({})).toBe('beta_free');
    expect(parseBillingMode('beta_free')).toBe('beta_free');
    expect(parseBillingMode('payed')).toBe('beta_free');
    expect(parseBillingMode(' PAID ')).toBe('paid');
  });
});

describe('entitlementsFor', () => {
  it('gives a Free organization the top plan in beta_free, and its own plan in paid', () => {
    expect(TOP_PLAN_ID).toBe('enterprise');
    expect(entitlementsFor('free', 'beta_free')).toEqual({
      planId: 'enterprise',
      limits: PLAN_LIMITS.enterprise,
      features: PLAN_FEATURE_SET.enterprise,
    });
    expect(entitlementsFor('free', 'paid')).toEqual({
      planId: 'free',
      limits: PLAN_LIMITS.free,
      features: PLAN_FEATURE_SET.free,
    });
  });

  it('puts nobody over a limit on the plan-usage read in beta_free', async () => {
    const view = await freeOrgUsage().read(context, owner());
    expect(view).toMatchObject({
      planId: 'free',
      billingMode: 'beta_free',
      level: 'normal',
      monthlyCents: 0,
      renewsOn: null,
      graceEndsOn: null,
      nextPlanId: null,
      people: { used: 5, limit: null, level: 'normal' },
      projects: { used: 4, limit: null, level: 'normal' },
      storage: { limit: PLAN_LIMITS.enterprise.storageBytes, level: 'normal' },
    });
  });

  it('keeps the Free limits on the plan-usage read in paid', async () => {
    vi.stubEnv('BILLING_MODE', 'paid');
    const view = await freeOrgUsage().read(context, owner());
    expect(view).toMatchObject({
      planId: 'free',
      billingMode: 'paid',
      level: 'over',
      people: { used: 5, limit: 3, level: 'over' },
      projects: { used: 4, limit: 3, level: 'over' },
      storage: { limit: PLAN_LIMITS.free.storageBytes, level: 'over' },
    });
  });
});

describe('checkout and plan-change refusal in beta_free', () => {
  it('assertBillingEnabled is 409 billing_disabled_beta in beta_free and a no-op in paid', () => {
    expect(() => assertBillingEnabled('paid')).not.toThrow();
    expect(() => assertBillingEnabled('beta_free')).toThrow(ApiError);
  });

  it('refuses a plan change, a plan-change request, a purchase order and a credit, writing nothing', async () => {
    const subscriptions = {} as SubscriptionRepository;
    const attempts = [
      () =>
        new SubscriptionService(readOnlyDatabase(), subscriptions).requestChange(
          context,
          owner(),
          'studio',
        ),
      () =>
        new PlanChangeRequestsService(
          readOnlyDatabase(),
          {} as PlanChangeRequestsRepository,
        ).create(context, owner(), {
          targetPlanCode: 'business',
          effectiveOn: '2099-01-01',
          note: null,
        }),
      () =>
        new PurchaseOrdersService(readOnlyDatabase()).create(context, owner(), {
          poNumber: 'PO-1',
          amountMinor: 1000,
          currency: 'usd',
          note: null,
        }),
      () =>
        new CreditsService(readOnlyDatabase()).post(context, owner(), {
          amount: 500,
          reason: 'goodwill',
        }),
    ];
    for (const attempt of attempts) {
      const error = await refusal(attempt);
      expect(error.status).toBe(409);
      expect(error.code).toBe('billing_disabled_beta');
      expect(error.message).toMatch(/free during the public beta/);
    }
  });

  it('reports the mode and bills nothing on the subscription read in beta_free', async () => {
    const repo = {
      find: () =>
        Promise.resolve({
          planId: 'studio',
          status: 'active',
          currentPeriodEnd: null,
        } as unknown as SubscriptionRow),
      countInternalPeople: () => Promise.resolve(2),
    } as unknown as SubscriptionRepository;
    await expect(
      new SubscriptionService(readOnlyDatabase(), repo).read(context, owner()),
    ).resolves.toMatchObject({ planId: 'studio', nextBillAt: null, billingMode: 'beta_free' });
  });
});
