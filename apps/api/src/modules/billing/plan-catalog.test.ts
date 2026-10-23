import { describe, expect, it } from 'vitest';
import {
  PLAN_IDS,
  PLAN_MONTHLY_CENTS,
  canonicalPlanId,
  isPlanId,
  readPlanId,
} from './plan-catalog.js';

// The flat plan catalog (A12): five plans, flat prices, `pro` accepted and read as `studio`.

describe('plan catalog', () => {
  it('lists the five flat plans with the prices the pricing page draws', () => {
    expect(PLAN_IDS).toEqual(['free', 'starter', 'studio', 'business', 'enterprise']);
    expect(PLAN_MONTHLY_CENTS).toEqual({
      free: 0,
      starter: 1900,
      studio: 4900,
      business: 8900,
      enterprise: null,
    });
  });

  it('accepts the legacy pro id and reads it as studio', () => {
    expect(isPlanId('pro')).toBe(true);
    expect(canonicalPlanId('pro')).toBe('studio');
    expect(readPlanId('pro')).toBe('studio');
  });

  it('refuses an unknown id and reads it as the default free tier', () => {
    expect(isPlanId('enterprise-unlimited')).toBe(false);
    expect(isPlanId('toString')).toBe(false);
    expect(readPlanId(undefined)).toBe('free');
  });
});
