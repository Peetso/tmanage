/**
 * 57-14 — the platform growth rollups (migration 0284, `platform_growth_rollups`).
 *
 * Nightly (02:00 UTC), and on boot when the newest `computed_at` is older than 26 hours, the job
 * recomputes the last 13 months of week and month rollups and upserts them on the table's unique
 * key (idempotent: a rerun rewrites the same rows):
 *
 * - `signups` by source (the `signup_completed_v1` product event's `source`; `unattributed`
 *   until a sign-up carries one), plus the total under dimension `''`.
 * - `activation_7d` — the funnel org → project → 3 internal invites → 10 work items → 1 converted
 *   message (a decision made from a chat message) → 1 completed work item, each step counted only
 *   when the steps before it were reached, all within 7 days of the sign-up; `activation_7d_rate`.
 * - `service_activation_14d` — client linked → approval decided, within 14 days; and its rate.
 * - `time_to_first_project_hours` p50 by sign-up period.
 * - `retention` (week cohorts only): the internal actor hashes active in an organization's sign-up
 *   week, and the share of them active again in week n (1-8). Only weeks that have fully passed.
 * - `mrr_cents` / `new_mrr_cents` / `paid_subscriptions` for the current month, from
 *   `subscriptions` × the catalog's monthly price — 0 while the billing mode is `beta_free`.
 *   Expansion and churn need billing events (57-03) and are not written.
 * - `approval_turnaround_hours` p50/p75/p90 by decision period.
 * - 62-A3 (B14): `active_companies` — companies with 2 or more internal people active in the period
 *   (sample = companies that existed by its end); `first_project_finished_rate` (30d / 60d) — the
 *   share of sign-ups whose first project was finished (completed or archived) within 30 / 60 days,
 *   over the sign-ups whose window has fully passed; `time_to_first_outcome_hours` p50 — sign-up to
 *   the first approval decided or client invoice issued, whichever came first; the AI counters
 *   `ai_tasks_run` / `ai_tasks_completed` / `ai_tasks_undone` (from `ai_tasks`) and
 *   `ai_cost_micro_usd` / `ai_credits_used` (real spend from `ai_usage_ledger`; 1 credit = 1000
 *   micro-USD). A period with no AI row writes no AI figure ("no data yet", never 0).
 *
 * Ids, hashes and timestamps are read; only counts, rates and durations are written (PRIV-06).
 * Rows older than 13 months are deleted. On the 1st (UTC) the job mails the previous month's
 * report to `ALERT_EMAILS` once (`gtm_report_sent` marks it). This file holds no SQL;
 * `common/database/growth-rollup-store.ts` does.
 */
import { GROWTH_STALE_MS } from '@tmanage/domain';
import type { GtmRollupCsvRow, Mailer, MonthlyGtmReportInput } from '@tmanage/mail';

export type GrowthPeriodKind = 'week' | 'month';
export type BillingModeName = 'beta_free' | 'paid';

/** One organization's sign-up and the milestones the funnels count (from the store). */
export interface OrgGrowthFacts {
  readonly createdAt: Date;
  readonly source: string | null;
  readonly firstProjectAt: Date | null;
  readonly internalInvites7d: number;
  readonly workItems7d: number;
  readonly convertedMessages7d: number;
  readonly completedWork7d: number;
  readonly clientLinkedAt: Date | null;
  readonly approvalDecidedAt: Date | null;
  /** 62-A3: when the first project was completed or archived. */
  readonly firstProjectFinishedAt: Date | null;
  /** 62-A3: the first client invoice issued (its issue date). */
  readonly firstInvoiceIssuedAt: Date | null;
  /** Opaque key grouping the actor rows of the same organization; never written. */
  readonly key: string;
}

/** One internal actor hash active in one UTC week (Monday start). */
export interface ActorWeek {
  readonly key: string;
  readonly actorHash: string;
  readonly weekStart: string;
}

/** One internal actor hash active in one period (week: Monday start; month: the 1st). */
export interface ActorPeriod {
  readonly key: string;
  readonly actorHash: string;
  readonly periodStart: string;
}

