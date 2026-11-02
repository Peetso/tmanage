import { describe, expect, it } from 'vitest';
import { buildGrowthView, growthToCsv, parseGrowthQuery } from './growth.repository.js';

const now = new Date('2026-11-02T08:00:00Z');
const r = (periodStart: string, metric: string, dimension: string, value: number, n = 0) => ({
  periodStart,
  metric,
  dimension,
  value,
  sampleCount: n,
  computedAt: '2026-11-02T02:00:00.000Z',
});

describe('platform growth view (57-14)', () => {
  it('defaults to 13 months by month and refuses a bad period or range', () => {
    expect(parseGrowthQuery({}, now)).toEqual({
      period: 'month',
      from: '2025-11-01',
      to: '2026-11-02',
    });
    expect(() => parseGrowthQuery({ period: 'day' }, now)).toThrow();
    expect(() => parseGrowthQuery({ from: '2026-10-02', to: '2026-10-01' }, now)).toThrow();
  });

  it('adds counts, weights rates, snapshots MRR and marks what is not built', () => {
    const view = buildGrowthView(parseGrowthQuery({}, now), [
      r('2026-09-01', 'signups', '', 4, 4),
      r('2026-10-01', 'signups', '', 6, 6),
      r('2026-10-01', 'signups', 'ads', 6, 6),
      r('2026-09-01', 'activation_7d_rate', '', 0.5, 4),
      r('2026-10-01', 'activation_7d_rate', '', 0, 6),
      r('2026-10-01', 'mrr_cents', '', 6800, 2),
      r('2026-10-01', 'gtm_report_sent', '', 1, 1),
    ]);
    expect(view.tiles.signups).toBe(10);
    expect(view.tiles.activationRate7d).toBe(0.2);
    expect(view.tiles.mrr).toMatchObject({ source: 'subscriptions', cents: 6800 });
    expect(view.tiles.mrr.churn.available).toBe(false);
    expect(view.tables.signupsBySource).toEqual([{ source: 'ads', count: 6 }]);
    for (const key of ['checkoutConversionByCountry', 'foundingCounter', 'referrals'] as const) {
      expect(view[key].available).toBe(false);
    }
    expect(
      growthToCsv('month', [r('2026-10-01', 'gtm_report_sent', '', 1)]).split('\r\n'),
    ).toHaveLength(2);
  });
});
