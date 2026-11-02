import {
  addWorkingDays,
  dayNumberOf,
  isIsoDate,
  isWorkingDay,
  isoDateOfDayNumber,
  weekdayOf,
  WORKING_CALENDAR_HORIZON_DAYS,
} from '../calendar/working-calendar.js';
import type { WorkingCalendar } from '../calendar/working-calendar.js';

/**
 * 53-09 — recurring work v2: an allowlisted subset of RFC 5545 RRULE, pure.
 *
 * - **Subset.** `FREQ` DAILY | WEEKLY | MONTHLY | YEARLY, `INTERVAL` 1..52, `BYDAY` (≤ 7 weekdays,
 *   an nth weekday as `1MO` or `BYDAY=MO;BYSETPOS=1`, setpos 1..4 or -1, MONTHLY only),
 *   `BYMONTHDAY` 1..31 or -1 (MONTHLY only), `COUNT` ≤ 365, `UNTIL` (a date). Any other part —
 *   `BYSECOND`, `BYHOUR`, `WKST`, an unknown name — is a {@link RecurrenceValidationError}.
 * - **Civil dates.** Occurrences are ISO `YYYY-MM-DD` days on the company's wall calendar, anchored
 *   on {@link RecurrenceRule.start}. Weeks start on Sunday (the MENA week).
 * - **Month clamp.** "Monthly on day 31" lands on the month's last day (Feb 28/29), not a skip.
 * - **Keys.** An occurrence's key is its *scheduled* date, before the holiday policy moves it, so a
 *   holiday added later never makes the same occurrence spawn twice.
 * - **Bounded.** Every walk stops within {@link WORKING_CALENDAR_HORIZON_DAYS} of its lower bound.
 */

export const RECURRENCE_FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number];
export const RECURRENCE_HOLIDAY_POLICIES = ['keep', 'skip', 'next_working_day'] as const;
export type RecurrenceHolidayPolicy = (typeof RECURRENCE_HOLIDAY_POLICIES)[number];
export const RECURRENCE_SPAWN_MODES = ['on_schedule', 'after_done'] as const;
export type RecurrenceSpawnMode = (typeof RECURRENCE_SPAWN_MODES)[number];
export const RECURRENCE_STATUSES = ['active', 'paused', 'ended'] as const;
export type RecurrenceStatus = (typeof RECURRENCE_STATUSES)[number];

export const RECURRENCE_MAX_INTERVAL = 52;
export const RECURRENCE_MAX_COUNT = 365;
export const RECURRENCE_MAX_SPAWN_AHEAD_DAYS = 30;
/** Weekday tokens, index = weekday number (0 = Sunday). */
export const RECURRENCE_WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const SETPOS_ALLOWED: ReadonlySet<number> = new Set([1, 2, 3, 4, -1]);

export interface RecurrenceRule {
  readonly freq: RecurrenceFreq;
  readonly interval: number;
  /** Weekday numbers (0 = Sunday), ascending, unique. Empty = the start's own cadence. */
  readonly byWeekday: readonly number[];
  /** 1..31 or -1 (last day). MONTHLY only. */
  readonly byMonthDay: number | null;
  /** The nth matching weekday of the month (1..4, -1). MONTHLY with `byWeekday` only. */
  readonly bySetPos: number | null;
  readonly count: number | null;
  /** Inclusive last scheduled date. */
  readonly until: string | null;
  /** The anchor (DTSTART) — ISO date. */
  readonly start: string;
}

/** The structured input (the UI sends fields; the RRULE string is the alternative). */
export interface RecurrenceFields {
  readonly freq?: unknown;
  readonly interval?: unknown;
  readonly byWeekday?: unknown;
  readonly byMonthDay?: unknown;
  readonly bySetPos?: unknown;
  readonly count?: unknown;
  readonly until?: unknown;
}

export class RecurrenceValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'RecurrenceValidationError';
  }
}

export interface Occurrence {
  /** The scheduled date — the idempotency key. */
  readonly key: string;
  /** The date after the holiday policy (equal to `key` unless moved). */
  readonly date: string;
}

function fail(field: string, message: string): never {
  throw new RecurrenceValidationError(field, message);
}

function weekdayToken(raw: string, field: string): { day: number; nth: number | null } {
  const match = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(raw.trim().toUpperCase());
  if (match === null) fail(field, `unknown weekday: ${raw.slice(0, 8)}`);
  const day = RECURRENCE_WEEKDAYS.indexOf(match[2] as (typeof RECURRENCE_WEEKDAYS)[number]);
  return { day, nth: match[1] === undefined ? null : Number(match[1]) };
}

