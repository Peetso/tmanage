import type { RowDataPacket } from 'mysql2';
import { growthFreshness } from '@tmanage/domain';
import type { GrowthFreshness } from '@tmanage/domain';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { ApiError } from '../../../common/http/errors.js';
import { escapeCsvCell } from '../../audit/audit-export-csv.js';
import type { BillingMode } from '../../billing/billing-mode.js';
import {
  UNIT_COSTS_SETTING,
  monthlyUnitCostCents,
  parseStoredUnitCosts,
  type UnitCosts,
} from '../settings/unit-costs.js';

/**
 * 57-14 Growth — the read side of `platform_growth_rollups` (0284), written nightly by the
 * worker's growth job. Identity path over a GLOBAL table (NON_TENANT_TABLES): the rows are
 * platform-wide counts, rates and durations, never one organization's data.
 *
 * The pure half (query parsing, the view, the CSV) is exported for the unit test. Numbers that
 * need billing events (57-03) or referrals (57-08) come back `available: false` — never invented.
 *
 * 62-A3 (B14) adds `figures`: the success and cost tiles. They name their own period ("this week",
 * "this month", "within 30 days") and do not move with the page's week / month switch, which sets
 * the period of the sign-up figures only. An AI figure with no rollup row is `null` ("no data
 * yet"); the cost per active company needs the unit costs typed in Platform settings ("not set",
 * never 0); the margin is not available while billing is `beta_free`.
 */

export type GrowthPeriod = 'week' | 'month';

export interface GrowthQuery {
  readonly period: GrowthPeriod;
  /** `YYYY-MM-DD`, inclusive. */
  readonly from: string;
  readonly to: string;
}

export interface GrowthRollup {
  readonly periodStart: string;
  readonly metric: string;
  readonly dimension: string;
  readonly value: number;
  readonly sampleCount: number;
  readonly computedAt: string;
}

export interface NotAvailable {
  readonly available: false;
  readonly reason: string;
}

export interface GrowthFunnelStep {
  readonly step: string;
  readonly count: number;
}

export interface GrowthPeriodRow {
  readonly periodStart: string;
  readonly signups: number;
  readonly activationRate7d: number | null;
  readonly serviceActivationRate14d: number | null;
  readonly timeToFirstProjectP50Hours: number | null;
  readonly approvalTurnaroundP50Hours: number | null;
}

export interface GrowthView {
  readonly period: GrowthPeriod;
  readonly from: string;
  readonly to: string;
  /** When the newest row in range was computed; `null` before the first run. */
  readonly computedAt: string | null;
  /**
   * GROWTH-FIX: whether `computedAt` is current (the domain's 26 h window); `none` before the
   * first run. The server decides it, so the page never guesses from a clock (§1.2).
   */
  readonly freshness: GrowthFreshness;
  readonly tiles: {
    readonly signups: number;
    readonly activationRate7d: number | null;
    readonly serviceActivationRate14d: number | null;
    readonly timeToFirstProjectP50Hours: number | null;
    readonly approvalTurnaroundHours: {
      readonly p50: number | null;
      readonly p75: number | null;
      readonly p90: number | null;
    };
    readonly mrr: {
      readonly source: 'subscriptions';
      readonly cents: number | null;
      readonly newCents: number | null;
      readonly paidSubscriptions: number | null;
      readonly expansion: NotAvailable;
      readonly churn: NotAvailable;
    };
  };
  readonly tables: {
    readonly series: readonly GrowthPeriodRow[];
    readonly signupsBySource: readonly { readonly source: string; readonly count: number }[];
    readonly activationFunnel: readonly GrowthFunnelStep[];
    readonly serviceFunnel: readonly GrowthFunnelStep[];
    readonly retention: readonly {
      readonly cohortWeek: string;
      readonly size: number;
      readonly weeks: readonly (number | null)[];
    }[];
    readonly mrrByPlan: readonly { readonly plan: string; readonly cents: number }[];
  };
  readonly checkoutConversionByCountry: NotAvailable;
  readonly foundingCounter: NotAvailable;
  readonly referrals: NotAvailable;
  readonly figures: GrowthFigures;
}

