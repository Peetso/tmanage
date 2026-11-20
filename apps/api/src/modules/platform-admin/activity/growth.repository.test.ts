import { describe, expect, it } from 'vitest';
import {
  buildGrowthFigures,
  buildGrowthView,
  growthToCsv,
  parseGrowthQuery,
  type GrowthFigureRow,
} from './growth.repository.js';

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
    const figures = buildGrowthFigures(
      { rows: [], unitCosts: null },
      { billingMode: 'beta_free', platformCapMicroUsd: 100_000_000, now },
    );
    const view = buildGrowthView(
      parseGrowthQuery({}, now),
      [
        r('2026-09-01', 'signups', '', 4, 4),
        r('2026-10-01', 'signups', '', 6, 6),
        r('2026-10-01', 'signups', 'ads', 6, 6),
        r('2026-09-01', 'activation_7d_rate', '', 0.5, 4),
        r('2026-10-01', 'activation_7d_rate', '', 0, 6),
        r('2026-10-01', 'mrr_cents', '', 6800, 2),
        r('2026-10-01', 'gtm_report_sent', '', 1, 1),
      ],
      figures,
      now,
    );
    expect(view.tiles.signups).toBe(10);
    expect(view.freshness).toBe('fresh');
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

  it('says when the figures are stale or were never computed (GROWTH-FIX)', () => {
    const figures = buildGrowthFigures(
      { rows: [], unitCosts: null },
      { billingMode: 'beta_free', platformCapMicroUsd: 100_000_000, now },
    );
    const query = parseGrowthQuery({}, now);
    const later = new Date('2026-11-04T08:00:00Z');
    const rows = [r('2026-10-01', 'signups', '', 6, 6)];
    expect(buildGrowthView(query, rows, figures, later).freshness).toBe('stale');
    expect(buildGrowthView(query, [], figures, now)).toMatchObject({
      computedAt: null,
      freshness: 'none',
    });
  });
});

describe('62-A3 growth figures (B14)', () => {
  const fig = (
    periodKind: 'week' | 'month',
    periodStart: string,
    metric: string,
    dimension: string,
    value: number,
    n = 0,
  ): GrowthFigureRow => ({ ...r(periodStart, metric, dimension, value, n), periodKind });
  const context = { billingMode: 'beta_free' as const, platformCapMicroUsd: 100_000_000, now };
  const costs = { hostingCentsPerMonth: 3000, mailCentsPerMonth: 1000 };
  const rows = [
    fig('week', '2026-10-19', 'active_companies', '', 120, 380),
    fig('week', '2026-10-26', 'active_companies', '', 142, 384),
    fig('month', '2026-11-01', 'active_companies', '', 160, 384),
    fig('month', '2026-09-01', 'first_project_finished_rate', '30d', 0.2, 10),
    fig('month', '2026-10-01', 'first_project_finished_rate', '30d', 0.4, 30),
    fig('month', '2026-09-01', 'first_project_finished_rate', '60d', 0.44, 10),
    fig('month', '2026-10-01', 'time_to_first_outcome_hours', 'p50', 76.8, 5),
    fig('month', '2026-11-01', 'ai_cost_micro_usd', '', 2_500_000, 3),
    fig('month', '2026-11-01', 'ai_tasks_run', '', 40, 40),
    fig('month', '2026-11-01', 'ai_tasks_completed', '', 31, 40),
    fig('month', '2026-11-01', 'ai_credits_used', '', 2500, 3),
    fig('month', '2026-10-01', 'ai_tasks_run', '', 7, 7), // last month: not "this month"
    fig('month', '2026-11-01', 'mrr_cents', '', 50_000, 10),
  ];

  it('reads each tile from its own period, not the page switch', () => {
    const figures = buildGrowthFigures({ rows, unitCosts: costs }, context);
    expect(figures.weeklyActiveCompanies).toEqual({
      weekStart: '2026-10-26',
      active: 142,
      companies: 384,
    });
    expect(figures.firstProjectFinished).toEqual({ within30d: 0.35, within60d: 0.44 });
    expect(figures.timeToFirstOutcomeP50Hours).toBe(76.8);
    expect(figures.ai).toEqual({
      month: '2026-11-01',
      tasksRun: 40,
      tasksCompleted: 31,
      creditsUsed: 2500,
      creditsCap: 100_000,
    });
    // (250 AI + 3000 hosting + 1000 mail cents) / 160 active companies, rounded up
    expect(figures.costPerActiveCompany).toEqual({
      available: true,
      month: '2026-11-01',
      cents: 27,
    });
  });

  it('says no data yet for AI, not set for unit costs and never shows 0 in their place', () => {
    const figures = buildGrowthFigures({ rows: [], unitCosts: null }, context);
    expect(figures.ai).toMatchObject({ tasksRun: null, tasksCompleted: null, creditsUsed: null });
    expect(figures.weeklyActiveCompanies).toBeNull();
    expect(figures.costPerActiveCompany).toEqual({ available: false, reason: 'not_set' });
    const noneActive = buildGrowthFigures({ rows: [], unitCosts: costs }, context);
    expect(noneActive.costPerActiveCompany).toEqual({
      available: false,
      reason: 'no_active_companies',
    });
  });

  it('keeps the margin not available in the free beta, and computes it once billing is paid', () => {
    expect(buildGrowthFigures({ rows, unitCosts: costs }, context).margin).toEqual({
      available: false,
      reason: 'beta_free',
    });
    const paid = { ...context, billingMode: 'paid' as const };
    expect(buildGrowthFigures({ rows, unitCosts: null }, paid).margin).toEqual({
      available: false,
      reason: 'not_set',
    });
    expect(buildGrowthFigures({ rows, unitCosts: costs }, paid).margin).toEqual({
      available: true,
      month: '2026-11-01',
      rate: 0.915, // (50 000 − 4250) / 50 000
    });
  });
});
