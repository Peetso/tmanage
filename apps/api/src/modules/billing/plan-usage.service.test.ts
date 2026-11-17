import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PlanUsageService, addMonthUtc, levelOf } from './plan-usage.service.js';
import type { SubscriptionRepository } from './subscription.repository.js';
import type { PlanUsageRepository } from './plan-usage.repository.js';
import type { UsageCountersRepository } from '../files/usage-counters.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SubscriptionRow, UsageCounterRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';
import { StorageAllowanceService } from './storage-allowance.service.js';

// These suites prove the paid behaviour; BILLING_MODE=beta_free (the default) is covered in
// billing-mode.test.ts.
beforeEach(() => {
  vi.stubEnv('BILLING_MODE', 'paid');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// Figma F4 (Plan and usage) — one assertion per key behaviour: the meter levels, the near/over
// read with its grace date, the prorated upgrade (Starter→Studio, 25 Oct = $6.77), the downgrade
// that starts at the period end with an overage, the 400s, and the refusal without org.manage.

const ORG = 'org-under-test';
const GB = 1024 ** 3;
const context = { organizationId: ORG } as TenantContext;
const OCT_25 = new Date('2026-10-25T09:30:00.000Z');
const NOV_1 = new Date('2026-11-01T00:00:00.000Z');

function principal(role: 'owner' | 'member' = 'owner'): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: role === 'owner',
  };
}

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
  } as unknown as TenantDatabase;
}

interface Fixture {
  readonly planId: string | null;
  readonly people: number;
  readonly projects: number;
  readonly clients: number;
  readonly storage: number;
  readonly override?: number | null;
  readonly runs?: number;
}

const CAP = 60 * GB;

function service(fx: Fixture, now: Date = OCT_25): PlanUsageService {
  const tenant = (ctx: TenantContext) => expect(ctx.organizationId).toBe(ORG);
  const subscriptions = {
    find: (_r: never, ctx: TenantContext) => {
      tenant(ctx);
      return Promise.resolve(
        fx.planId === null
          ? null
          : ({ planId: fx.planId, status: 'active', currentPeriodEnd: NOV_1 } as SubscriptionRow),
      );
    },
    countInternalPeople: (_r: never, ctx: TenantContext) => (
      tenant(ctx),
      Promise.resolve(fx.people)
    ),
  } as unknown as SubscriptionRepository;
  const usage = {
    countActiveProjects: (_r: never, ctx: TenantContext) => (
      tenant(ctx),
      Promise.resolve(fx.projects)
    ),
    countClientPeople: (_r: never, ctx: TenantContext) => (
      tenant(ctx),
      Promise.resolve(fx.clients)
    ),
    countAutomationRunsSince: (_r: never, ctx: TenantContext) => (
      tenant(ctx),
      Promise.resolve(fx.runs ?? 0)
    ),
  } as unknown as PlanUsageRepository;
  const overrides = {
    findOverrideBytes: (_r: never, ctx: TenantContext) => (
      tenant(ctx),
      Promise.resolve(fx.override ?? null)
    ),
  };
  const counters = {
    find: (_r: never, ctx: TenantContext) => {
      tenant(ctx);
      return Promise.resolve({ usedValue: fx.storage, reservedValue: 0 } as UsageCounterRow);
    },
  } as unknown as UsageCountersRepository;
  const allowance = new StorageAllowanceService(fakeDatabase(), CAP, subscriptions, overrides);
  return new PlanUsageService(fakeDatabase(), allowance, subscriptions, usage, counters, () => now);
}

