import { isWorkingInstant, minutesOfClock } from '@tmanage/domain';
import type { WorkingCalendar } from '@tmanage/domain';

/**
 * The "Skip weekends" hold and its release, as pure clock rules. R15: moved out of
 * `consumers/automation-runs.ts` and `jobs/due-soon-sweeper.ts`, which imported each other for
 * these helpers; both (and `weekend-hold-store.ts`) now import this leaf module instead.
 */

/** The local hour on Sunday from which held weekend runs go out. */
export const SUNDAY_DELIVERY_HOUR = 8;

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** The weekday (0 = Sunday) and hour (0–23) at `at` in `timeZone`; an unknown zone reads as UTC. */
export function localClock(at: Date, timeZone: string): { day: number; hour: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return { day: at.getUTCDay(), hour: at.getUTCHours() };
  }
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  return {
    day: WEEKDAYS[weekday] ?? at.getUTCDay(),
    hour: Number.isInteger(hour) ? hour % 24 : at.getUTCHours(),
  };
}

/**
 * A14 — "Skip weekends". The studio week ends on Friday and Saturday, so a rule with
 * `skipWeekends` does not send a reminder on those days **in the company's timezone**
 * (`organizations.timezone`; an unknown zone reads as UTC). Gap 10: the due-soon sweep then
 * delivers every held run on Sunday morning ({@link isWeekendHoldReleased}), once.
 */
export function isHeldForWeekend(skipWeekends: boolean, at: Date, timeZone = 'UTC'): boolean {
  if (!skipWeekends) return false;
  const { day } = localClock(at, timeZone);
  return day === 5 || day === 6;
}

/**
 * Gap 10 — whether a run held over the weekend may go out now: not on Friday or Saturday, and on
 * Sunday only from {@link SUNDAY_DELIVERY_HOUR} local time. A sweep that misses Sunday delivers on
 * the next weekday it runs (the store bounds how old a hold it still delivers).
 */
export function isWeekendHoldReleased(at: Date, timeZone: string): boolean {
  const { day, hour } = localClock(at, timeZone);
  if (day === 5 || day === 6) return false;
  return day !== 0 || hour >= SUNDAY_DELIVERY_HOUR;
}

/**
 * Whether a "Skip weekends" rule holds a run at `at`: on a non-working day (a weekend day or a
 * holiday) of the company calendar, in its zone. With no calendar row, today's rule: Friday or
 * Saturday in `fallbackTimeZone` (`organizations.timezone`).
 */
export function isHeldByCalendar(
  calendar: WorkingCalendar | null,
  at: Date,
  fallbackTimeZone: string,
): boolean {
  if (calendar === null) return isHeldForWeekend(true, at, fallbackTimeZone);
  return !isWorkingInstant(at, calendar);
}

/**
 * Whether held runs may go out at `at`: a working day of the company calendar, from its
 * `dayStart`. With no calendar row, today's rule (not Friday/Saturday; Sunday from 08:00).
 */
export function isCalendarHoldReleased(
  calendar: WorkingCalendar | null,
  at: Date,
  fallbackTimeZone: string,
): boolean {
  if (calendar === null) return isWeekendHoldReleased(at, fallbackTimeZone);
  if (!isWorkingInstant(at, calendar)) return false;
  const opens = minutesOfClock(calendar.dayStart.slice(0, 5)) ?? 0;
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: calendar.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const hour = Number(local.find((part) => part.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(local.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute >= opens;
}

/**
 * R15 — the words a released run's effect ends with, naming the day it actually went out (`at`,
 * a released instant) in the calendar's zone, or `organizations.timezone` without a calendar.
 * Only a Sunday release from the default Friday–Saturday hold reads "Sunday morning".
 */
export function heldReleaseNote(
  calendar: WorkingCalendar | null,
  at: Date,
  fallbackTimeZone: string,
): string {
  const { day } = localClock(at, calendar?.timeZone ?? fallbackTimeZone);
  if (calendar !== null) return ` on ${DAY_NAMES[day]}, the next working day`;
  return day === 0
    ? ' on Sunday morning, after the weekend'
    : ` on ${DAY_NAMES[day]}, after the weekend`;
}
