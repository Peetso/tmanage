import { describe, expect, it } from 'vitest';
import type { BurnBucket } from '../src/lib/api/project-budget-burn';
import { burnLine, forecastBurn, hoursValue, weeklyPace } from '../src/lib/budget-burn-forecast';

const bucket = (key: string, minutes: number): BurnBucket => ({
  key,
  minutes,
  billableMinutes: minutes,
  unpricedMinutes: 0,
});

describe('52-05 budget burn forecast', () => {
  it('builds a cumulative line in week order, starting from time used before the range', () => {
    const line = burnLine([bucket('2026-10-12', 120), bucket('2026-10-05', 60)], 600);
    expect(line).toEqual([
      { week: '2026-10-05', cumulativeMinutes: 480 },
      { week: '2026-10-12', cumulativeMinutes: 600 },
    ]);
    // A stale cache below the range sum never starts the line below zero.
    expect(burnLine([bucket('2026-10-05', 90)], 30)[0]?.cumulativeMinutes).toBe(90);
  });

  it('averages the pace per week over the whole range', () => {
    expect(
      weeklyPace(
        [bucket('2026-10-05', 600), bucket('2026-10-12', 240)],
        '2026-10-05',
        '2026-10-18',
      ),
    ).toBe(420);
    expect(weeklyPace([bucket('2026-10-05', 300)], '2026-10-05', '2026-10-05')).toBe(300);
  });

  it('forecasts the finish day at the current pace and marks 85 % as at risk', () => {
    const forecast = forecastBurn({
      budgetMinutes: 6000,
      usedMinutes: 5100,
      weeklyMinutes: 450,
      today: '2026-11-08',
    });
    expect(forecast).toEqual({
      state: 'at_risk',
      percent: 85,
      overMinutes: 0,
      finishOn: '2026-11-22',
    });
    expect(
      forecastBurn({
        budgetMinutes: 6000,
        usedMinutes: 600,
        weeklyMinutes: 0,
        today: '2026-11-08',
      }),
    ).toMatchObject({ state: 'on_track', finishOn: null });
  });

  it('prefers the server forecast when the API gives one', () => {
    expect(
      forecastBurn({
        budgetMinutes: 6000,
        usedMinutes: 600,
        weeklyMinutes: 60,
        today: '2026-11-08',
        serverForecast: '2026-12-12',
      }).finishOn,
    ).toBe('2026-12-12');
  });

  it('reports over budget with the minutes over, and no budget without one', () => {
    expect(
      forecastBurn({
        budgetMinutes: 9600,
        usedMinutes: 10080,
        weeklyMinutes: 300,
        today: '2026-11-08',
      }),
    ).toEqual({ state: 'over', percent: 105, overMinutes: 480, finishOn: '2026-11-08' });
    expect(
      forecastBurn({
        budgetMinutes: null,
        usedMinutes: 100,
        weeklyMinutes: 10,
        today: '2026-11-08',
      }).state,
    ).toBe('no_budget');
    expect(hoursValue(450)).toBe(7.5);
  });
});