function intIn(raw: unknown, field: string, min: number, max: number): number {
  const value = typeof raw === 'string' && /^[+-]?\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(field, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

function untilDate(raw: unknown): string {
  if (typeof raw !== 'string') fail('until', 'must be a date');
  const compact = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(raw);
  const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : raw.slice(0, 10);
  if (!isIsoDate(iso)) fail('until', 'must be a date');
  return iso;
}

/** RRULE text → field record. Unknown or forbidden parts are refused here. */
function fieldsOfRRule(text: string): RecurrenceFields {
  const body = text.trim().replace(/^RRULE:/i, '');
  if (body.length === 0 || body.length > 512) fail('rrule', 'must be 1..512 characters');
  const out: Record<string, unknown> = {};
  for (const part of body.split(';')) {
    const [name, value, extra] = part.split('=');
    if (name === undefined || value === undefined || extra !== undefined || value === '') {
      fail('rrule', 'malformed part');
    }
    const key = name.trim().toUpperCase();
    const map: Record<string, string> = {
      FREQ: 'freq',
      INTERVAL: 'interval',
      BYDAY: 'byWeekday',
      BYMONTHDAY: 'byMonthDay',
      BYSETPOS: 'bySetPos',
      COUNT: 'count',
      UNTIL: 'until',
    };
    const field = map[key];
    if (field === undefined) fail('rrule', `${key.slice(0, 12)} is not supported`);
    if (field in out) fail('rrule', `${key} appears twice`);
    out[field] = field === 'byWeekday' ? value.split(',') : value;
  }
  return out;
}

/**
 * Validate an RRULE string or a field record into a {@link RecurrenceRule} anchored on `start`.
 * Throws {@link RecurrenceValidationError} (field + message) on anything outside the subset.
 */
export function parseRecurrence(input: string | RecurrenceFields, start: string): RecurrenceRule {
  if (!isIsoDate(start)) fail('startsOn', 'must be a date');
  const fields = typeof input === 'string' ? fieldsOfRRule(input) : input;
  const freqRaw = typeof fields.freq === 'string' ? fields.freq.toUpperCase() : fields.freq;
  if (!(RECURRENCE_FREQS as readonly unknown[]).includes(freqRaw)) {
    fail('freq', `must be one of ${RECURRENCE_FREQS.join(', ')}`);
  }
  const freq = freqRaw as RecurrenceFreq;
  const interval =
    fields.interval === undefined || fields.interval === null
      ? 1
      : intIn(fields.interval, 'interval', 1, RECURRENCE_MAX_INTERVAL);

  let byWeekday: number[] = [];
  let bySetPos: number | null = null;
  if (fields.byWeekday !== undefined && fields.byWeekday !== null) {
    if (!Array.isArray(fields.byWeekday) || fields.byWeekday.length > 7) {
      fail('byWeekday', 'must be a list of at most 7 weekdays');
    }
    const tokens = (fields.byWeekday as unknown[]).map((raw) => {
      if (typeof raw !== 'string') fail('byWeekday', 'must be weekday tokens');
      return weekdayToken(raw, 'byWeekday');
    });
    const nths = tokens.filter((t) => t.nth !== null);
    if (nths.length > 0) {
      if (tokens.length !== 1) fail('byWeekday', 'an nth weekday stands alone');
      bySetPos = nths[0]!.nth;
    }
    byWeekday = [...new Set(tokens.map((t) => t.day))].sort((a, b) => a - b);
  }
  if (fields.bySetPos !== undefined && fields.bySetPos !== null) {
    if (bySetPos !== null) fail('bySetPos', 'given twice');
    bySetPos = intIn(fields.bySetPos, 'bySetPos', -1, 4);
  }
  if (bySetPos !== null) {
    if (!SETPOS_ALLOWED.has(bySetPos)) fail('bySetPos', 'must be 1..4 or -1');
    if (freq !== 'MONTHLY' || byWeekday.length === 0) {
      fail('bySetPos', 'needs a monthly rule with weekdays');
    }
  }
  if (byWeekday.length > 0 && freq !== 'WEEKLY' && freq !== 'MONTHLY') {
    fail('byWeekday', 'only weekly or monthly rules take weekdays');
  }

  let byMonthDay: number | null = null;
  if (fields.byMonthDay !== undefined && fields.byMonthDay !== null) {
    byMonthDay = intIn(fields.byMonthDay, 'byMonthDay', -1, 31);
    if (byMonthDay === 0) fail('byMonthDay', 'must be 1..31 or -1');
    if (freq !== 'MONTHLY' || byWeekday.length > 0) {
      fail('byMonthDay', 'only a monthly rule without weekdays takes a month day');
    }
  }

  const count =
    fields.count === undefined || fields.count === null
      ? null
      : intIn(fields.count, 'count', 1, RECURRENCE_MAX_COUNT);
  const until =
    fields.until === undefined || fields.until === null ? null : untilDate(fields.until);
  if (until !== null && count !== null) fail('until', 'COUNT and UNTIL are exclusive');
  if (until !== null && until < start) fail('until', 'must not be before the start');

  return { freq, interval, byWeekday, byMonthDay, bySetPos, count, until, start };
}

/** The RFC 5545 RRULE value (no `RRULE:` prefix, no DTSTART). */
export function toRRule(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byWeekday.length > 0) {
    parts.push(`BYDAY=${rule.byWeekday.map((d) => RECURRENCE_WEEKDAYS[d]).join(',')}`);
  }
  if (rule.bySetPos !== null) parts.push(`BYSETPOS=${rule.bySetPos}`);
  if (rule.byMonthDay !== null) parts.push(`BYMONTHDAY=${rule.byMonthDay}`);
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== null) parts.push(`UNTIL=${rule.until.replace(/-/g, '')}`);
  return parts.join(';');
}

