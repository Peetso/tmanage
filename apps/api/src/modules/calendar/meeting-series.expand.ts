import type { MeetingSeriesFreq } from './meeting-series.repository.js';

/**
 * CAL recurrence (x129) — the pure occurrence expansion.
 *
 * A meeting series is a *rule*, not a set of rows: given a frequency, an every-N interval, an
 * anchor date and an optional end date, this expands the calendar dates the rule falls on inside a
 * bounded `[from, to]` window. It is a pure function of its arguments — no database, no clock, no
 * I/O — so the occurrences endpoint reads nothing and writes nothing, and this file is unit-testable
 * on its own.
 *
 * Dates are calendar dates carried as `'YYYY-MM-DD'` strings end to end (the 0012 convention): a
 * recurrence rule falls on days, not instants, and a string never drifts a day west of UTC the way a
 * zone-rendered instant would. All arithmetic is done in UTC on the date's midnight so no local zone
 * can move a boundary.
 */

/** The largest window the occurrences read will expand, in days. A wider request is a 400. */
export const MAX_WINDOW_DAYS = 90;

export interface RecurrenceSpec {
  readonly freq: MeetingSeriesFreq;
  /** Every-N: 1 = every period, 2 = every other, and so on. Must be a positive integer. */
  readonly interval: number;
  /** The first date the series may recur on — the series' own creation date this slice. */
  readonly anchor: string;
  /** The last date the series may recur on, or `null` for an open-ended series. */
  readonly until: string | null;
}

/** Parse a `'YYYY-MM-DD'` calendar date to a UTC-midnight epoch-day count, or `null` if malformed. */
function toEpochDay(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const back = new Date(utc);
  // Reject an out-of-range field (e.g. month 13, day 32) that Date.UTC would have rolled over.
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(utc / 86_400_000);
}

/** Render a UTC-midnight epoch-day count back to a `'YYYY-MM-DD'` calendar date. */
function fromEpochDay(epochDay: number): string {
  return new Date(epochDay * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Whether `[from, to]` is a valid window no wider than {@link MAX_WINDOW_DAYS}.
 *
 * Both bounds must be well-formed dates, `to` must not precede `from`, and the span (inclusive) must
 * be at most the cap. Exported so the controller answers a 400 before any read, and the expansion
 * itself stays a total function over a validated window.
 */
export function isWindowValid(from: string, to: string): boolean {
  const a = toEpochDay(from);
  const b = toEpochDay(to);
  if (a === null || b === null) return false;
  if (b < a) return false;
  return b - a + 1 <= MAX_WINDOW_DAYS;
}

/** Step an epoch-day forward by `n` periods of `freq`, in UTC, clamping a monthly day overflow. */
function step(epochDay: number, freq: MeetingSeriesFreq, n: number): number {
  if (freq === 'daily') return epochDay + n;
  if (freq === 'weekly') return epochDay + n * 7;
  // monthly: add whole months and clamp to the last day of the target month (Jan 31 + 1 → Feb 28/29).
  const base = new Date(epochDay * 86_400_000);
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const day = base.getUTCDate();
  const targetMonthIndex = month + n;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return Math.floor(Date.UTC(targetYear, targetMonth, clampedDay) / 86_400_000);
}

/**
 * Expand the occurrences a series falls on inside `[from, to]`, ascending.
 *
 * The window must already be valid ({@link isWindowValid}); an invalid window or a non-positive
 * interval yields an empty list rather than throwing, so a caller can never drive this into a
 * non-terminating loop. Occurrences begin at the anchor and step by `interval` periods, stopping at
 * the series' `until` (when set) or the window's far edge, whichever is first.
 */
export function expandOccurrences(spec: RecurrenceSpec, from: string, to: string): string[] {
  if (!Number.isSafeInteger(spec.interval) || spec.interval < 1) return [];
  if (!isWindowValid(from, to)) return [];

  const anchor = toEpochDay(spec.anchor);
  const windowStart = toEpochDay(from) as number;
  const windowEnd = toEpochDay(to) as number;
  if (anchor === null) return [];

  const until = spec.until === null ? null : toEpochDay(spec.until);
  if (spec.until !== null && until === null) return [];
  // The far edge is the earlier of the window end and the series end.
  const hardEnd = until === null ? windowEnd : Math.min(windowEnd, until);
  if (hardEnd < windowStart) return [];

  const out: string[] = [];
  // The window is bounded to MAX_WINDOW_DAYS, so at interval 1 (daily) this loops at most that many
  // times; a wider interval only reduces it. The guard on `hardEnd` is the terminator.
  for (let n = 0; ; n += 1) {
    const day = step(anchor, spec.freq, n);
    if (day > hardEnd) break;
    if (day >= windowStart) out.push(fromEpochDay(day));
    // Safety valve: an occurrence already past the window end cannot be un-passed by a later step.
    if (day > windowEnd) break;
  }
  return out;
}
