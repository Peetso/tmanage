import type { ProjectPortfolioSummary } from './api/project-portfolio';

/**
 * Portfolio presentation (POR-01 / POR-02) — pure arithmetic on what `GET …/projects/portfolio`
 * returns, so every sentence on screen is a fact the reader can check on the project. No score, no
 * RAG model: a row is red when a date has slipped or a promise was missed, amber when a date has no
 * float or a client has been waiting, and plain otherwise.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Work that has not moved for this long is surfaced as an exception. */
const STALE_AFTER_DAYS = 14;
/** A commitment this close, with the forecast on it, has no float. */
const NO_FLOAT_WITHIN_DAYS = 14;
/** An approval waiting this long on the client is an exception. */
const CLIENT_WAIT_WARN_HOURS = 48;

export const NUMBER_WORDS = [
  'No',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
];

export type RowTone = 'danger' | 'warning' | 'neutral';

export interface PortfolioRow {
  readonly project: ProjectPortfolioSummary;
  readonly tone: RowTone;
  readonly why: string;
  readonly archived: boolean;
  /** Hours the oldest pending approval has waited, or `null`. */
  readonly waitHours: number | null;
  /** True when the forecast is later than the commitment. */
  readonly slipped: boolean;
}

/** `'YYYY-MM-DD'` → UTC midnight in ms. */
function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function todayMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** `'2026-08-26'` → `'26 Aug'` (calendar date, never shifted by the reader's zone). */
export function formatDay(day: string): string {
  const ms = dayMs(day);
  return Number.isNaN(ms) ? day : SHORT.format(ms);
}

/** Waiting time as the frame writes it: hours under two days, then days. */
export function formatWait(hours: number): string {
  return hours < 48 ? `${Math.max(1, Math.floor(hours))}h` : `${Math.floor(hours / 24)}d`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function relativeAgo(instant: string, now: number): string {
  const days = Math.floor((now - Date.parse(instant)) / DAY_MS);
  if (days < 1) return 'today';
  if (days < 31) return `${plural(days, 'day')} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${plural(months, 'month')} ago`;
  return `${plural(Math.floor(months / 12), 'year')} ago`;
}

/** Tone and reason for one project. */
export function describeRow(project: ProjectPortfolioSummary, now: number): PortfolioRow {
  const archived = project.status !== 'active';
  const waitHours = project.clientWaitSince
    ? Math.max(0, (now - Date.parse(project.clientWaitSince)) / HOUR_MS)
    : null;
  const committed = project.committedOn ?? null;
  const forecast = project.forecastOn ?? null;
  const slipped = committed !== null && forecast !== null && forecast > committed;
  const base = { project, archived, waitHours, slipped };

  if (archived) {
    return {
      ...base,
      tone: 'neutral',
      why: project.archivedAt ? `Archived ${relativeAgo(project.archivedAt, now)}` : 'Archived',
    };
  }

  const today = todayMs(now);
  if (slipped) {
    const days = Math.round((dayMs(forecast) - dayMs(committed)) / DAY_MS);
    return {
      ...base,
      tone: 'danger',
      why: `Forecast is ${plural(days, 'day')} past the commitment`,
    };
  }
  const { missed } = project.objectiveCounts;
  if (missed > 0) {
    return {
      ...base,
      tone: 'danger',
      why: `${plural(missed, 'objective')} missed — needs a decision`,
    };
  }
  const missedMilestone = project.milestones?.find((m) => m.status === 'missed');
  if (missedMilestone) {
    return { ...base, tone: 'danger', why: `Milestone “${missedMilestone.title}” was missed` };
  }
  if (committed !== null && dayMs(committed) < today) {
    return { ...base, tone: 'danger', why: `The ${formatDay(committed)} commitment has passed` };
  }
  if (waitHours !== null && waitHours >= CLIENT_WAIT_WARN_HOURS) {
    return {
      ...base,
      tone: 'warning',
      why: `An approval has waited ${formatWait(waitHours)} on the client`,
    };
  }
  if (
    committed !== null &&
    forecast === committed &&
    (dayMs(committed) - today) / DAY_MS <= NO_FLOAT_WITHIN_DAYS
  ) {
    return { ...base, tone: 'warning', why: 'No float left before the committed date moves' };
  }
  const idleDays =
    project.latestActivityAt === null
      ? null
      : Math.floor((now - Date.parse(project.latestActivityAt)) / DAY_MS);
  if (project.openWorkCount > 0 && idleDays !== null && idleDays >= STALE_AFTER_DAYS) {
    return {
      ...base,
      tone: 'warning',
      why: `Open work, but nothing has moved in ${idleDays} days`,
    };
  }
  if (committed === null) {
    return {
      ...base,
      tone: 'neutral',
      why: 'No active milestone — not a risk, but not tracked either',
    };
  }
  const daysAhead = Math.round((dayMs(committed) - today) / DAY_MS);
  const ahead =
    daysAhead === 0
      ? 'today'
      : daysAhead < 14
        ? `in ${plural(daysAhead, 'day')}`
        : `in ${plural(Math.round(daysAhead / 7), 'week')}`;
  return { ...base, tone: 'neutral', why: `Holding · next commitment ${ahead}` };
}

/**
 * Stable partition: red, then amber, then the rest, then archived — each group in the server's
 * order.
 */
export function exceptionFirst(
  projects: readonly ProjectPortfolioSummary[],
  now: number = Date.now(),
): PortfolioRow[] {
  const rank = (row: PortfolioRow) =>
    row.archived ? 3 : row.tone === 'danger' ? 0 : row.tone === 'warning' ? 1 : 2;
  return projects
    .map((project, index) => ({ row: describeRow(project, now), index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row);
}

export function headline(decisions: number): string {
  if (decisions === 0) return 'No project needs a decision';
  const word = NUMBER_WORDS[decisions] ?? String(decisions);
  return decisions === 1 ? `${word} project needs a decision` : `${word} projects need a decision`;
}

// ── POR-02 · timeline ────────────────────────────────────────────────────────────────────────

export type TimelineVariant = 'client' | 'internal' | 'slipped' | 'future';

export interface TimelineRow {
  readonly projectId: string;
  readonly name: string;
  readonly variant: TimelineVariant;
  /** Bar start and end as a percent of the window. */
  readonly left: number;
  readonly width: number;
  /** Where the end chip sits, as a percent of the window. */
  readonly chipAt: number;
  /** The chip's words before the date — `SLIPPED`, a milestone title — or `null` for a bare date. */
  readonly chipLabel: string | null;
  /** The chip's date, `'30 SEP'`. */
  readonly chipDate: string;
  /** Met milestones, as percents of the window. */
  readonly metAt: readonly number[];
}

export interface Timeline {
  /** First day of each month in the window, `'YYYY-MM-DD'`. */
  readonly months: readonly string[];
  readonly range: string;
  readonly rows: readonly TimelineRow[];
  readonly summary: string;
}

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
const MONTH_LONG = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' });
const WINDOW_MONTHS = 4;
const MAX_TIMELINE_ROWS = 8;

function monthStart(ms: number, add = 0): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1);
}

/**
 * The cross-project commitments: one bar per active project that has a commitment, from the day it
 * started to its committed (or, when it slipped, its forecast) date, over a four-month window that
 * opens on last month.
 */
export function buildTimeline(
  projects: readonly ProjectPortfolioSummary[],
  now: number = Date.now(),
): Timeline {
  const from = monthStart(now, -1);
  const to = monthStart(now, WINDOW_MONTHS - 1);
  const span = to - from;
  const months = Array.from({ length: WINDOW_MONTHS }, (_, i) =>
    new Date(monthStart(now, i - 1)).toISOString().slice(0, 10),
  );
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - from) / span) * 100));
  const today = todayMs(now);

  const rows: (TimelineRow & { end: number; clientFacing: boolean })[] = [];
  for (const project of projects) {
    if (project.status !== 'active' || !project.committedOn) continue;
    const committed = dayMs(project.committedOn);
    const forecast = project.forecastOn ? dayMs(project.forecastOn) : null;
    const slipped = forecast !== null && forecast > committed;
    const end = slipped ? forecast : committed;
    const milestones = project.milestones ?? [];
    // The bar starts when the work did: the project's creation day, or an earlier milestone.
    const firstMilestone = milestones.find((m) => m.dueOn !== null)?.dueOn;
    const started = Math.min(
      project.startedOn ? dayMs(project.startedOn) : today,
      firstMilestone ? dayMs(firstMilestone) : Number.POSITIVE_INFINITY,
    );
    const start = Math.min(started, end);
    if (end < from || start >= to) continue;

    const committedMilestone = milestones.find(
      (m) => m.dueOn === project.committedOn && m.status === 'planned',
    );
    const clientFacing = Boolean(project.clientName) || Boolean(committedMilestone?.published);
    const variant: TimelineVariant = slipped
      ? 'slipped'
      : start > today
        ? 'future'
        : clientFacing
          ? 'client'
          : 'internal';
    const endDay = new Date(end).toISOString().slice(0, 10);
    const date = formatDay(endDay).toUpperCase();
    const chipLabel =
      variant === 'slipped'
        ? 'SLIPPED'
        : variant === 'client' && committedMilestone
          ? committedMilestone.title.toUpperCase()
          : null;
    const left = pct(start);
    rows.push({
      projectId: project.projectId,
      name: project.name,
      variant,
      left,
      width: Math.max(pct(end) - left, 1),
      chipAt: pct(end),
      chipLabel,
      chipDate: date,
      metAt: milestones
        .filter((m) => m.status === 'met' && m.dueOn !== null)
        .map((m) => dayMs(m.dueOn as string))
        .filter((ms) => ms >= start && ms <= end)
        .map(pct),
      end,
      clientFacing: clientFacing || slipped,
    });
  }
  rows.sort((a, b) => a.end - b.end);
  const shown = rows.slice(0, MAX_TIMELINE_ROWS);

  return {
    months,
    range: `${MONTH.format(from).toUpperCase()} — ${MONTH.format(monthStart(now, WINDOW_MONTHS - 2)).toUpperCase()} ${new Date(monthStart(now, WINDOW_MONTHS - 2)).getUTCFullYear()}`,
    rows: shown.map(({ end: _end, clientFacing: _clientFacing, ...row }) => row),
    summary: summarise(shown, from, to),
  };
}