/** The idempotency key of a scheduled date (the local date itself). */
export function occurrenceKey(date: string): string {
  if (!isIsoDate(date)) throw new RecurrenceValidationError('occurrenceKey', 'must be a date');
  return date;
}

function ymd(day: number): { y: number; m: number; d: number } {
  const iso = isoDateOfDayNumber(day);
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) - 1, d: Number(iso.slice(8)) };
}

function dayOf(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m, d) / 86_400_000);
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** The scheduled day numbers of period `k` (ascending). */
function periodDays(rule: RecurrenceRule, s: number, k: number): number[] {
  const start = ymd(s);
  switch (rule.freq) {
    case 'DAILY':
      return [s + k * rule.interval];
    case 'WEEKLY': {
      const weekStart = s - ((((s + 4) % 7) + 7) % 7) + 7 * rule.interval * k;
      const days = rule.byWeekday.length > 0 ? rule.byWeekday : [weekdayOf(isoDateOfDayNumber(s))];
      return days.map((w) => weekStart + w);
    }
    case 'MONTHLY': {
      const total = start.m + k * rule.interval;
      const y = start.y + Math.floor(total / 12);
      const m = ((total % 12) + 12) % 12;
      const last = lastDayOfMonth(y, m);
      if (rule.byWeekday.length > 0) {
        const matching: number[] = [];
        for (let d = 1; d <= last; d += 1) {
          const day = dayOf(y, m, d);
          if (rule.byWeekday.includes((((day + 4) % 7) + 7) % 7)) matching.push(day);
        }
        if (rule.bySetPos === null) return matching;
        const pick = matching[rule.bySetPos === -1 ? matching.length - 1 : rule.bySetPos - 1];
        return pick === undefined ? [] : [pick];
      }
      const want = rule.byMonthDay === -1 ? last : (rule.byMonthDay ?? start.d);
      return [dayOf(y, m, Math.min(want, last))];
    }
    case 'YEARLY': {
      const y = start.y + k * rule.interval;
      return [dayOf(y, start.m, Math.min(start.d, lastDayOfMonth(y, start.m)))];
    }
  }
}

/** Periods spanned per step, to skip ahead safely for a rule without COUNT. */
function firstPeriod(rule: RecurrenceRule, s: number, after: number): number {
  if (rule.count !== null || after <= s) return 0;
  const days = after - s;
  const perPeriod =
    rule.freq === 'DAILY'
      ? rule.interval
      : rule.freq === 'WEEKLY'
        ? 7 * rule.interval
        : rule.freq === 'MONTHLY'
          ? 31 * rule.interval
          : 366 * rule.interval;
  return Math.max(0, Math.floor(days / perPeriod) - 1);
}

/**
 * Up to `count` occurrences whose (holiday-adjusted) date is strictly after `afterDate`, in order.
 * `keep` leaves a day off as is, `skip` drops it, `next_working_day` moves it to the next working
 * day of `calendar` (two moved onto one day collapse into one). COUNT is spent from the start,
 * including skipped occurrences; UNTIL bounds the scheduled date.
 */
export function occurrencesOf(
  rule: RecurrenceRule,
  afterDate: string,
  count: number,
  calendar: WorkingCalendar,
  holidayPolicy: RecurrenceHolidayPolicy,
): readonly Occurrence[] {
  const s = dayNumberOf(rule.start);
  const after = dayNumberOf(afterDate);
  const until = rule.until === null ? null : dayNumberOf(rule.until);
  const horizon = Math.max(after, s) + WORKING_CALENDAR_HORIZON_DAYS;
  const out: Occurrence[] = [];
  let produced = 0;
  for (let k = firstPeriod(rule, s, after); out.length < count; k += 1) {
    const days = periodDays(rule, s, k);
    const periodStart = days[0];
    if (periodStart !== undefined && periodStart > horizon) break;
    if (until !== null && periodStart !== undefined && periodStart > until) break;
    for (const day of days) {
      if (day < s) continue;
      if (until !== null && day > until) return out;
      if (rule.count !== null && produced >= rule.count) return out;
      produced += 1;
      const key = isoDateOfDayNumber(day);
      let date: string | null = key;
      if (holidayPolicy !== 'keep' && !isWorkingDay(key, calendar)) {
        date = holidayPolicy === 'skip' ? null : addWorkingDays(key, 1, calendar);
      }
      if (date === null || dayNumberOf(date) <= after) continue;
      if (out.length > 0 && out[out.length - 1]!.date === date) continue;
      out.push({ key, date });
      if (out.length >= count) return out;
    }
    if (days.length === 0 && k > WORKING_CALENDAR_HORIZON_DAYS) break;
  }
  return out;
}
