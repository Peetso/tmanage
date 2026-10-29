import type { ApiClient } from './client';

/**
 * 55-21 — the Platform admin "Ease scoreboard" (Figma 444:21040 EN / 444:21528 AR) over
 * `GET /v1/platform/ease-scoreboard?weeks=N` (`apps/api/src/modules/product-events`). The API
 * answers aggregates only — weekly counts by event, locale and audience, and timer buckets, with
 * groups under the k-anonymity floor withheld — so every figure on the screen is derived here,
 * from those rows, by pure functions a unit can pin.
 */

export interface ScoreboardCountRowView {
  readonly week: string;
  readonly eventName: string;
  readonly locale: string | null;
  readonly principalKind: string;
  readonly events: number;
  readonly actors: number;
  readonly organizations: number;
}

export interface ScoreboardTimerRowView {
  readonly week: string;
  readonly eventName: string;
  readonly locale: string | null;
  readonly bucket: string;
  readonly events: number;
}

export interface EaseScoreboardView {
  readonly since: string;
  readonly weeks: number;
  readonly kAnonymityFloor: number;
  readonly counts: readonly ScoreboardCountRowView[];
  readonly timers: readonly ScoreboardTimerRowView[];
}

export function fetchEaseScoreboard(client: ApiClient, weeks = 8): Promise<EaseScoreboardView> {
  return client
    .request<EaseScoreboardView>({
      method: 'GET',
      path: `/v1/platform/ease-scoreboard?weeks=${String(weeks)}`,
    })
    .then(({ data }) => data);
}

/** The server's time buckets, fastest first (`product-events.registry.ts` TIME_BUCKETS). */
export const TIME_BUCKETS = [
  'lt_10s',
  '10_30s',
  '30_60s',
  '1_3m',
  '3_10m',
  '10_30m',
  '30_60m',
  '1_24h',
  'gt_24h',
] as const;
export type TimeBucket = (typeof TIME_BUCKETS)[number];

export type LanguageFilter = 'all' | 'en' | 'ar';
export type Standing = 'on' | 'close' | 'off';

function languageOf(locale: string | null): 'en' | 'ar' | null {
  const base = locale?.split('-')[0]?.toLowerCase();
  return base === 'en' || base === 'ar' ? base : null;
}

function inLanguage(locale: string | null, filter: LanguageFilter): boolean {
  return filter === 'all' || languageOf(locale) === filter;
}

/** The weeks present in the data, oldest first (`2026-W43` sorts as text). */
export function weeksOf(view: EaseScoreboardView): string[] {
  const all = new Set<string>();
  for (const row of view.counts) all.add(row.week);
  for (const row of view.timers) all.add(row.week);
  return [...all].sort();
}

/** Sum of `field` for one event, over `weeks` (all weeks when null), in one language. */
export function countOf(
  view: EaseScoreboardView,
  eventName: string,
  weeks: readonly string[] | null,
  filter: LanguageFilter,
  field: 'events' | 'actors' = 'events',
): number {
  let total = 0;
  for (const row of view.counts) {
    if (row.eventName !== eventName || !inLanguage(row.locale, filter)) continue;
    if (weeks && !weeks.includes(row.week)) continue;
    total += row[field];
  }
  return total;
}

function bucketCounts(
  view: EaseScoreboardView,
  eventName: string,
  week: string,
  filter: LanguageFilter,
): number[] {
  const counts = TIME_BUCKETS.map(() => 0);
  for (const row of view.timers) {
    if (row.eventName !== eventName || row.week !== week || !inLanguage(row.locale, filter)) {
      continue;
    }
    const index = TIME_BUCKETS.indexOf(row.bucket as TimeBucket);
    if (index >= 0) counts[index] = (counts[index] ?? 0) + row.events;
  }
  return counts;
}

/** The bucket holding the median event, or null when the week has no timed events. */
export function medianBucket(
  view: EaseScoreboardView,
  eventName: string,
  week: string,
  filter: LanguageFilter,
): TimeBucket | null {
  const counts = bucketCounts(view, eventName, week, filter);
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total === 0) return null;
  let running = 0;
  for (const [index, value] of counts.entries()) {
    running += value;
    if (running * 2 >= total) return TIME_BUCKETS[index] ?? null;
  }
  return null;
}

/** The timed tasks the events can measure (55 §T-list), each with its target bucket. */
export const TIMED_TASKS = [
  { id: 'T1', eventName: 'first_project_created_v1', target: '1_3m' },
  { id: 'T8', eventName: 'portal_action_found_v1', target: '10_30s' },
  { id: 'setup', eventName: 'onboarding_step_completed_v1', target: '30_60s' },
] as const satisfies readonly { id: string; eventName: string; target: TimeBucket }[];

function percent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