describe('levelOf / addMonthUtc', () => {
  it('marks 80 % and the limit itself as near, above the limit as over, no limit as normal', () => {
    expect(levelOf(6, 10)).toBe('normal');
    expect(levelOf(8, 10)).toBe('near');
    expect(levelOf(10, 10)).toBe('near');
    expect(levelOf(11, 10)).toBe('over');
    expect(levelOf(500, null)).toBe('normal');
  });

  it('adds a month clamped to the last day', () => {
    expect(addMonthUtc(new Date('2026-01-31T00:00:00Z')).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });
});

describe('PlanUsageService.read', () => {
  it('reads Starter usage near its limits with no grace date', async () => {
    const view = await service({
      planId: 'starter',
      people: 9,
      projects: 41,
      clients: 23,
      storage: 4.5 * GB,
    }).read(context, principal());
    expect(view).toMatchObject({
      planId: 'starter',
      monthlyCents: 1900,
      renewsOn: '2026-11-01',
      level: 'near',
      graceEndsOn: null,
      people: { used: 9, limit: 10, level: 'near' },
      projects: { used: 41, limit: null, level: 'normal' },
      storage: { limit: 5 * GB, level: 'near', percent: 90, threshold: 85 },
      clients: 23,
      nextPlanId: 'studio',
      nextPlanPeopleLimit: null,
      nextPlanStorageBytes: 10 * GB,
    });
  });

  it('marks over-limit usage and gives one month after renewal to sort it out', async () => {
    const view = await service({
      planId: 'starter',
      people: 11,
      projects: 44,
      clients: 23,
      storage: 5.4 * GB,
    }).read(context, principal());
    expect(view.level).toBe('over');
    expect(view.graceEndsOn).toBe('2026-12-01');
  });

  it('returns the temporary storage figures, a support raise and the runs counter', async () => {
    const view = await service({
      planId: 'free',
      people: 1,
      projects: 1,
      clients: 0,
      storage: 2 * GB,
      override: 2 * GB,
      runs: 1240,
    }).read(context, principal());
    expect(view.storage).toMatchObject({
      used: 2 * GB,
      limit: 2 * GB,
      percent: 100,
      threshold: 100,
      raisedBySupport: true,
    });
    expect(view.automationRuns).toBe(1240);
  });

  it('reads only the caller workspace: figures are looked up by the context organization', async () => {
    const byOrg: Record<string, { bytes: number; runs: number; override: number | null }> = {
      [ORG]: { bytes: 1 * GB, runs: 7, override: null },
      'another-org': { bytes: 9 * GB, runs: 999, override: 50 * GB },
    };
    const of = (ctx: TenantContext) => byOrg[ctx.organizationId]!;
    const subscriptions = {
      find: () => Promise.resolve({ planId: 'starter', status: 'active' } as SubscriptionRow),
      countInternalPeople: () => Promise.resolve(1),
    } as unknown as SubscriptionRepository;
    const usage = {
      countActiveProjects: () => Promise.resolve(0),
      countClientPeople: () => Promise.resolve(0),
      countAutomationRunsSince: (_r: never, ctx: TenantContext) => Promise.resolve(of(ctx).runs),
    } as unknown as PlanUsageRepository;
    const counters = {
      find: (_r: never, ctx: TenantContext) =>
        Promise.resolve({ usedValue: of(ctx).bytes, reservedValue: 0 } as UsageCounterRow),
    } as unknown as UsageCountersRepository;
    const overrides = {
      findOverrideBytes: (_r: never, ctx: TenantContext) => Promise.resolve(of(ctx).override),
    };
    const allowance = new StorageAllowanceService(fakeDatabase(), CAP, subscriptions, overrides);
    const view = await new PlanUsageService(
      fakeDatabase(),
      allowance,
      subscriptions,
      usage,
      counters,
      () => OCT_25,
    ).read(context, principal());
    expect(view.storage).toMatchObject({ used: 1 * GB, limit: 5 * GB, raisedBySupport: false });
    expect(view.automationRuns).toBe(7);
  });

  it('refuses a member without org.manage', async () => {
    await expect(
      service({ planId: 'starter', people: 1, projects: 1, clients: 0, storage: 0 }).read(
        context,
        principal('member'),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('PlanUsageService.preview', () => {
  it('prorates an upgrade for the days left and lists what is gained', async () => {
    const preview = await service({
      planId: 'starter',
      people: 9,
      projects: 41,
      clients: 23,
      storage: 4.5 * GB,
    }).preview(context, principal(), 'studio');
    expect(preview).toMatchObject({
      direction: 'upgrade',
      currentMonthlyCents: 1900,
      targetMonthlyCents: 4900,
      startsOn: '2026-10-25',
      startsToday: true,
      daysLeft: 7,
      dueTodayCents: 677,
      fullPriceFrom: '2026-11-01',
      overages: [],
      graceEndsOn: null,
    });
    expect(preview.changes.map((c) => `${c.direction}:${c.feature ?? c.kind}`)).toEqual([
      'gain:people',
      'gain:storage',
      'gain:docs_decisions',
      'gain:insights_automations',
    ]);
  });

  it('starts a downgrade at the period end, charges nothing and flags the storage overage', async () => {
    const preview = await service({
      planId: 'studio',
      people: 8,
      projects: 20,
      clients: 4,
      storage: 7.5 * GB,
    }).preview(context, principal(), 'starter');
    expect(preview).toMatchObject({
      direction: 'downgrade',
      startsOn: '2026-11-01',
      startsToday: false,
      dueTodayCents: 0,
      graceEndsOn: '2026-12-01',
    });
    expect(preview.overages).toHaveLength(1);
    expect(preview.overages[0]?.kind).toBe('storage');
    expect(preview.overages[0]?.over).toBeCloseTo(2.5 * GB, -3);
    expect(preview.changes.map((c) => `${c.direction}:${c.feature ?? c.kind}:${c.fits}`)).toEqual([
      'lose:storage:false',
      'lose:people:true',
      'lose:insights_automations:false',
      'lose:docs_decisions:false',
    ]);
  });

  it('refuses an off-catalog, a custom-priced and the current plan with a 400', async () => {
    const s = service({ planId: 'starter', people: 1, projects: 1, clients: 0, storage: 0 });
    for (const target of ['platinum', 'enterprise', 'starter']) {
      const error = await s.preview(context, principal(), target).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(400);
    }
  });
});
