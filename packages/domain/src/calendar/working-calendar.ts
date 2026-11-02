import { isValidTimeZone } from '../notifications/quiet-hours.js';

/**
 * 53-02 — the working calendar: which civil days a company works, its working hours, and its
 * holidays. Pure date math shared by the API (routes, validation) and the worker (due-soon sweep,
 * weekend hold).
 *
 * - **Civil dates.** A day is an ISO `YYYY-MM-DD` string with no time zone of its own; it means
 *   that day on the company's wall calendar. Instants are turned into civil dates in the
 *   calendar's `timeZone` ({@link localDateOf}).
 * - **Mask.** `workingDaysMask` bit 0 = Sunday … bit 6 = Saturday. Sunday–Thursday (the default,
 *   and the Friday–Saturday weekend the product assumed before 53-02) is `31`.
 * - **Bounded.** Every walk stays within {@link WORKING_CALENDAR_HORIZON_YEARS} years of its start
 *   and throws {@link WorkingCalendarRangeError} beyond, so a calendar with every day a holiday
 *   cannot spin a loop.
 */

export const WORKING_CALENDAR_HORIZON_YEARS = 5;
/** The horizon in days (5 × 366, generous). */
export const WORKING_CALENDAR_HORIZON_DAYS = WORKING_CALENDAR_HORIZON_YEARS * 366;
export const MAX_HOLIDAYS_PER_CALENDAR = 400;
export const MAX_HOLIDAY_LABEL_LENGTH = 80;

/** Sunday–Thursday: bits 0–4. */
export const DEFAULT_WORKING_DAYS_MASK = 0b0011111;
export const DEFAULT_DAY_START = '09:00';
export const DEFAULT_DAY_END = '17:00';
export const ALL_DAYS_MASK = 0b1111111;

export interface WorkingCalendar {
  /** bit 0 = Sunday … bit 6 = Saturday. */
  readonly workingDaysMask: number;
  /** `HH:MM` (or `HH:MM:SS`) wall-clock in {@link WorkingCalendar.timeZone}. */
  readonly dayStart: string;
  readonly dayEnd: string;
  /** An IANA zone; an unknown zone reads as UTC. */
  readonly timeZone: string;
  /** ISO dates that are days off. */
  readonly holidays: ReadonlySet<string>;
}

export class WorkingCalendarRangeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkingCalendarRangeError';
  }
}

/** The default calendar: Sun–Thu, 09:00–17:00, in `timeZone`. */
export function defaultWorkingCalendar(
  timeZone: string,
  holidays: Iterable<string> = [],
): WorkingCalendar {
  return {
    workingDaysMask: DEFAULT_WORKING_DAYS_MASK,
    dayStart: DEFAULT_DAY_START,
    dayEnd: DEFAULT_DAY_END,
    timeZone,
    holidays: new Set(holidays),
  };
}

/** Weekday numbers (0 = Sunday) → mask. */
export function maskOfWeekdays(days: Iterable<number>): number {
  let mask = 0;
  for (const day of days) mask |= 1 << day;
  return mask & ALL_DAYS_MASK;
}

/** Mask → weekday numbers (0 = Sunday), ascending. */
export function weekdaysOfMask(mask: number): readonly number[] {
  const days: number[] = [];
  for (let day = 0; day < 7; day += 1) if ((mask & (1 << day)) !== 0) days.push(day);
  return days;
}

/** At least one working day a week (the abuse guard: a calendar that never works is refused). */
export function hasWorkingDay(mask: number): boolean {
  return Number.isInteger(mask) && mask > 0 && mask <= ALL_DAYS_MASK;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** A real calendar date in strict `YYYY-MM-DD` form. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const [, y, m, d] = match;
  const at = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return at.toISOString().slice(0, 10) === value;
}

/** Days since 1970-01-01 of an ISO date. Throws on a malformed date. */
export function dayNumberOf(date: string): number {
  if (!isIsoDate(date)) throw new WorkingCalendarRangeError(`not an ISO date: ${date}`);
  return Math.round(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY);
}

export function isoDateOfDayNumber(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: string): number {
  // 1970-01-01 was a Thursday (4).
  return (((dayNumberOf(date) + 4) % 7) + 7) % 7;
}

function isWorkingDayNumber(day: number, calendar: WorkingCalendar): boolean {
  const weekday = (((day + 4) % 7) + 7) % 7;
  if ((calendar.workingDaysMask & (1 << weekday)) === 0) return false;
  return !calendar.holidays.has(isoDateOfDayNumber(day));
}

export function isWorkingDay(date: string, calendar: WorkingCalendar): boolean {
  return isWorkingDayNumber(dayNumberOf(date), calendar);
}

/** Whether `date` lies within ±{@link WORKING_CALENDAR_HORIZON_YEARS} years of `anchor`. */
export function isWithinHorizon(date: string, anchor: string): boolean {
  return Math.abs(dayNumberOf(date) - dayNumberOf(anchor)) <= WORKING_CALENDAR_HORIZON_DAYS;
}

