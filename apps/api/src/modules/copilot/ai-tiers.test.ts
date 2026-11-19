import { describe, expect, it } from 'vitest';
import { isPricedModel } from './ai-price-table.js';
import {
  AI_POOL_SHARE_PERCENT,
  AI_TIER_SPECS,
  AI_TIERS,
  AiBudgetConfigError,
  choosePool,
  platformCapMicroUsd,
  poolCapsMicroUsd,
  poolLimitPercentFor,
} from './ai-tiers.js';

describe('62-06 tiers', () => {
  it('prices every tier model and never names Opus; ceilings rise with the tier', () => {
    const ceilings = AI_TIERS.map((tier) => AI_TIER_SPECS[tier].ceilingCredits);
    expect(ceilings).toEqual([3, 5, 30, 120, 400]);
    for (const tier of AI_TIERS) {
      expect(isPricedModel(AI_TIER_SPECS[tier].model)).toBe(true);
      expect(AI_TIER_SPECS[tier].model).not.toMatch(/opus/);
    }
    expect(AI_TIERS.filter((tier) => AI_TIER_SPECS[tier].asksFirst)).toEqual([
      'medium_high',
      'high',
    ]);
    expect(AI_TIERS.filter((tier) => AI_TIER_SPECS[tier].payer === 'platform')).toEqual(['help']);
  });
});

describe('62-06 pools', () => {
  it('splits the ceiling 60 / 25 / 15 / 0 and never sums above it', () => {
    expect(poolCapsMicroUsd(100_000_000)).toEqual({
      customers: 60_000_000,
      testing: 25_000_000,
      reserve: 15_000_000,
      packs: 0,
    });
    const odd = poolCapsMicroUsd(33_333_333);
    expect(odd.customers + odd.testing + odd.reserve + odd.packs).toBeLessThanOrEqual(33_333_333);
    expect(Object.values(AI_POOL_SHARE_PERCENT).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('chooses the pool from the caller class and the workspace standing, never reserve or packs', () => {
    const listed = { poolClass: 'customers', onTestList: true } as const;
    const testing = { poolClass: 'testing', onTestList: true } as const;
    const unlisted = { poolClass: 'customers', onTestList: false } as const;
    const member = { kind: 'member' } as const;
    expect(choosePool(member, listed, 'low')).toEqual({
      ok: true,
      pool: 'customers',
      payer: 'workspace',
    });
    expect(choosePool(member, listed, 'help')).toEqual({
      ok: true,
      pool: 'customers',
      payer: 'platform',
    });
    expect(choosePool(member, testing, 'high')).toEqual({
      ok: true,
      pool: 'testing',
      payer: 'workspace',
    });
    expect(choosePool(member, unlisted, 'low')).toEqual({ ok: false, reason: 'not_on_test_list' });
    expect(choosePool({ kind: 'refused' }, listed, 'low')).toEqual({
      ok: false,
      reason: 'caller_not_allowed',
    });
    expect(choosePool({ kind: 'system_job', job: 'benchmark' }, unlisted, 'medium')).toEqual({
      ok: true,
      pool: 'testing',
      payer: 'platform',
    });
    expect(choosePool({ kind: 'system_job', job: 'digest_wording' }, listed, 'low')).toEqual({
      ok: true,
      pool: 'customers',
      payer: 'platform',
    });
  });

  it('limits Sonnet to 80 % of the customer pool only', () => {
    expect(poolLimitPercentFor('customers', 'claude-sonnet-5-5')).toBe(80);
    expect(poolLimitPercentFor('customers', 'claude-haiku-5-5')).toBe(100);
    expect(poolLimitPercentFor('testing', 'claude-sonnet-5-5')).toBe(100);
  });
});

describe('AI_PLATFORM_CAP_MAX_USD', () => {
  it('defaults to 100 USD and reads whole or two-decimal amounts exactly', () => {
    expect(platformCapMicroUsd({})).toBe(100_000_000);
    expect(platformCapMicroUsd({ AI_PLATFORM_CAP_MAX_USD: '  ' })).toBe(100_000_000);
    expect(platformCapMicroUsd({ AI_PLATFORM_CAP_MAX_USD: '40' })).toBe(40_000_000);
    expect(platformCapMicroUsd({ AI_PLATFORM_CAP_MAX_USD: '99.5' })).toBe(99_500_000);
    expect(platformCapMicroUsd({ AI_PLATFORM_CAP_MAX_USD: '0.01' })).toBe(10_000);
  });

  it('refuses anything that is not a positive amount instead of guessing', () => {
    for (const raw of ['0', '-5', '1e3', '100USD', '10.005', 'abc', '0.00']) {
      expect(() => platformCapMicroUsd({ AI_PLATFORM_CAP_MAX_USD: raw })).toThrow(
        AiBudgetConfigError,
      );
    }
  });
});
