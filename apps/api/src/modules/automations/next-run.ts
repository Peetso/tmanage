/**
 * Automations scheduled triggers (x167). The recurrence spec and the pure next-run computation.
 *
 * A schedule's *when* is a small, bounded, cron-like recurrence — `hourly`, `daily`, or `weekly`,
 * with an hour of the day and a day of the week where the interval uses them. This module owns two
 * things and nothing else:
 *
 * 1. {@link parseScheduleSpec} — validate an untrusted request body into a {@link ScheduleSpec},
 *    returning field errors rather than throwing (the controller turns them into a 400 with no
 *    write). An off-enum interval or an out-of-range hour/day is rejected here.
 * 2. {@link computeNextRunAt} — the *pure* function that, given a spec and the current instant,
 *    returns the next instant the schedule should fire. It takes `now` as a parameter and reads no
 *    wall clock, so it is deterministic and unit-testable; every field of the returned instant is
 *    derived from its inputs.
 *
 * All arithmetic is in UTC. The database stores instants in UTC (`DATETIME(3)` with the session time
 * zone pinned to UTC), and a schedule's hour is an hour of the UTC day — a display time zone is a
 * later concern, out of this slice.
 */

/** The recurrence intervals this slice supports. */
export const SCHEDULE_INTERVALS = ['hourly', 'daily', 'weekly'] as const;
export type ScheduleInterval = (typeof SCHEDULE_INTERVALS)[number];

/**
 * A validated recurrence spec. `hour` is present for `daily` and `weekly`; `dayOfWeek` (0 = Sunday
 * … 6 = Saturday) is present for `weekly`. `hourly` carries neither — it fires at the top of every
 * hour. Kept minimal on purpose: this is the whole `spec_json` shape at rest.
 */
export interface ScheduleSpec {
  readonly interval: ScheduleInterval;
  /** Hour of the UTC day, 0–23. Present for `daily` and `weekly`. */
  readonly hour?: number;
  /** Day of the week, 0 (Sunday) – 6 (Saturday). Present for `weekly`. */
  readonly dayOfWeek?: number;
}

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly spec: ScheduleSpec }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;

function isScheduleInterval(value: unknown): value is ScheduleInterval {
  return typeof value === 'string' && (SCHEDULE_INTERVALS as readonly string[]).includes(value);
}

/** An integer in `[min, max]`. Rejects non-integers, NaN, and out-of-range values. */
function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validate an untrusted `{ interval, hour?, dayOfWeek? }` body into a {@link ScheduleSpec}.
 *
 * Returns field errors rather than throwing so the controller can map them to one 400 with no write.
 * The bounds are total: an off-enum interval, a missing or out-of-range hour for `daily`/`weekly`, or
 * a missing or out-of-range `dayOfWeek` for `weekly`, are each a field error. Fields an interval does
 * not use are ignored (a stray `hour` on an `hourly` spec is dropped, not an error).
 */
export function parseScheduleSpec(raw: unknown): ParseResult {
  const body = (raw ?? {}) as { interval?: unknown; hour?: unknown; dayOfWeek?: unknown };
  const errors: FieldError[] = [];

  if (!isScheduleInterval(body.interval)) {
    return {
      ok: false,
      errors: [{ field: 'interval', message: `must be one of ${SCHEDULE_INTERVALS.join(', ')}` }],
    };
  }
  const interval = body.interval;

  let hour: number | undefined;
  let dayOfWeek: number | undefined;

  if (interval === 'daily' || interval === 'weekly') {
    if (!isIntInRange(body.hour, 0, 23)) {
      errors.push({ field: 'hour', message: 'must be an integer between 0 and 23' });
    } else {
      hour = body.hour;
    }
  }

  if (interval === 'weekly') {
    if (!isIntInRange(body.dayOfWeek, 0, 6)) {
      errors.push({
        field: 'dayOfWeek',
        message: 'must be an integer between 0 (Sunday) and 6 (Saturday)',
      });
    } else {
      dayOfWeek = body.dayOfWeek;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    spec: {
      interval,
      ...(hour === undefined ? {} : { hour }),
      ...(dayOfWeek === undefined ? {} : { dayOfWeek }),
    },
  };
}

/**
 * The next instant, strictly after `now`, at which the schedule fires. Pure and deterministic —
 * `now` is a parameter, no wall clock is read, and the result depends only on the inputs.
 *
 * - `hourly` — the next top of the hour after `now`.
 * - `daily` — the next `hour:00` of the UTC day; today's if it is still ahead of `now`, else
 *   tomorrow's.
 * - `weekly` — the next `hour:00` on `dayOfWeek` (UTC); this week's if it is still ahead, else next
 *   week's.
 *
 * The spec is assumed valid (produced by {@link parseScheduleSpec}); a `daily`/`weekly` spec without
 * its hour, or a `weekly` spec without its day, would be a programming error rather than a bad
 * request, so this defaults a missing field to 0 rather than guessing.
 */
export function computeNextRunAt(spec: ScheduleSpec, now: Date): Date {
  const nowMs = now.getTime();

  if (spec.interval === 'hourly') {
    // Truncate to the hour, then step to the next one — always strictly after `now`.
    const truncated = Math.floor(nowMs / MS_PER_HOUR) * MS_PER_HOUR;
    return new Date(truncated + MS_PER_HOUR);
  }

  const hour = spec.hour ?? 0;

  if (spec.interval === 'daily') {
    const candidate = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hour,
      0,
      0,
      0,
    );
    return new Date(candidate > nowMs ? candidate : candidate + MS_PER_DAY);
  }

  // weekly
  const dayOfWeek = spec.dayOfWeek ?? 0;
  const todayAtHour = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    0,
    0,
    0,
  );
  const deltaDays = (dayOfWeek - now.getUTCDay() + 7) % 7;
  const candidate = todayAtHour + deltaDays * MS_PER_DAY;
  return new Date(candidate > nowMs ? candidate : candidate + MS_PER_WEEK);
}
