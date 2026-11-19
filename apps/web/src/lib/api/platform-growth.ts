import type { ApiClient } from './client';

/**
 * 57-09 · Growth (R44 L2) — the platform admin's read of `GET /v1/platform/activity/growth`
 * (`platform.activity.view`), built nightly by the worker's growth job. Rates arrive as 0–1
 * fractions, durations in hours. Mirrors the API's `GrowthView` (`growth.repository.ts`) in the
 * fields the screen draws.
 */
export type GrowthPeriod = 'week' | 'month';

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
  readonly computedAt: string | null;
  readonly tiles: {
    readonly signups: number;
    readonly activationRate7d: number | null;
    readonly serviceActivationRate14d: number | null;
    readonly timeToFirstProjectP50Hours: number | null;
  };
  readonly tables: {
    readonly series: readonly GrowthPeriodRow[];
    readonly signupsBySource: readonly { readonly source: string; readonly count: number }[];
    readonly activationFunnel: readonly { readonly step: string; readonly count: number }[];
    readonly retention: readonly {
      readonly cohortWeek: string;
      readonly size: number;
      readonly weeks: readonly (number | null)[];
    }[];
  };
  readonly figures: GrowthFigures;
}

/**
 * 62-A3 (B14) — the success and cost tiles. Each names its own period and ignores the page's
 * week / month switch. `null` AI counters = no data yet; a figure that cannot be shown says why.
 */
export interface GrowthFigures {
  readonly weeklyActiveCompanies: {
    readonly weekStart: string;
    readonly active: number;
    readonly companies: number;
  } | null;
  readonly firstProjectFinished: {
    readonly within30d: number | null;
    readonly within60d: number | null;
  };
  readonly timeToFirstOutcomeP50Hours: number | null;
  readonly ai: {
    readonly month: string;
    readonly tasksRun: number | null;
    readonly tasksCompleted: number | null;
    readonly creditsUsed: number | null;
    readonly creditsCap: number;
  };
  readonly costPerActiveCompany:
    | { readonly available: true; readonly month: string; readonly cents: number }
    | { readonly available: false; readonly reason: 'not_set' | 'no_active_companies' };
  readonly margin:
    | { readonly available: true; readonly month: string; readonly rate: number }
    | { readonly available: false; readonly reason: 'beta_free' | 'not_set' | 'no_revenue' };
}

/** A count as a 0–100 share of its whole, for a meter; 0 when the whole is 0. */
export function shareOf(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.min(100, Math.round((part / whole) * 100));
}

export function growthPath(period: GrowthPeriod): string {
  return `/v1/platform/activity/growth?period=${period}`;
}

export function fetchGrowth(client: ApiClient, period: GrowthPeriod): Promise<GrowthView> {
  return client.request<GrowthView>({ path: growthPath(period) }).then(({ data }) => data);
}

/** A 0–1 rate as a whole percent; null stays null ("no data yet"). */
export function percent(rate: number | null): number | null {
  return rate === null ? null : Math.round(rate * 100);
}

/** Bar heights 0–100 against the largest period, so the tallest bar fills the chart. */
export function barHeights(series: readonly GrowthPeriodRow[]): readonly number[] {
  const top = Math.max(0, ...series.map((row) => row.signups));
  return series.map((row) => (top === 0 ? 0 : Math.round((row.signups / top) * 100)));
}

/** Each funnel step as a percent of the first step (the companies that signed up). */
export function funnelPercents(
  steps: readonly { readonly step: string; readonly count: number }[],
): readonly { readonly step: string; readonly count: number; readonly percent: number }[] {
  const first = steps[0]?.count ?? 0;
  return steps.map((item) => ({
    ...item,
    percent: first === 0 ? 0 : Math.round((item.count / first) * 100),
  }));
}

/** The growth CSV route; the browser downloads it under the session cookie. */
export function growthCsvPath(period: GrowthPeriod): string {
  return `/v1/platform/activity/growth/export.csv?period=${period}`;
}