/** One UTC day of AI tasks, counted in SQL (no id leaves the store). */
export interface AiTaskDay {
  readonly day: string;
  readonly run: number;
  readonly completed: number;
  readonly undone: number;
}

/** One UTC day of settled AI spend in micro-USD, summed in SQL. */
export interface AiCostDay {
  readonly day: string;
  readonly costMicroUsd: number;
}

export interface SubscriptionFact {
  readonly planId: string;
  readonly createdAt: Date;
}

export interface ApprovalFact {
  readonly createdAt: Date;
  readonly decidedAt: Date;
}

export interface RollupRow {
  readonly periodKind: GrowthPeriodKind;
  readonly periodStart: string;
  readonly metric: string;
  readonly dimension: string;
  readonly value: number;
  readonly sampleCount: number;
}

export interface GrowthRollupStore {
  lastComputedAt(): Promise<Date | null>;
  organizations(since: Date): Promise<readonly OrgGrowthFacts[]>;
  actorWeeks(since: Date): Promise<readonly ActorWeek[]>;
  /** 62-A3: as {@link actorWeeks}, by calendar month. */
  actorMonths(since: Date): Promise<readonly ActorPeriod[]>;
  /** 62-A3: every company that exists now. */
  companiesTotal(): Promise<number>;
  aiTaskDays(since: Date): Promise<readonly AiTaskDay[]>;
  aiCostDays(since: Date): Promise<readonly AiCostDay[]>;
  subscriptions(): Promise<readonly SubscriptionFact[]>;
  approvals(since: Date): Promise<readonly ApprovalFact[]>;
  /** `platform_settings.billing_mode` when set; `null` falls back to the environment. */
  billingModeSetting(): Promise<string | null>;
  upsert(rows: readonly RollupRow[], computedAt: Date): Promise<number>;
  deleteBefore(periodStart: string): Promise<number>;
  reportSent(monthStart: string): Promise<boolean>;
}

export const GROWTH_RUN_HOUR_UTC = 2;
/** The domain's freshness window (`@tmanage/domain` growth/freshness): the API reads the same. */
export { GROWTH_STALE_MS };
export const GROWTH_TICK_MS = 60 * 60 * 1000;
export const GROWTH_MONTHS_KEPT = 13;
export const RETENTION_WEEKS = 8;
export const SIGNUP_SOURCE_UNATTRIBUTED = 'unattributed';
export const REPORT_SENT_METRIC = 'gtm_report_sent';

/**
 * Flat monthly price per plan in US cents — the API catalog's `PLAN_MONTHLY_CENTS`
 * (`apps/api/src/modules/billing/plan-catalog.ts`), repeated because one app may not import
 * another's `src/`. Enterprise is quoted per contract and counts 0 here. `pro` is `studio`.
 */
export const PLAN_MONTHLY_CENTS: Readonly<Record<string, number>> = {
  free: 0,
  starter: 1900,
  studio: 4900,
  pro: 4900,
  business: 8900,
  enterprise: 0,
};

export const ACTIVATION_STEPS = [
  'org',
  'project',
  'invites_3',
  'work_items_10',
  'converted_message',
  'completed_work',
] as const;
export const SERVICE_STEPS = ['client_linked', 'approval_decided'] as const;
/** 62-A3: a company is active in a period when at least this many internal people were. */
export const ACTIVE_COMPANY_MIN_PEOPLE = 2;
/** 62-A3: the windows of "first project finished within N days". */
export const FIRST_PROJECT_WINDOWS_DAYS = [30, 60] as const;
/** 1 credit = 0.001 USD of real cost (plan 62 §5). */
export const MICRO_USD_PER_CREDIT = 1_000;

const DAY_MS = 86_400_000;

// ── Periods ────────────────────────────────────────────────────────────────

const iso = (at: Date): string => at.toISOString().slice(0, 10);

export function weekStart(at: Date): string {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const shift = (day.getUTCDay() + 6) % 7; // Monday = 0
  return iso(new Date(day.getTime() - shift * DAY_MS));
}