/** 62-A3: a figure that cannot be shown, and why (the screen words each reason). */
export interface FigureNotAvailable<Reason extends string> {
  readonly available: false;
  readonly reason: Reason;
}

export type CostPerActiveCompany =
  | { readonly available: true; readonly month: string; readonly cents: number }
  | FigureNotAvailable<'not_set' | 'no_active_companies'>;

export type GrowthMargin =
  | { readonly available: true; readonly month: string; readonly rate: number }
  | FigureNotAvailable<'beta_free' | 'not_set' | 'no_revenue'>;

export interface GrowthFigures {
  /** The newest week's companies with 2+ internal people active, of those that existed then. */
  readonly weeklyActiveCompanies: {
    readonly weekStart: string;
    readonly active: number;
    readonly companies: number;
  } | null;
  /** Sample-weighted over the window's sign-up months; 0–1 fractions. */
  readonly firstProjectFinished: {
    readonly within30d: number | null;
    readonly within60d: number | null;
  };
  readonly timeToFirstOutcomeP50Hours: number | null;
  /** This month's AI counters; `null` = no data yet. */
  readonly ai: {
    readonly month: string;
    readonly tasksRun: number | null;
    readonly tasksCompleted: number | null;
    readonly creditsUsed: number | null;
    /** The platform ceiling in credits (1 credit = 0.001 USD). */
    readonly creditsCap: number;
  };
  readonly costPerActiveCompany: CostPerActiveCompany;
  readonly margin: GrowthMargin;
}

/** One rollup row of either period kind, for the fixed-period figures. */
export interface GrowthFigureRow extends GrowthRollup {
  readonly periodKind: GrowthPeriod;
}

export interface GrowthFigureInputs {
  readonly rows: readonly GrowthFigureRow[];
  readonly unitCosts: UnitCosts | null;
}

export interface GrowthFigureContext {
  readonly billingMode: BillingMode;
  readonly platformCapMicroUsd: number;
  readonly now: Date;
}

/** The metrics the figures read, both period kinds. */
export const FIGURE_METRICS = [
  'active_companies',
  'first_project_finished_rate',
  'time_to_first_outcome_hours',
  'ai_tasks_run',
  'ai_tasks_completed',
  'ai_cost_micro_usd',
  'ai_credits_used',
  'mrr_cents',
] as const;

export const ACTIVATION_STEPS = [
  'org',
  'project',
  'invites_3',
  'work_items_10',
  'converted_message',
  'completed_work',
] as const;
export const SERVICE_STEPS = ['client_linked', 'approval_decided'] as const;
export const RETENTION_WEEKS = 8;
/** The worker's once-a-month mail marker; bookkeeping, never shown. */
export const HIDDEN_METRICS: readonly string[] = ['gtm_report_sent'];

const BILLING_EVENTS = 'needs billing events (57-03)';
const REFERRALS = 'needs referrals (57-08)';
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 3 * 366;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'Check the filter and try again.', [
    { field, message },
  ]);
}

const isoDay = (at: Date): string => at.toISOString().slice(0, 10);

function day(raw: unknown, field: string, fallback: string): string {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string' || !ISO_DAY.test(raw.trim())) throw invalid(field, 'YYYY-MM-DD');
  const value = raw.trim();
  const at = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(at.getTime()) || isoDay(at) !== value) throw invalid(field, 'a real date');
  return value;
}

/** `?period=week|month&from&to` — default the last 13 months by month. */
export function parseGrowthQuery(
  raw: { period?: unknown; from?: unknown; to?: unknown },
  now: Date,
): GrowthQuery {
  const period = raw.period === undefined || raw.period === '' ? 'month' : raw.period;
  if (period !== 'week' && period !== 'month') throw invalid('period', 'week or month');
  const defaultFrom = isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1)));
  const from = day(raw.from, 'from', defaultFrom);
  const to = day(raw.to, 'to', isoDay(now));
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
  if (span < 0) throw invalid('to', 'on or after from');
  if (span > MAX_RANGE_DAYS) throw invalid('from', `a range of at most ${MAX_RANGE_DAYS} days`);
  return { period, from, to };
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** A sample-weighted mean of per-period values (rates, medians) — `null` when nothing. */
function weighted(rows: readonly GrowthRollup[]): number | null {
  const n = sum(rows.map((r) => r.sampleCount));
  if (n === 0) return null;
  return round4(sum(rows.map((r) => r.value * r.sampleCount)) / n);
}

