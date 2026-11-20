import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import {
  createTenantContext,
  type TenantContext,
  type TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import {
  AI_CREDITS_TARGET_MONTHLY,
  aiAllowanceOf,
  creditsOfMicroUsd,
  memberShareCredits,
} from './ai-allowance.js';
import { AiAllowanceService, envPoolCapReader } from './ai-allowance.service.js';
import type { LivePack } from './ai-packs.js';
import type { AiWorkspacePlatformSettings, PeriodRow } from './ai-packs.repository.js';
import { PLAN_LIMITS } from './plan-catalog.js';
import { parsePlanLimits } from './plan-versions.js';

/**
 * 62-07 (plan 62 §5) — the allowance resolver matrix: plan → support raise → pool cap, the "by
 * agreement" target, the member share, and the service that reads the inputs (plan from the
 * entitlements, the free beta's top plan, packs counted into the member share).
 */

describe('aiAllowanceOf — plan, support raise, pool cap', () => {
  const CAP = 60_000; // the customers pool (60 USD) in credits

  it.each([
    // plan, raise, cap, allowance, limitedBy, raised
    [0, null, CAP, 0, 'plan', false], // Free: no AI credits
    [1000, null, CAP, 1000, 'plan', false], // Starter
    [2000, null, CAP, 2000, 'plan', false], // Studio
    [3000, null, CAP, 3000, 'plan', false], // Business
    [null, null, CAP, AI_CREDITS_TARGET_MONTHLY, 'agreement', false], // Enterprise, no raise
    [undefined, null, CAP, AI_CREDITS_TARGET_MONTHLY, 'agreement', false], // a version without it
    [1000, 5000, CAP, 5000, 'support', true], // a raise above the plan
    [3000, 500, CAP, 500, 'support', false], // a "raise" below the plan still decides
    [null, 10_000, CAP, 10_000, 'support', true], // Enterprise by agreement
    [3000, null, 2000, 2000, 'platform', false], // the pool cap cuts the plan short
    [1000, 90_000, CAP, CAP, 'platform', true], // and a raise
    [null, null, 0, 0, 'platform', false], // a pool with no cap gives nothing
  ] as const)(
    'plan %s, raise %s, cap %s → %s (%s)',
    (plan, raise, cap, allowance, limitedBy, raised) => {
      expect(aiAllowanceOf(plan, raise, cap)).toEqual({
        allowanceCredits: allowance,
        limitedBy,
        raisedBySupport: raised,
      });
    },
  );

  it('never goes below 0 and counts whole credits only', () => {
    expect(aiAllowanceOf(-5, null, 100).allowanceCredits).toBe(0);
    expect(aiAllowanceOf(10.9, null, 100).allowanceCredits).toBe(10);
    expect(aiAllowanceOf(null, -1, 100)).toMatchObject({
      allowanceCredits: 0,
      limitedBy: 'support',
    });
  });

  it('turns a pool cap in micro-USD into whole credits, rounding down', () => {
    expect(creditsOfMicroUsd(60_000_000)).toBe(60_000);
    expect(creditsOfMicroUsd(1_999)).toBe(1);
    expect(creditsOfMicroUsd(-1)).toBe(0);
  });
});

describe('memberShareCredits', () => {
  it('gives a one-person workspace everything and others their share', () => {
    expect(memberShareCredits(3000, 50, 1)).toBe(3000);
    expect(memberShareCredits(3000, 50, 0)).toBe(3000);
    expect(memberShareCredits(3000, 50, 4)).toBe(1500);
    expect(memberShareCredits(3001, 50, 2)).toBe(1500);
    expect(memberShareCredits(3000, 100, 9)).toBe(3000);
  });

  it('clamps a stored share to 1–100 %', () => {
    expect(memberShareCredits(1000, 0, 3)).toBe(10);
    expect(memberShareCredits(1000, 250, 3)).toBe(1000);
  });
});

describe('the plan catalogue carries the provisional allowance (plan 62 §5)', () => {
  it('Free 0, Starter 1,000, Studio 2,000, Business 3,000, Enterprise by agreement', () => {
    expect(PLAN_LIMITS.free.aiCreditsMonthly).toBe(0);
    expect(PLAN_LIMITS.starter.aiCreditsMonthly).toBe(1000);
    expect(PLAN_LIMITS.studio.aiCreditsMonthly).toBe(2000);
    expect(PLAN_LIMITS.business.aiCreditsMonthly).toBe(3000);
    expect(PLAN_LIMITS.enterprise.aiCreditsMonthly).toBeNull();
  });

  it('a plan version keeps the figure, a null and an absent one; refuses a bad value', () => {
    const base = { people: 3, activeProjects: 3, storageBytes: 1, maxFileBytes: 1 };
    expect(parsePlanLimits({ ...base, aiCreditsMonthly: 1000 }).aiCreditsMonthly).toBe(1000);
    expect(parsePlanLimits({ ...base, aiCreditsMonthly: null }).aiCreditsMonthly).toBeNull();
    expect('aiCreditsMonthly' in parsePlanLimits(base)).toBe(false);
    expect(() => parsePlanLimits({ ...base, aiCreditsMonthly: -1 })).toThrow();
    expect(() => parsePlanLimits({ ...base, aiCreditsMonthly: 1.5 })).toThrow();
  });
});

describe('AiAllowanceService — reads the inputs and resolves once', () => {
  const NOW = new Date('2026-11-20T10:00:00.000Z');
  const RUNNER = {} as TenantQueryRunner;
  const ctx: TenantContext = createTenantContext({
    organizationId: uuidv7(),
    userId: uuidv7(),
    principalKind: 'internal',
    membershipId: uuidv7(),
    capabilities: [],
    policyVersion: 'v1',
    correlationId: uuidv7(),
  });

  function service(input: {
    planId?: string | null;
    raise?: number | null;
    people?: number;
    poolClass?: 'customers' | 'testing';
    period?: PeriodRow | null;
    packs?: readonly LivePack[];
    mode?: 'beta_free' | 'paid';
    share?: number;
  }) {
    const settings: AiWorkspacePlatformSettings = {
      onTestList: true,
      testListAt: NOW,
      poolClass: input.poolClass ?? 'customers',
      memberSharePercent: input.share ?? 50,
    };
    const askedPools: string[] = [];
    const svc = new AiAllowanceService({
      database: { read: async (_c, work) => work(RUNNER) },
      poolCapMicroUsd: async (pool) => {
        askedPools.push(pool);
        return pool === 'customers' ? 60_000_000 : 25_000_000;
      },
      subscriptions: {
        find: async () =>
          input.planId === null || input.planId === undefined
            ? null
            : ({ planId: input.planId } as never),
        countInternalPeople: async () => input.people ?? 3,
      },
      raises: { findRaiseCredits: async () => input.raise ?? null },
      packs: {
        settings: async () => settings,
        readPeriod: async () => input.period ?? null,
        livePacks: async () => input.packs ?? [],
      },
      mode: () => input.mode ?? 'paid',
      now: () => NOW,
    });
    return { svc, askedPools };
  }

  it('takes the stored plan in paid mode and the pool of the workspace class', async () => {
    const { svc, askedPools } = service({ planId: 'starter', poolClass: 'testing' });
    const resolved = await svc.resolveWith(RUNNER, ctx, NOW);
    expect(resolved).toMatchObject({
      periodStart: '2026-11-01',
      allowanceCredits: 1000,
      limitedBy: 'plan',
      memberCredits: 500,
    });
    expect(askedPools).toEqual(['testing']);
  });

  it('gives the free beta the per-workspace target (top plan = by agreement)', async () => {
    const { svc } = service({ planId: 'free', mode: 'beta_free' });
    expect(await svc.resolveWith(RUNNER, ctx, NOW)).toMatchObject({
      allowanceCredits: AI_CREDITS_TARGET_MONTHLY,
      limitedBy: 'agreement',
    });
  });

  it('a workspace with no subscription row reads as Free: 0 credits in paid mode', async () => {
    const { svc } = service({ planId: null });
    expect((await svc.resolveWith(RUNNER, ctx, NOW)).allowanceCredits).toBe(0);
  });

  it('counts pack credits (moved and live) into the member share, never expired ones', async () => {
    const live: LivePack = {
      id: uuidv7(),
      remainingCredits: 400,
      grantedAt: new Date('2026-10-01T00:00:00.000Z'),
      expiresAt: new Date('2027-04-01T00:00:00.000Z'),
    };
    const expired: LivePack = { ...live, id: uuidv7(), expiresAt: new Date('2026-11-01') };
    const period: PeriodRow = {
      periodStart: '2026-11-01',
      allowanceCredits: 1000,
      packCredits: 200,
      settledCredits: 900,
      reservedCredits: 0,
    };
    const { svc } = service({ planId: 'starter', period, packs: [live, expired], people: 2 });
    const resolved = await svc.resolveWith(RUNNER, ctx, NOW);
    expect(resolved.packBalanceCredits).toBe(400);
    expect(resolved.memberCredits).toBe(Math.floor((1000 + 200 + 400) / 2));
  });

  it('forBudget hands openTask the allowance and the member share', async () => {
    const { svc } = service({ planId: 'business', raise: 5000, people: 1 });
    expect(await svc.forBudget(ctx)).toEqual({ workspaceCredits: 5000, memberCredits: 5000 });
  });

  it('the env cap reader splits AI_PLATFORM_CAP_MAX_USD 60 / 25', async () => {
    const read = envPoolCapReader({ AI_PLATFORM_CAP_MAX_USD: '100' });
    expect(await read('customers')).toBe(60_000_000);
    expect(await read('testing')).toBe(25_000_000);
  });
});