export function monthStart(at: Date): string {
  return iso(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)));
}

export function periodStart(kind: GrowthPeriodKind, at: Date): string {
  return kind === 'week' ? weekStart(at) : monthStart(at);
}

/** The first day of the month `months` before `now`'s month. */
export function monthsBack(now: Date, months: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
}

const addDays = (start: string, days: number): string =>
  iso(new Date(Date.parse(`${start}T00:00:00Z`) + days * DAY_MS));

// ── Maths ──────────────────────────────────────────────────────────────────

/** Nearest-rank percentile of `values` (0 < p ≤ 1); `null` when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] as number;
}

const within = (from: Date, at: Date | null, days: number): boolean =>
  at !== null && at.getTime() >= from.getTime() && at.getTime() < from.getTime() + days * DAY_MS;

/** How far down the 7-day funnel one organization got (1 = signed up only … 6 = all steps). */
export function activationDepth(org: OrgGrowthFacts): number {
  const reached = [
    true,
    within(org.createdAt, org.firstProjectAt, 7),
    org.internalInvites7d >= 3,
    org.workItems7d >= 10,
    org.convertedMessages7d >= 1,
    org.completedWork7d >= 1,
  ];
  let depth = 0;
  while (depth < reached.length && reached[depth]) depth += 1;
  return depth;
}

export function serviceDepth(org: OrgGrowthFacts): number {
  if (!within(org.createdAt, org.clientLinkedAt, 14)) return 0;
  return within(org.createdAt, org.approvalDecidedAt, 14) ? 2 : 1;
}

const SLUG = /^[a-z][a-z0-9_.-]{0,47}$/;

export function signupSource(raw: string | null): string {
  return raw !== null && SLUG.test(raw) ? raw : SIGNUP_SOURCE_UNATTRIBUTED;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

function group<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = out.get(key);
    if (list === undefined) out.set(key, [item]);
    else list.push(item);
  }
  return out;
}

/** Sign-ups, both funnels and time to first project, per sign-up period. */
export function organizationRollups(
  kind: GrowthPeriodKind,
  orgs: readonly OrgGrowthFacts[],
): RollupRow[] {
  const rows: RollupRow[] = [];
  for (const [start, members] of group(orgs, (org) => periodStart(kind, org.createdAt))) {
    const n = members.length;
    const row = (metric: string, dimension: string, value: number, sampleCount = n): RollupRow => ({
      periodKind: kind,
      periodStart: start,
      metric,
      dimension,
      value: round4(value),
      sampleCount,
    });
    rows.push(row('signups', '', n));
    for (const [source, list] of group(members, (org) => signupSource(org.source))) {
      rows.push(row('signups', source, list.length));
    }
    const depths = members.map(activationDepth);
    ACTIVATION_STEPS.forEach((step, index) => {
      rows.push(row('activation_7d', step, depths.filter((d) => d > index).length));
    });
    const activated = depths.filter((d) => d >= ACTIVATION_STEPS.length).length;
    rows.push(row('activation_7d_rate', '', activated / n));
    const service = members.map(serviceDepth);
    SERVICE_STEPS.forEach((step, index) => {
      rows.push(row('service_activation_14d', step, service.filter((d) => d > index).length));
    });
    const served = service.filter((d) => d >= SERVICE_STEPS.length).length;
    rows.push(row('service_activation_14d_rate', '', served / n));
    const ttfp = members
      .filter((org) => org.firstProjectAt !== null)
      .map((org) => ((org.firstProjectAt as Date).getTime() - org.createdAt.getTime()) / 3_600_000)
      .filter((h) => h >= 0);
    const p50 = percentile(ttfp, 0.5);
    if (p50 !== null) rows.push(row('time_to_first_project_hours', 'p50', p50, ttfp.length));
    const ttfo = members
      .map((org) => {
        const outcome = firstOutcomeAt(org);
        return outcome === null ? null : (outcome.getTime() - org.createdAt.getTime()) / 3_600_000;
      })
      .filter((h): h is number => h !== null && h >= 0);
    const outcomeP50 = percentile(ttfo, 0.5);
    if (outcomeP50 !== null) {
      rows.push(row('time_to_first_outcome_hours', 'p50', outcomeP50, ttfo.length));
    }
  }
  return rows;
}