const NA = (reason: string): NotAvailable => ({ available: false, reason });

const MICRO_USD_PER_CENT = 10_000;
const MICRO_USD_PER_CREDIT = 1_000;

const monthOf = (at: Date): string =>
  isoDay(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)));

/** 62-A3: the success and cost tiles from their own periods (see the file header). */
export function buildGrowthFigures(
  inputs: GrowthFigureInputs,
  context: GrowthFigureContext,
): GrowthFigures {
  const month = monthOf(context.now);
  const rows = (kind: GrowthPeriod, metric: string, dimension = '') =>
    inputs.rows.filter(
      (r) => r.periodKind === kind && r.metric === metric && r.dimension === dimension,
    );
  const thisMonth = (metric: string): number | null =>
    rows('month', metric).find((r) => r.periodStart === month)?.value ?? null;

  const weeks = rows('week', 'active_companies').sort((a, b) =>
    a.periodStart.localeCompare(b.periodStart),
  );
  const newestWeek = weeks[weeks.length - 1];

  const active = thisMonth('active_companies');
  const aiCostMicroUsd = thisMonth('ai_cost_micro_usd') ?? 0;
  const monthCostCents =
    inputs.unitCosts === null
      ? null
      : Math.ceil(aiCostMicroUsd / MICRO_USD_PER_CENT) + monthlyUnitCostCents(inputs.unitCosts);

  const costPerActiveCompany: CostPerActiveCompany =
    monthCostCents === null
      ? { available: false, reason: 'not_set' }
      : active === null || active === 0
        ? { available: false, reason: 'no_active_companies' }
        : { available: true, month, cents: Math.ceil(monthCostCents / active) };

  const mrr = thisMonth('mrr_cents');
  const margin: GrowthMargin =
    context.billingMode === 'beta_free'
      ? { available: false, reason: 'beta_free' }
      : monthCostCents === null
        ? { available: false, reason: 'not_set' }
        : mrr === null || mrr === 0
          ? { available: false, reason: 'no_revenue' }
          : { available: true, month, rate: round4((mrr - monthCostCents) / mrr) };

  return {
    weeklyActiveCompanies:
      newestWeek === undefined
        ? null
        : {
            weekStart: newestWeek.periodStart,
            active: newestWeek.value,
            companies: newestWeek.sampleCount,
          },
    firstProjectFinished: {
      within30d: weighted(rows('month', 'first_project_finished_rate', '30d')),
      within60d: weighted(rows('month', 'first_project_finished_rate', '60d')),
    },
    timeToFirstOutcomeP50Hours: weighted(rows('month', 'time_to_first_outcome_hours', 'p50')),
    ai: {
      month,
      tasksRun: thisMonth('ai_tasks_run'),
      tasksCompleted: thisMonth('ai_tasks_completed'),
      creditsUsed: thisMonth('ai_credits_used'),
      creditsCap: Math.floor(context.platformCapMicroUsd / MICRO_USD_PER_CREDIT),
    },
    costPerActiveCompany,
    margin,
  };
}

/**
 * The Growth view over one period kind's rows in range. Counts add up across periods; rates and
 * medians are sample-weighted means of the periods (an approximation of the range's median, and
 * the per-period values sit in `tables.series`). MRR is the newest month's snapshot.
 */
