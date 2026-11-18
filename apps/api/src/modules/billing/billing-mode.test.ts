import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import {
  TOP_PLAN_ID,
  assertBillingEnabled,
  billingMode,
  effectiveBillingMode,
  entitlementsFor,
  parseBillingMode,
  resolveBillingMode,
} from './billing-mode.js';
import {
  PLATFORM_SETTINGS_CACHE_MS,
  PlatformSettingsReader,
  installPlatformSettingsReader,
  resetPlatformSettingsReader,
} from './platform-settings-reader.js';
import { PLAN_FEATURE_SET, PLAN_LIMITS } from './plan-catalog.js';
import { PlanUsageService } from './plan-usage.service.js';
import { StorageAllowanceService } from './storage-allowance.service.js';
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

/** 57-13r: no explicit ceiling, the deployment default; the plan allowance alone decides. */
const PLATFORM_CEILING = null;

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
    countAutomationRunsSince: () => Promise.resolve(0),
  } as unknown as PlanUsageRepository;
  const counters = {
    find: () =>
      Promise.resolve({ usedValue: 3 * 1024 ** 3, reservedValue: 0 } as unknown as UsageCounterRow),
  } as unknown as UsageCountersRepository;
  // 57-13r: the platform cap (1 TB here) is the allowance when the plan has no figure.
  const allowance = new StorageAllowanceService(
    readOnlyDatabase(),
    PLATFORM_CEILING,
    subscriptions,
    {
      findOverrideBytes: () => Promise.resolve(null),
    },
  );
  return new PlanUsageService(readOnlyDatabase(), allowance, subscriptions, usage, counters);
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
      storage: { limit: null, level: 'normal', threshold: 0 },
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

// ---- platform-admin v2 · PA-07 ----
// The Platform admin's `platform_settings.billing_mode` wins over BILLING_MODE (30 s cache), and
// one organization can be pinned to a mode or given its own limits.
describe('billing mode from the platform setting (PA-07)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetPlatformSettingsReader();
  });

  function readerOver(value: () => string | null, clock: { now: number }) {
    let loads = 0;
    const reader = new PlatformSettingsReader(
      async () => {
        loads += 1;
        return value();
      },
      PLATFORM_SETTINGS_CACHE_MS,
      () => clock.now,
    );
    return { reader, loads: () => loads };
  }

  it('the DB setting overrides the environment', async () => {
    vi.stubEnv('BILLING_MODE', 'beta_free');
    const { reader } = readerOver(() => 'paid', { now: 0 });
    expect(await resolveBillingMode(process.env, reader)).toBe('paid');
    expect(billingMode(process.env, reader)).toBe('paid');
  });

  it('falls back to the environment with no row or an unknown value', async () => {
    vi.stubEnv('BILLING_MODE', 'paid');
    expect(await resolveBillingMode(process.env, readerOver(() => null, { now: 0 }).reader)).toBe(
      'paid',
    );
    expect(await resolveBillingMode(process.env, readerOver(() => 'free', { now: 0 }).reader)).toBe(
      'paid',
    );
    expect(billingMode(process.env, null)).toBe('paid');
  });

  it('caches the setting for 30 s, then reads it again', async () => {
    const clock = { now: 1_000 };
    let stored = 'paid';
    const { reader, loads } = readerOver(() => stored, clock);
    expect(await resolveBillingMode({}, reader)).toBe('paid');
    stored = 'beta_free';
    clock.now += PLATFORM_SETTINGS_CACHE_MS - 1;
    expect(await resolveBillingMode({}, reader)).toBe('paid');
    expect(loads()).toBe(1);
    clock.now += 2;
    expect(await resolveBillingMode({}, reader)).toBe('beta_free');
    expect(loads()).toBe(2);
  });

  it('uses the installed reader by default once a module installed one', async () => {
    const { reader } = readerOver(() => 'paid', { now: 0 });
    installPlatformSettingsReader(reader);
    expect(await resolveBillingMode({})).toBe('paid');
    expect(billingMode({})).toBe('paid');
  });

  it('a per-organization override wins over the platform mode; inherit keeps it', () => {
    expect(effectiveBillingMode('beta_free', 'paid')).toBe('paid');
    expect(effectiveBillingMode('paid', 'beta_free')).toBe('beta_free');
    expect(effectiveBillingMode('paid', null)).toBe('paid');
    expect(effectiveBillingMode('beta_free', 'inherit')).toBe('beta_free');
  });

  it('organization limits win over the plan field by field', () => {
    const merged = entitlementsFor('starter', 'paid', {
      people: 40,
      activeProjects: null,
      storageBytes: 5,
    });
    expect(merged.limits).toEqual({
      people: 40,
      activeProjects: PLAN_LIMITS.starter.activeProjects,
      storageBytes: 5,
    });
    expect(entitlementsFor('starter', 'paid', null).limits).toEqual(PLAN_LIMITS.starter);
  });
});