/** 62-A3: the first outcome — the first approval decided or client invoice issued, whichever first. */
export function firstOutcomeAt(org: OrgGrowthFacts): Date | null {
  const times = [org.approvalDecidedAt, org.firstInvoiceIssuedAt].filter(
    (at): at is Date => at !== null,
  );
  return times.length === 0 ? null : new Date(Math.min(...times.map((at) => at.getTime())));
}

/** The first day after the period that starts on `start`. */
function periodEnd(kind: GrowthPeriodKind, start: string): number {
  const at = new Date(`${start}T00:00:00Z`);
  return kind === 'week'
    ? at.getTime() + 7 * DAY_MS
    : Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
}

/**
 * 62-A3: companies with {@link ACTIVE_COMPANY_MIN_PEOPLE}+ internal people active in each period.
 * The sample is the companies that existed by the period's end: every company now, less those
 * created after it (`orgs` holds every sign-up of the window the periods are drawn from).
 */
export function activeCompanyRollups(
  kind: GrowthPeriodKind,
  actors: readonly ActorPeriod[],
  orgs: readonly OrgGrowthFacts[],
  companiesTotal: number,
): RollupRow[] {
  const people = new Map<string, Map<string, Set<string>>>(); // period → company → hashes
  for (const actor of actors) {
    const companies = people.get(actor.periodStart) ?? new Map<string, Set<string>>();
    const hashes = companies.get(actor.key) ?? new Set<string>();
    hashes.add(actor.actorHash);
    companies.set(actor.key, hashes);
    people.set(actor.periodStart, companies);
  }
  return [...people].map(([start, companies]) => {
    const end = periodEnd(kind, start);
    const createdLater = orgs.filter((org) => org.createdAt.getTime() >= end).length;
    return {
      periodKind: kind,
      periodStart: start,
      metric: 'active_companies',
      dimension: '',
      value: [...companies.values()].filter((h) => h.size >= ACTIVE_COMPANY_MIN_PEOPLE).length,
      sampleCount: Math.max(0, companiesTotal - createdLater),
    };
  });
}

/**
 * 62-A3: per sign-up period, the share of sign-ups whose first project was finished within 30 and
 * 60 days. Only sign-ups whose window has fully passed count (a younger one would read as a miss).
 */
export function firstProjectFinishedRollups(
  kind: GrowthPeriodKind,
  orgs: readonly OrgGrowthFacts[],
  now: Date,
): RollupRow[] {
  const rows: RollupRow[] = [];
  for (const [start, members] of group(orgs, (org) => periodStart(kind, org.createdAt))) {
    for (const days of FIRST_PROJECT_WINDOWS_DAYS) {
      const eligible = members.filter(
        (org) => org.createdAt.getTime() + days * DAY_MS <= now.getTime(),
      );
      if (eligible.length === 0) continue;
      const finished = eligible.filter((org) =>
        within(org.createdAt, org.firstProjectFinishedAt, days),
      ).length;
      rows.push({
        periodKind: kind,
        periodStart: start,
        metric: 'first_project_finished_rate',
        dimension: `${String(days)}d`,
        value: round4(finished / eligible.length),
        sampleCount: eligible.length,
      });
    }
  }
  return rows;
}

/**
 * 62-A3: the AI counters per period, from day aggregates. A period with no task and no spend gets
 * no row, so the page says "no data yet" rather than 0.
 */
