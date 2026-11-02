import { describe, expect, it } from 'vitest';
import { burnOf, forecastExhaustion, parseAlertThresholds, thresholdsCrossed } from './burn.js';

describe('52-05 burn', () => {
  it('reads the larger dimension for both, with at-risk from 85 % and over past 100 %', () => {
    const burn = burnOf({
      type: 'both',
      budgetMinutes: 600,
      budgetAmountMinor: 10_000,
      usedMinutes: 300,
      usedAmountMinor: 8_600,
    });
    expect(burn).toEqual({
      percentBp: 8_600,
      remainingMinutes: 300,
      remainingMinor: 1_400,
      status: 'at_risk',
    });
    expect(burnOf({ ...burnInputHours(), usedMinutes: 601 }).status).toBe('over');
  });

  it('UNIT-52-08: hysteresis raises once, re-arms only below threshold - 5 %', () => {
    const t = [70, 85, 95, 100];
    expect(thresholdsCrossed(t, 0, 7_100)).toEqual({ crossed: [7_000], lastAlertBp: 7_000 });
    expect(thresholdsCrossed(t, 7_000, 6_600)).toEqual({ crossed: [], lastAlertBp: 7_000 });
    expect(thresholdsCrossed(t, 7_000, 7_200).crossed).toEqual([]);
    expect(thresholdsCrossed(t, 7_000, 6_400)).toEqual({ crossed: [], lastAlertBp: 0 });
    expect(thresholdsCrossed(t, 0, 9_600).crossed).toEqual([7_000, 8_500, 9_500]);
  });

  it('forecasts exhaustion from the weekly burn and falls back on bad thresholds', () => {
    expect(forecastExhaustion(600, 1_200, '2026-11-02')).toBe('2026-11-16');
    expect(forecastExhaustion(0, 10, '2026-11-02')).toBeNull();
    expect(parseAlertThresholds('90,80')).toEqual([70, 85, 95, 100]);
  });
});

function burnInputHours() {
  return {
    type: 'hours' as const,
    budgetMinutes: 600,
    budgetAmountMinor: null,
    usedMinutes: 0,
    usedAmountMinor: 0,
  };
}