function summarise(
  rows: readonly (TimelineRow & { end: number; clientFacing: boolean })[],
  from: number,
  to: number,
): string {
  if (rows.length === 0) return '';
  const byMonth = new Map<number, { dates: number; slips: string[] }>();
  for (const row of rows) {
    if (!row.clientFacing || row.end < from || row.end >= to) continue;
    const key = monthStart(row.end);
    const entry = byMonth.get(key) ?? { dates: 0, slips: [] };
    if (row.variant === 'slipped') entry.slips.push(row.name.split(' ')[0] ?? row.name);
    else entry.dates += 1;
    byMonth.set(key, entry);
  }
  const busiest = [...byMonth].sort(
    (a, b) => b[1].dates + b[1].slips.length - (a[1].dates + a[1].slips.length) || a[0] - b[0],
  )[0];
  if (!busiest || busiest[1].dates + busiest[1].slips.length < 2) {
    return 'No month carries more than one client-facing date — the dates are spread out';
  }
  const [key, { dates, slips }] = busiest;
  const month = MONTH_LONG.format(key);
  const parts: string[] = [];
  if (dates > 0) {
    parts.push(
      `${(NUMBER_WORDS[dates] ?? String(dates)).toLowerCase()} client-facing ${dates === 1 ? 'date' : 'dates'}`,
    );
  }
  if (slips.length === 1) parts.push(`the ${slips[0]} slip`);
  else if (slips.length > 1) parts.push(`${slips.length} slips`);
  return `${month} carries ${parts.join(' and ')} — the portfolio constraint is ${month}, not any one project`;
}