export function aiRollups(
  kind: GrowthPeriodKind,
  tasks: readonly AiTaskDay[],
  costs: readonly AiCostDay[],
): RollupRow[] {
  const at = (day: string) => periodStart(kind, new Date(`${day}T00:00:00Z`));
  const rows: RollupRow[] = [];
  // The sample is the tasks run (task counters) or the days with spend (cost figures).
  const row = (start: string, metric: string, value: number, sampleCount: number): RollupRow => ({
    periodKind: kind,
    periodStart: start,
    metric,
    dimension: '',
    value,
    sampleCount,
  });
  for (const [start, list] of group(tasks, (task) => at(task.day))) {
    const total = (pick: (task: AiTaskDay) => number) => list.reduce((n, t) => n + pick(t), 0);
    const run = total((t) => t.run);
    rows.push(
      row(start, 'ai_tasks_run', run, run),
      row(
        start,
        'ai_tasks_completed',
        total((t) => t.completed),
        run,
      ),
      row(
        start,
        'ai_tasks_undone',
        total((t) => t.undone),
        run,
      ),
    );
  }
  for (const [start, list] of group(costs, (cost) => at(cost.day))) {
    const micro = list.reduce((n, c) => n + c.costMicroUsd, 0);
    rows.push(
      row(start, 'ai_cost_micro_usd', micro, list.length),
      row(start, 'ai_credits_used', Math.ceil(micro / MICRO_USD_PER_CREDIT), list.length),
    );
  }
  return rows;
}

/**
 * Weekly cohort retention. A cohort is the internal actors active in their organization's sign-up
 * week; week n counts those active again n weeks later. Weeks that have not fully passed are left
 * out — an unfinished week would read as churn.
 */
export function retentionRollups(
  orgs: readonly OrgGrowthFacts[],
  actors: readonly ActorWeek[],
  now: Date,
): RollupRow[] {
  const activeIn = new Map<string, Set<string>>(); // key|week → actor hashes
  for (const actor of actors) {
    const id = `${actor.key}|${actor.weekStart}`;
    const set = activeIn.get(id);
    if (set === undefined) activeIn.set(id, new Set([actor.actorHash]));
    else set.add(actor.actorHash);
  }
  const size = new Map<string, number>();
  const retained = new Map<string, number[]>();
  for (const org of orgs) {
    const cohortWeek = weekStart(org.createdAt);
    const cohort = activeIn.get(`${org.key}|${cohortWeek}`);
    if (cohort === undefined || cohort.size === 0) continue;
    size.set(cohortWeek, (size.get(cohortWeek) ?? 0) + cohort.size);
    const counts = retained.get(cohortWeek) ?? new Array<number>(RETENTION_WEEKS).fill(0);
    for (let n = 1; n <= RETENTION_WEEKS; n += 1) {
      const later = activeIn.get(`${org.key}|${addDays(cohortWeek, 7 * n)}`);
      if (later === undefined) continue;
      for (const hash of cohort) if (later.has(hash)) counts[n - 1] = (counts[n - 1] ?? 0) + 1;
    }
    retained.set(cohortWeek, counts);
  }
  const rows: RollupRow[] = [];
  for (const [cohortWeek, total] of size) {
    const counts = retained.get(cohortWeek) ?? [];
    for (let n = 1; n <= RETENTION_WEEKS; n += 1) {
      const weekEnd = Date.parse(`${addDays(cohortWeek, 7 * (n + 1))}T00:00:00Z`);
      if (weekEnd > now.getTime()) break;
      rows.push({
        periodKind: 'week',
        periodStart: cohortWeek,
        metric: 'retention',
        dimension: `w${String(n)}`,
        value: round4((counts[n - 1] ?? 0) / total),
        sampleCount: total,
      });
    }
  }
  return rows;
}

