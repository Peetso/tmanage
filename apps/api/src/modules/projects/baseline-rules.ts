import { isWorkingDay, workingDaysBetween, WorkingCalendarRangeError } from '@tmanage/domain';
import type { WorkingCalendar } from '@tmanage/domain';

/**
 * 53-05 — the pure schedule-variance rules for a baseline. No I/O: the service hands in civil
 * dates (`YYYY-MM-DD` in the org calendar's zone) and the calendar.
 *
 * Variance is counted in **working days** of the calendar (53-02), not calendar days: a task due
 * Thursday that moves to the next Tuesday in a Sun–Thu company slipped 3 working days, not 5.
 * The finish date drives the figure; when either side has no due date the start date is used, and
 * with neither the delta is null (nothing to compare).
 */

export interface FrozenDates {
  readonly startAt: string | null;
  readonly dueAt: string | null;
}

export type VarianceStatus = 'slipped' | 'early' | 'on_track';
export type BaselineRowStatus = VarianceStatus | 'removed' | 'added';

export interface Variance {
  readonly deltaWorkingDays: number | null;
  readonly status: VarianceStatus;
}

/** Working days from `from` to `to` (negative when earlier), or null outside the horizon. */
function signedWorkingDays(from: string, to: string, calendar: WorkingCalendar): number | null {
  try {
    return workingDaysBetween(from, to, calendar);
  } catch (error) {
    if (error instanceof WorkingCalendarRangeError) return null;
    throw error;
  }
}

/** The working-day slip of `live` against `frozen`, and its status. */
export function varianceOf(
  frozen: FrozenDates,
  live: FrozenDates,
  calendar: WorkingCalendar,
): Variance {
  const pair: readonly [string, string] | null =
    frozen.dueAt !== null && live.dueAt !== null
      ? [frozen.dueAt, live.dueAt]
      : frozen.startAt !== null && live.startAt !== null
        ? [frozen.startAt, live.startAt]
        : null;
  const delta = pair === null ? null : signedWorkingDays(pair[0], pair[1], calendar);
  if (delta === null || delta === 0) return { deltaWorkingDays: delta, status: 'on_track' };
  return { deltaWorkingDays: delta, status: delta > 0 ? 'slipped' : 'early' };
}

/**
 * The row status of one item in a variance view: `removed` when it was frozen but no longer exists
 * (deleted or purged), `added` when it exists but was not in the baseline, else its variance.
 */
export function rowStatus(
  frozen: FrozenDates | null,
  live: FrozenDates | null,
  calendar: WorkingCalendar,
): { readonly deltaWorkingDays: number | null; readonly status: BaselineRowStatus } {
  if (frozen !== null && live === null) return { deltaWorkingDays: null, status: 'removed' };
  if (frozen === null) return { deltaWorkingDays: null, status: 'added' };
  return varianceOf(frozen, live as FrozenDates, calendar);
}

/** SMALLINT bounds of `project_baseline_items.duration_working_days`. */
const SMALLINT_MAX = 32_767;

/**
 * Working days an item spans, start to due inclusive of a working due day; null without both
 * dates, when due precedes start, or beyond the calendar horizon.
 */
export function durationWorkingDays(
  startAt: string | null,
  dueAt: string | null,
  calendar: WorkingCalendar,
): number | null {
  if (startAt === null || dueAt === null) return null;
  const between = signedWorkingDays(startAt, dueAt, calendar);
  if (between === null || between < 0) return null;
  const total = between + (isWorkingDay(dueAt, calendar) ? 1 : 0);
  return Math.min(total, SMALLINT_MAX);
}

/** Order for the variance list: largest slip first, unknown deltas last, then by id. */
export function bySlipDesc(
  a: { readonly deltaWorkingDays: number | null; readonly workItemId: string },
  b: { readonly deltaWorkingDays: number | null; readonly workItemId: string },
): number {
  const da = a.deltaWorkingDays;
  const db = b.deltaWorkingDays;
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return db - da;
  }
  return a.workItemId < b.workItemId ? -1 : a.workItemId > b.workItemId ? 1 : 0;
}