export interface WeekMeasures {
  /** T1 — median time to first project. */
  readonly timeToFirstProject: TimeBucket | null;
  /** T3 proxy — new workspaces that created a first project, of those that finished set-up. */
  readonly activation: number | null;
  /** T5 proxy — timed tasks finished within their target bucket. */
  readonly taskSuccess: number | null;
  /** T12 — help article views not followed by a support conversation. */
  readonly helpDeflection: number | null;
}

export function measuresFor(
  view: EaseScoreboardView,
  week: string,
  filter: LanguageFilter,
): WeekMeasures {
  const only = [week];
  let timed = 0;
  let withinTarget = 0;
  for (const task of TIMED_TASKS) {
    const counts = bucketCounts(view, task.eventName, week, filter);
    const target = TIME_BUCKETS.indexOf(task.target);
    for (const [index, value] of counts.entries()) {
      timed += value;
      if (index <= target) withinTarget += value;
    }
  }
  const views = countOf(view, 'help_article_viewed_v1', only, filter);
  const tickets = countOf(view, 'support_conversation_opened_v1', only, filter);
  return {
    timeToFirstProject: medianBucket(view, 'first_project_created_v1', week, filter),
    activation: percent(
      countOf(view, 'first_project_created_v1', only, filter),
      countOf(view, 'onboarding_completed_v1', only, filter),
    ),
    taskSuccess: percent(withinTarget, timed),
    helpDeflection: views > 0 ? percent(Math.max(0, views - tickets), views) : null,
  };
}

/** The 55 targets: T3 ≥ 40 %, T5 ≥ 90 %, T12 ≥ 50 %. */
export const PERCENT_TARGETS = { activation: 40, taskSuccess: 90, helpDeflection: 50 } as const;

/** On target at or above it, close within 10 points, off target below that. */
export function percentStanding(value: number | null, target: number): Standing | null {
  if (value === null) return null;
  if (value >= target) return 'on';
  return value >= target - 10 ? 'close' : 'off';
}

/** On target within the target bucket, close one bucket slower, off target beyond. */
export function bucketStanding(value: TimeBucket | null, target: TimeBucket): Standing | null {
  if (value === null) return null;
  const gap = TIME_BUCKETS.indexOf(value) - TIME_BUCKETS.indexOf(target);
  if (gap <= 0) return 'on';
  return gap === 1 ? 'close' : 'off';
}

/** The funnels behind the card's tabs: each step is an event, counted in distinct people. */
export const FUNNELS = {
  signup: [
    'onboarding_step_completed_v1',
    'onboarding_completed_v1',
    'first_project_created_v1',
    'checklist_item_completed_v1',
  ],
  portal: ['magic_link_consumed_v1', 'portal_action_found_v1', 'approval_decided_v1'],
  firstWeek: [
    'tour_step_viewed_v1',
    'quick_add_parsed_v1',
    'palette_used_v1',
    'empty_state_action_v1',
  ],
} as const;
export type FunnelId = keyof typeof FUNNELS;

export interface FunnelStep {
  readonly eventName: string;
  readonly now: number;
  readonly nowPercent: number;
  readonly baselinePercent: number;
}

/** Steps over `nowWeeks` against the baseline week, each as a share of the funnel's first step. */
export function funnelSteps(
  view: EaseScoreboardView,
  funnel: FunnelId,
  nowWeeks: readonly string[],
  baselineWeek: string | null,
  filter: LanguageFilter,
): FunnelStep[] {
  const steps = FUNNELS[funnel];
  const first = steps[0];
  const nowFirst = countOf(view, first, nowWeeks, filter, 'actors');
  const baseWeeks = baselineWeek ? [baselineWeek] : [];
  const baseFirst = countOf(view, first, baseWeeks, filter, 'actors');
  return steps.map((eventName) => {
    const now = countOf(view, eventName, nowWeeks, filter, 'actors');
    const base = countOf(view, eventName, baseWeeks, filter, 'actors');
    return {
      eventName,
      now,
      nowPercent: percent(now, nowFirst) ?? 0,
      baselinePercent: percent(base, baseFirst) ?? 0,
    };
  });
}

/** Monday and Sunday (UTC, ISO dates) of an ISO week like `2026-W43`. */
export function isoWeekRange(week: string): { start: string; end: string; number: number } | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return null;
  const year = Number(match[1]);
  const number = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (number - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: monday.toISOString(), end: sunday.toISOString(), number };
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The scoreboard's rows as CSV: the counts, then the timer buckets. Aggregates only. */
export function scoreboardCsv(view: EaseScoreboardView): string {
  const lines = [
    ['kind', 'week', 'event', 'locale', 'audience', 'bucket', 'events', 'people', 'workspaces'],
  ].map((row) => row.join(','));
  for (const row of view.counts) {
    lines.push(
      ['count', row.week, row.eventName, row.locale, row.principalKind, '', row.events]
        .concat([row.actors, row.organizations])
        .map(csvCell)
        .join(','),
    );
  }
  for (const row of view.timers) {
    lines.push(
      ['timer', row.week, row.eventName, row.locale, '', row.bucket, row.events, '', '']
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