/** This month's MRR from current subscriptions; 0 throughout while billing is `beta_free`. */
export function mrrRollups(
  subscriptions: readonly SubscriptionFact[],
  mode: BillingModeName,
  now: Date,
): RollupRow[] {
  const month = monthStart(now);
  const priceOf = (planId: string): number =>
    mode === 'paid' ? (PLAN_MONTHLY_CENTS[planId] ?? 0) : 0;
  const paid = subscriptions.filter((sub) => priceOf(sub.planId) > 0);
  const mrr = paid.reduce((sum, sub) => sum + priceOf(sub.planId), 0);
  const fresh = paid.filter((sub) => monthStart(sub.createdAt) === month);
  const row = (metric: string, dimension: string, value: number, n: number): RollupRow => ({
    periodKind: 'month',
    periodStart: month,
    metric,
    dimension,
    value,
    sampleCount: n,
  });
  const rows = [
    row('mrr_cents', '', mrr, paid.length),
    row(
      'new_mrr_cents',
      '',
      fresh.reduce((sum, sub) => sum + priceOf(sub.planId), 0),
      fresh.length,
    ),
    row('paid_subscriptions', '', paid.length, paid.length),
  ];
  for (const [planId, list] of group(paid, (sub) =>
    sub.planId === 'pro' ? 'studio' : sub.planId,
  )) {
    rows.push(row('mrr_cents', `plan:${planId}`, list.length * priceOf(planId), list.length));
  }
  return rows;
}

export function approvalRollups(
  kind: GrowthPeriodKind,
  approvals: readonly ApprovalFact[],
): RollupRow[] {
  const rows: RollupRow[] = [];
  for (const [start, list] of group(approvals, (a) => periodStart(kind, a.decidedAt))) {
    const hours = list
      .map((a) => (a.decidedAt.getTime() - a.createdAt.getTime()) / 3_600_000)
      .filter((h) => h >= 0);
    for (const [label, p] of [
      ['p50', 0.5],
      ['p75', 0.75],
      ['p90', 0.9],
    ] as const) {
      const value = percentile(hours, p);
      if (value === null) continue;
      rows.push({
        periodKind: kind,
        periodStart: start,
        metric: 'approval_turnaround_hours',
        dimension: label,
        value: round4(value),
        sampleCount: hours.length,
      });
    }
  }
  return rows;
}

export function parseBillingModeName(raw: string | null | undefined): BillingModeName {
  return (raw ?? '').trim().toLowerCase() === 'paid' ? 'paid' : 'beta_free';
}

// ── Schedule ───────────────────────────────────────────────────────────────

/** Due on boot when the last run is > 26 h old, and nightly once 02:00 UTC has passed. */
export function growthRunDue(last: Date | null, now: Date): boolean {
  if (last === null) return true;
  if (now.getTime() - last.getTime() > GROWTH_STALE_MS) return true;
  const tonight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    GROWTH_RUN_HOUR_UTC,
  );
  return last.getTime() < tonight && now.getTime() >= tonight;
}

// ── Report ─────────────────────────────────────────────────────────────────

const valueOf = (rows: readonly RollupRow[], metric: string, dimension = ''): number | null =>
  rows.find((r) => r.metric === metric && r.dimension === dimension)?.value ?? null;

/** The previous month's report input, from that month's month rollups. */
export function reportInput(
  monthRows: readonly RollupRow[],
  month: string,
  mode: BillingModeName,
  generatedAt: Date,
): MonthlyGtmReportInput {
  const steps = (metric: string, names: readonly string[]) =>
    names.map((step) => ({ step, count: valueOf(monthRows, metric, step) ?? 0 }));
  const p = (label: string) => valueOf(monthRows, 'approval_turnaround_hours', label);
  const p50 = p('p50');
  const mrr = valueOf(monthRows, 'mrr_cents');
  const csvRows: GtmRollupCsvRow[] = monthRows.map((r) => ({ ...r }));
  return {
    month: month.slice(0, 7),
    generatedAt,
    signups: valueOf(monthRows, 'signups') ?? 0,
    signupsBySource: monthRows
      .filter((r) => r.metric === 'signups' && r.dimension !== '')
      .map((r) => ({ source: r.dimension, count: r.value })),
    activation: {
      steps: steps('activation_7d', ACTIVATION_STEPS),
      rate: valueOf(monthRows, 'activation_7d_rate'),
    },
    serviceActivation: {
      steps: steps('service_activation_14d', SERVICE_STEPS),
      rate: valueOf(monthRows, 'service_activation_14d_rate'),
    },
    timeToFirstProjectP50Hours: valueOf(monthRows, 'time_to_first_project_hours', 'p50'),
    approvalTurnaroundHours:
      p50 === null ? null : { p50, p75: p('p75') ?? p50, p90: p('p90') ?? p50 },
    mrr:
      mrr === null
        ? null
        : {
            cents: mrr,
            newCents: valueOf(monthRows, 'new_mrr_cents') ?? 0,
            paidSubscriptions: valueOf(monthRows, 'paid_subscriptions') ?? 0,
            billingMode: mode,
          },
    rows: csvRows,
  };
}

