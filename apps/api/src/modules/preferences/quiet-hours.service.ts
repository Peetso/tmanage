import type { QuietHours } from '../../common/database/schema.js';

/**
 * PREF-QUIET's active-window logic (module 20 Preferences & accessibility, x215).
 *
 * The one non-trivial decision quiet hours make — is *now* inside the member's window? — is a pure
 * function of the stored settings and the instant, kept out of the controller and the store so it can
 * be exercised in isolation. It reads no database and no `current_timestamp`; the caller passes a
 * bound `new Date()`, which is the admin-pool-clock discipline: the answer depends only on its inputs
 * and is deterministic under test.
 */

/** Parse `HH:MM` into minutes-since-midnight. Callers validate the format first. */
function minutesOfDay(time: string): number {
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * The weekday (0 = Sunday … 6 = Saturday) and minutes-since-midnight of `instant` **in `timezone`**.
 *
 * Uses `Intl.DateTimeFormat` with the stored zone so the answer is the member's local wall-clock, not
 * the server's or the database's. `hourCycle: 'h23'` keeps midnight at hour 0 rather than 24.
 */
function localParts(instant: Date, timezone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const lookup = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';

  const weekdayIndex: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    weekday: weekdayIndex[lookup('weekday')] ?? 0,
    minutes: Number(lookup('hour')) * 60 + Number(lookup('minute')),
  };
}

/**
 * Whether `instant` falls inside the member's quiet-hours window, evaluated in the stored timezone.
 *
 * Disabled windows are never active. When enabled, the current weekday must be one of `days` and the
 * current time-of-day must fall in `[startTime, endTime)`. A window whose end is not after its start
 * wraps past midnight (e.g. 22:00–07:00), so it is active when the time is at or after the start OR
 * before the end. A zero-length window (`start === end`) is never active.
 */
export function isWithinQuietHours(settings: QuietHours, instant: Date): boolean {
  if (!settings.enabled) return false;

  const { weekday, minutes } = localParts(instant, settings.timezone);
  if (!settings.days.includes(weekday)) return false;

  const start = minutesOfDay(settings.startTime);
  const end = minutesOfDay(settings.endTime);
  if (start === end) return false;

  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