export function buildGrowthView(
  query: GrowthQuery,
  all: readonly GrowthRollup[],
  figures: GrowthFigures,
  now: Date,
): GrowthView {
  const rows = all.filter((r) => !HIDDEN_METRICS.includes(r.metric));
  const of = (metric: string, dimension?: string) =>
    rows.filter(
      (r) => r.metric === metric && (dimension === undefined || r.dimension === dimension),
    );
  const total = (metric: string, dimension: string) =>
    sum(of(metric, dimension).map((r) => r.value));

  const periods = [...new Set(rows.map((r) => r.periodStart))].sort();
  const at = (start: string, metric: string, dimension = '') =>
    rows.find((r) => r.periodStart === start && r.metric === metric && r.dimension === dimension)
      ?.value ?? null;
  const series = periods
    .filter(
      (start) =>
        at(start, 'signups') !== null || at(start, 'approval_turnaround_hours', 'p50') !== null,
    )
    .map((start) => ({
      periodStart: start,
      signups: at(start, 'signups') ?? 0,
      activationRate7d: at(start, 'activation_7d_rate'),
      serviceActivationRate14d: at(start, 'service_activation_14d_rate'),
      timeToFirstProjectP50Hours: at(start, 'time_to_first_project_hours', 'p50'),
      approvalTurnaroundP50Hours: at(start, 'approval_turnaround_hours', 'p50'),
    }));

  const sources = new Map<string, number>();
  for (const r of of('signups')) {
    if (r.dimension === '') continue;
    sources.set(r.dimension, (sources.get(r.dimension) ?? 0) + r.value);
  }

  const cohorts = [...new Set(of('retention').map((r) => r.periodStart))].sort();
  const retention = cohorts.map((cohortWeek) => {
    const list = of('retention').filter((r) => r.periodStart === cohortWeek);
    return {
      cohortWeek,
      size: Math.max(0, ...list.map((r) => r.sampleCount)),
      weeks: Array.from(
        { length: RETENTION_WEEKS },
        (_, i) => list.find((r) => r.dimension === `w${String(i + 1)}`)?.value ?? null,
      ),
    };
  });

  const mrrMonths = of('mrr_cents', '')
    .map((r) => r.periodStart)
    .sort();
  const latest = mrrMonths[mrrMonths.length - 1];
  const snapshot = (metric: string, dimension = '') =>
    latest === undefined ? null : at(latest, metric, dimension);
  const mrrByPlan =
    latest === undefined
      ? []
      : of('mrr_cents')
          .filter((r) => r.periodStart === latest && r.dimension.startsWith('plan:'))
          .map((r) => ({ plan: r.dimension.slice('plan:'.length), cents: r.value }));

  const computed = rows.map((r) => r.computedAt).sort();
  return {
    period: query.period,
    from: query.from,
    to: query.to,
    computedAt: computed[computed.length - 1] ?? null,
    freshness: growthFreshness(
      computed.length === 0 ? null : new Date(computed[computed.length - 1] as string),
      now,
    ),
    tiles: {
      signups: total('signups', ''),
      activationRate7d: weighted(of('activation_7d_rate', '')),
      serviceActivationRate14d: weighted(of('service_activation_14d_rate', '')),
      timeToFirstProjectP50Hours: weighted(of('time_to_first_project_hours', 'p50')),
      approvalTurnaroundHours: {
        p50: weighted(of('approval_turnaround_hours', 'p50')),
        p75: weighted(of('approval_turnaround_hours', 'p75')),
        p90: weighted(of('approval_turnaround_hours', 'p90')),
      },
      mrr: {
        source: 'subscriptions',
        cents: snapshot('mrr_cents'),
        newCents: snapshot('new_mrr_cents'),
        paidSubscriptions: snapshot('paid_subscriptions'),
        expansion: NA(BILLING_EVENTS),
        churn: NA(BILLING_EVENTS),
      },
    },
    tables: {
      series,
      signupsBySource: [...sources]
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
      activationFunnel: ACTIVATION_STEPS.map((step) => ({
        step,
        count: total('activation_7d', step),
      })),
      serviceFunnel: SERVICE_STEPS.map((step) => ({
        step,
        count: total('service_activation_14d', step),
      })),
      retention,
      mrrByPlan,
    },
    checkoutConversionByCountry: NA(BILLING_EVENTS),
    foundingCounter: NA(BILLING_EVENTS),
    referrals: NA(REFERRALS),
    figures,
  };
}