export interface GrowthRunDeps {
  readonly store: GrowthRollupStore;
  readonly mailer: Mailer | null;
  readonly alertEmails: readonly string[];
  readonly composeReport: (input: MonthlyGtmReportInput) => {
    readonly subject: string;
    readonly text: string;
  };
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

export interface GrowthRunResult {
  readonly rows: number;
  readonly deleted: number;
  readonly reportSentTo: number;
}

/** One full recompute; on the 1st also the previous month's report (once). */
export async function runGrowthRollup(deps: GrowthRunDeps): Promise<GrowthRunResult> {
  const now = (deps.now ?? (() => new Date()))();
  const since = monthsBack(now, GROWTH_MONTHS_KEPT - 1);
  // A cohort's sign-up week can start before `since`'s month: read its actors from that Monday.
  const actorsSince = new Date(Date.parse(`${weekStart(since)}T00:00:00Z`));
  const [orgs, actors, subscriptions, approvals, setting] = await Promise.all([
    deps.store.organizations(since),
    deps.store.actorWeeks(actorsSince),
    deps.store.subscriptions(),
    deps.store.approvals(since),
    deps.store.billingModeSetting(),
  ]);
  const [actorMonths, companiesTotal, aiTasks, aiCosts] = await Promise.all([
    deps.store.actorMonths(since),
    deps.store.companiesTotal(),
    deps.store.aiTaskDays(actorsSince),
    deps.store.aiCostDays(actorsSince),
  ]);
  const actorPeriods: Record<GrowthPeriodKind, readonly ActorPeriod[]> = {
    week: actors.map((a) => ({ key: a.key, actorHash: a.actorHash, periodStart: a.weekStart })),
    month: actorMonths,
  };
  const mode = parseBillingModeName(setting ?? (deps.env ?? process.env)['BILLING_MODE']);
  const rows: RollupRow[] = [];
  for (const kind of ['week', 'month'] as const) {
    rows.push(
      ...organizationRollups(kind, orgs),
      ...approvalRollups(kind, approvals),
      ...activeCompanyRollups(kind, actorPeriods[kind], orgs, companiesTotal),
      ...firstProjectFinishedRollups(kind, orgs, now),
      ...aiRollups(kind, aiTasks, aiCosts),
    );
  }
  rows.push(...retentionRollups(orgs, actors, now), ...mrrRollups(subscriptions, mode, now));
  const written = await deps.store.upsert(rows, now);
  const deleted = await deps.store.deleteBefore(weekStart(since));

  let reportSentTo = 0;
  const previous = iso(monthsBack(now, 1));
  if (
    now.getUTCDate() === 1 &&
    deps.mailer !== null &&
    deps.alertEmails.length > 0 &&
    !(await deps.store.reportSent(previous))
  ) {
    const monthRows = rows.filter((r) => r.periodKind === 'month' && r.periodStart === previous);
    // MRR is a snapshot: the run on the 1st carries the month just closed as its latest figure.
    const snapshot = mrrRollups(subscriptions, mode, new Date(Date.parse(`${previous}T00:00:00Z`)));
    const body = deps.composeReport(reportInput([...monthRows, ...snapshot], previous, mode, now));
    for (const to of deps.alertEmails) {
      await deps.mailer.send({ to, ...body, templateKey: 'monthly_gtm_report' });
      reportSentTo += 1;
    }
    await deps.store.upsert(
      [
        {
          periodKind: 'month',
          periodStart: previous,
          metric: REPORT_SENT_METRIC,
          dimension: '',
          value: 1,
          sampleCount: reportSentTo,
        },
      ],
      now,
    );
  }
  return { rows: written, deleted, reportSentTo };
}