function assertSteps(n: number): void {
  if (!Number.isInteger(n) || Math.abs(n) > WORKING_CALENDAR_HORIZON_DAYS) {
    throw new WorkingCalendarRangeError(`working-day count out of range: ${String(n)}`);
  }
}

/**
 * The date `n` working days after `date` (before, when `n` is negative); `n = 0` is `date`
 * itself. The start day is not counted: from a Wednesday in a Sun–Thu company, `+2` is Sunday.
 */
export function addWorkingDays(date: string, n: number, calendar: WorkingCalendar): string {
  assertSteps(n);
  const start = dayNumberOf(date);
  const step = n < 0 ? -1 : 1;
  let day = start;
  let remaining = Math.abs(n);
  while (remaining > 0) {
    day += step;
    if (Math.abs(day - start) > WORKING_CALENDAR_HORIZON_DAYS) {
      throw new WorkingCalendarRangeError('no working day within the horizon');
    }
    if (isWorkingDayNumber(day, calendar)) remaining -= 1;
  }
  return isoDateOfDayNumber(day);
}

/**
 * "Due in `n` working days" counted from `date` inclusive: the `n`-th working day on or after
 * `date`. From a Wednesday in a Sun–Thu company, `n = 3` is Wed, Thu, **Sunday**.
 */
export function nthWorkingDay(date: string, n: number, calendar: WorkingCalendar): string {
  assertSteps(n);
  if (n < 1) throw new WorkingCalendarRangeError('n must be at least 1');
  const start = dayNumberOf(date);
  let day = start - 1;
  let remaining = n;
  while (remaining > 0) {
    day += 1;
    if (day - start > WORKING_CALENDAR_HORIZON_DAYS) {
      throw new WorkingCalendarRangeError('no working day within the horizon');
    }
    if (isWorkingDayNumber(day, calendar)) remaining -= 1;
  }
  return isoDateOfDayNumber(day);
}

/**
 * Working days in the half-open range `[from, to)`; negative when `to` is before `from`.
 */
export function workingDaysBetween(from: string, to: string, calendar: WorkingCalendar): number {
  const a = dayNumberOf(from);
  const b = dayNumberOf(to);
  if (Math.abs(b - a) > WORKING_CALENDAR_HORIZON_DAYS) {
    throw new WorkingCalendarRangeError('range exceeds the horizon');
  }
  const [lo, hi, sign] = a <= b ? [a, b, 1] : [b, a, -1];
  let count = 0;
  for (let day = lo; day < hi; day += 1) if (isWorkingDayNumber(day, calendar)) count += 1;
  return sign * count;
}

/** `'HH:MM'` / `'HH:MM:SS'` → minutes since midnight, or null. */
export function minutesOfClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function zoneOrUtc(timeZone: string): string {
  return isValidTimeZone(timeZone) ? timeZone : 'UTC';
}

interface LocalParts {
  readonly date: string;
  readonly minutes: number;
}

function localPartsOf(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zoneOrUtc(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

/** The civil date of `at` in `timeZone` (an unknown zone reads as UTC). */
export function localDateOf(at: Date, timeZone: string): string {
  return localPartsOf(at, timeZone).date;
}

/** Whether the company's wall calendar at `at` shows a working day. */
export function isWorkingInstant(at: Date, calendar: WorkingCalendar): boolean {
  return isWorkingDay(localDateOf(at, calendar.timeZone), calendar);
}

/** UTC offset of `timeZone` at `at`, in ms (local − UTC). */
function offsetAt(at: number, timeZone: string): number {
  const local = localPartsOf(new Date(at), timeZone);
  const wall = dayNumberOf(local.date) * MS_PER_DAY + local.minutes * 60_000;
  return wall - Math.floor(at / 60_000) * 60_000;
}

/** The instant the wall clock in `timeZone` reads `date` at `minutes` past midnight. */
export function zonedInstant(date: string, minutes: number, timeZone: string): Date {
  const wall = dayNumberOf(date) * MS_PER_DAY + minutes * 60_000;
  const first = wall - offsetAt(wall, timeZone);
  const second = wall - offsetAt(first, timeZone);
  return new Date(second);
}

/**
 * The first instant at or after `at` inside working hours on a working day, in the calendar's
 * zone. `at` itself when it already is; otherwise the next working day's `dayStart` (or today's,
 * before it opens).
 */
export function nextWorkingStart(at: Date, calendar: WorkingCalendar): Date {
  const zone = zoneOrUtc(calendar.timeZone);
  const start = minutesOfClock(calendar.dayStart) ?? 0;
  const end = minutesOfClock(calendar.dayEnd) ?? 24 * 60;
  const local = localPartsOf(at, zone);
  if (isWorkingDay(local.date, calendar)) {
    if (local.minutes >= start && local.minutes < end) return at;
    if (local.minutes < start) return zonedInstant(local.date, start, zone);
  }
  const next = addWorkingDays(local.date, 1, calendar);
  return zonedInstant(next, start, zone);
}