export const GROWTH_CSV_HEADER = [
  'periodKind',
  'periodStart',
  'metric',
  'dimension',
  'value',
  'sampleCount',
  'computedAt',
] as const;

/** The rollup rows as CSV, with the action log export's escaping (formula guard, RFC 4180). */
export function growthToCsv(period: GrowthPeriod, rows: readonly GrowthRollup[]): string {
  const lines = [GROWTH_CSV_HEADER.join(',')];
  for (const row of rows) {
    if (HIDDEN_METRICS.includes(row.metric)) continue;
    lines.push(
      [
        period,
        row.periodStart,
        row.metric,
        row.dimension,
        String(row.value),
        String(row.sampleCount),
        row.computedAt,
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ── I/O ──────────────────────────────────────────────────────────────────────

type Row = RowDataPacket & Record<string, unknown>;

export const GROWTH_READ_SQL = `select period_start, metric, dimension, value_num, sample_count,
    computed_at
  from platform_growth_rollups
  where period_kind = ? and period_start >= ? and period_start <= ?
  order by period_start, metric, dimension
  limit 20000`;

const TABLES = ['platform_growth_rollups'] as const;

/** 62-A3: the figures' rows (both kinds, the window) and the unit-cost setting. */
export const GROWTH_FIGURES_SQL = {
  rows: `select period_kind, period_start, metric, dimension, value_num, sample_count, computed_at
    from platform_growth_rollups
    where period_start >= ? and metric in (${FIGURE_METRICS.map(() => '?').join(', ')})
    order by period_kind, period_start, metric, dimension
    limit 5000`,
  unitCosts: `select setting_value from platform_settings where setting_key = ? limit 1`,
} as const;

const FIGURE_TABLES = ['platform_growth_rollups', 'platform_settings'] as const;

function dayText(value: unknown): string {
  if (value instanceof Date) return isoDay(value);
  return String(value ?? '').slice(0, 10);
}

function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value ?? ''));
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

export function toGrowthRollup(row: Record<string, unknown>): GrowthRollup {
  const value = Number(row['value_num']);
  const samples = Number(row['sample_count']);
  return {
    periodStart: dayText(row['period_start']),
    metric: String(row['metric']),
    dimension: String(row['dimension'] ?? ''),
    value: Number.isFinite(value) ? value : 0,
    sampleCount: Number.isFinite(samples) ? samples : 0,
    computedAt: instant(row['computed_at']),
  };
}

export class GrowthRepository {
  constructor(private readonly database: TenantDatabase) {}

  /** 62-A3: the inputs of {@link buildGrowthFigures}, from 13 months back. */
  async figureInputs(correlationId: string, now: Date): Promise<GrowthFigureInputs> {
    const since = isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1)));
    return this.database.identityRead(
      { correlationId, tables: [...FIGURE_TABLES] },
      async (runner) => {
        const rows = await runner.query<Row[]>(GROWTH_FIGURES_SQL.rows, [since, ...FIGURE_METRICS]);
        const [setting] = await runner.query<Row[]>(GROWTH_FIGURES_SQL.unitCosts, [
          UNIT_COSTS_SETTING,
        ]);
        return {
          rows: rows.map((row) => ({
            ...toGrowthRollup(row),
            periodKind: row['period_kind'] === 'week' ? 'week' : 'month',
          })),
          unitCosts: parseStoredUnitCosts(
            setting === undefined ? null : String(setting['setting_value'] ?? ''),
          ),
        };
      },
    );
  }

  async rollups(query: GrowthQuery, correlationId: string): Promise<readonly GrowthRollup[]> {
    return this.database.identityRead({ correlationId, tables: [...TABLES] }, async (runner) => {
      const rows = await runner.query<Row[]>(GROWTH_READ_SQL, [query.period, query.from, query.to]);
      return rows.map(toGrowthRollup);
    });
  }
}
