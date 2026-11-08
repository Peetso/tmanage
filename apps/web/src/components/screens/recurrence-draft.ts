import type { RecurrenceRuleInput, WorkItemRecurrence } from '../../lib/api/work-item-recurrence';

/**
 * r46 · 53-09 — the repeat editor's form state and its translation to the v2 rule body. Pure, so
 * the rules the editor enforces (a weekly rule needs a day, "after N times" needs 1..365, …) are
 * unit-tested without rendering.
 */

export const WEEKDAY_TOKENS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type WeekdayToken = (typeof WEEKDAY_TOKENS)[number];
export type EndMode = 'never' | 'count' | 'date';
export type MonthlyMode = 'day' | 'nth';
export type HolidayPolicy = 'keep' | 'skip' | 'next_working_day';

export interface RecurrenceDraft {
  readonly freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  readonly interval: string;
  readonly weekdays: readonly WeekdayToken[];
  readonly monthlyMode: MonthlyMode;
  readonly monthDay: string;
  /** 1..4 or -1 (last). */
  readonly nthPos: number;
  readonly nthDay: WeekdayToken;
  readonly endMode: EndMode;
  readonly count: string;
  readonly endsOn: string;
  readonly holidayPolicy: HolidayPolicy;
  readonly spawnAheadDays: string;
  readonly scope: 'all' | 'this_and_future';
}

function intIn(raw: string, min: number, max: number): number | null {
  if (!/^-?\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

function isWeekday(token: string): token is WeekdayToken {
  return (WEEKDAY_TOKENS as readonly string[]).includes(token);
}

/** The editor seeded from a saved rule, or the defaults for `today` (ISO date). */
export function draftOf(rule: WorkItemRecurrence | null, today: string): RecurrenceDraft {
  const weekday = WEEKDAY_TOKENS[new Date(`${today}T00:00:00Z`).getUTCDay()] ?? 'SU';
  const base: RecurrenceDraft = {
    freq: 'WEEKLY',
    interval: '1',
    weekdays: [weekday],
    monthlyMode: 'day',
    monthDay: String(Number(today.slice(8, 10)) || 1),
    nthPos: 1,
    nthDay: weekday,
    endMode: 'never',
    count: '10',
    endsOn: '',
    holidayPolicy: 'next_working_day',
    spawnAheadDays: '1',
    scope: 'this_and_future',
  };
  if (rule === null) return base;
  const freq = rule.freq.toUpperCase();
  const tokens = rule.byWeekday.filter(isWeekday);
  const policy = rule.holidayPolicy;
  return {
    ...base,
    freq: freq === 'DAILY' || freq === 'MONTHLY' ? freq : 'WEEKLY',
    interval: String(rule.interval),
    weekdays: freq === 'WEEKLY' && tokens.length > 0 ? tokens : base.weekdays,
    monthlyMode: rule.bySetPos !== null ? 'nth' : 'day',
    monthDay: rule.byMonthDay !== null ? String(rule.byMonthDay) : base.monthDay,
    nthPos: rule.bySetPos ?? 1,
    nthDay: rule.bySetPos !== null && tokens[0] ? tokens[0] : base.nthDay,
    endMode: rule.countLimit !== null ? 'count' : rule.until ? 'date' : 'never',
    count: rule.countLimit !== null ? String(rule.countLimit) : base.count,
    endsOn: rule.until ? rule.until.slice(0, 10) : '',
    holidayPolicy:
      policy === 'keep' || policy === 'skip' || policy === 'next_working_day'
        ? policy
        : 'next_working_day',
    spawnAheadDays: String(rule.spawnAheadDays),
  };
}

export type DraftErrors = Partial<Record<keyof RecurrenceDraft, true>>;

/** The draft's problems, by field (empty = valid). */
export function draftErrors(draft: RecurrenceDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (intIn(draft.interval, 1, 52) === null) errors.interval = true;
  if (draft.freq === 'WEEKLY' && draft.weekdays.length === 0) errors.weekdays = true;
  if (
    draft.freq === 'MONTHLY' &&
    draft.monthlyMode === 'day' &&
    intIn(draft.monthDay, 1, 31) === null
  ) {
    errors.monthDay = true;
  }
  if (draft.endMode === 'count' && intIn(draft.count, 1, 365) === null) errors.count = true;
  if (draft.endMode === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(draft.endsOn)) errors.endsOn = true;
  if (intIn(draft.spawnAheadDays, 0, 30) === null) errors.spawnAheadDays = true;
  return errors;
}

/** The v2 body for a valid draft, else null. `editing` adds the edit scope. */
export function inputOf(draft: RecurrenceDraft, editing: boolean): RecurrenceRuleInput | null {
  if (Object.keys(draftErrors(draft)).length > 0) return null;
  const monthly = draft.freq === 'MONTHLY';
  const nth = monthly && draft.monthlyMode === 'nth';
  return {
    freq: draft.freq,
    interval: Number(draft.interval),
    byWeekday:
      draft.freq === 'WEEKLY'
        ? WEEKDAY_TOKENS.filter((t) => draft.weekdays.includes(t))
        : nth
          ? [draft.nthDay]
          : [],
    byMonthDay: monthly && !nth ? Number(draft.monthDay) : null,
    bySetPos: nth ? draft.nthPos : null,
    countLimit: draft.endMode === 'count' ? Number(draft.count) : null,
    endsOn: draft.endMode === 'date' ? draft.endsOn : null,
    holidayPolicy: draft.holidayPolicy,
    spawnAheadDays: Number(draft.spawnAheadDays),
    ...(editing ? { scope: draft.scope } : {}),
  };
}
