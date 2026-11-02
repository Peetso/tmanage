import {
  addWorkingDays,
  dayNumberOf,
  isoDateOfDayNumber,
  isWorkingDay,
  localDateOf,
  nthWorkingDay,
  workingDaysBetween,
  type WorkingCalendar,
} from '../calendar/working-calendar.js';

/**
 * 53-21 — iterations (light sprints) and points: the pure half.
 *
 * - **Burndown** is computed, never snapshotted: an item enters the scope on the org-local day it
 *   was assigned to the iteration (`assignedAt`; before the start, or unknown, counts from the
 *   start) and leaves the remaining figures on the org-local day of `completedAt`. An item without
 *   points counts as one item and zero points.
 * - **Next free slot**: the first working day after the last iteration's end (never before today),
 *   ten working days long.
 * - **Points**: the web offers Fibonacci chips; any whole number 0..100 is accepted.
 * - **Finished**: `done` and `archived` are the states an iteration's completion leaves behind; every
 *   other state is unfinished and rolls to the next iteration (or the backlog).
 */

export const ITERATION_STATUSES = ['planned', 'active', 'completed'] as const;
export type IterationStatus = (typeof ITERATION_STATUSES)[number];

/** The derived status on a given day: `ended` = past its end and not yet completed. */
export type IterationPhase = 'planned' | 'active' | 'ended' | 'completed';

export const FIBONACCI_POINTS: readonly number[] = [1, 2, 3, 5, 8, 13];
export const MAX_POINTS = 100;
export const DEFAULT_ITERATION_WORKING_DAYS = 10;
export const MAX_ITERATIONS_PER_PROJECT = 200;
export const MAX_ITERATION_ITEMS_PER_CALL = 2000;
export const MAX_ITERATION_NAME_LENGTH = 120;
export const MAX_ITERATION_GOAL_LENGTH = 300;

/** Work-item states an iteration's completion treats as finished (they stay where they are). */
export const FINISHED_WORK_ITEM_STATES: readonly string[] = ['done', 'archived'];

export function isFinishedWorkItemState(state: string): boolean {
  return FINISHED_WORK_ITEM_STATES.includes(state);
}

export function isFibonacciPoint(n: unknown): boolean {
  return typeof n === 'number' && FIBONACCI_POINTS.includes(n);
}

/** A storable point value: a whole number 0..{@link MAX_POINTS} (the chips are the web's). */
export function isValidPointValue(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_POINTS;
}

export interface IterationSpan {
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status?: string;
}

export interface BurndownItem {
  readonly points: number | null;
  /** When the item joined the iteration; `null` counts from the start. */
  readonly assignedAt: Date | null;
  readonly completedAt: Date | null;
}

export interface BurndownPoint {
  readonly date: string;
  readonly workingDay: boolean;
  /** Points committed (in scope) by the end of this day. */
  readonly scope: number;
  readonly scopeItems: number;
  readonly remainingPoints: number;
  readonly remainingItems: number;
}

export interface BurndownInput {
  readonly iteration: IterationSpan;
  readonly items: readonly BurndownItem[];
  readonly calendar: WorkingCalendar;
  /** The zone the day boundary is drawn in; defaults to the calendar's. */
  readonly timezone?: string;
}

/** A guard on a hand-typed range: an iteration longer than a year draws no chart. */
export const MAX_BURNDOWN_DAYS = 366;

export function burndown(input: BurndownInput): readonly BurndownPoint[] {
  const zone = input.timezone ?? input.calendar.timeZone;
  const start = dayNumberOf(input.iteration.startsOn);
  const end = dayNumberOf(input.iteration.endsOn);
  if (end < start || end - start >= MAX_BURNDOWN_DAYS) return [];
  const prepared = input.items.map((item) => ({
    points: item.points ?? 0,
    joined: item.assignedAt
      ? Math.max(start, dayNumberOf(localDateOf(item.assignedAt, zone)))
      : start,
    done: item.completedAt ? dayNumberOf(localDateOf(item.completedAt, zone)) : null,
  }));
  const out: BurndownPoint[] = [];
  for (let day = start; day <= end; day += 1) {
    let scope = 0;
    let scopeItems = 0;
    let remainingPoints = 0;
    let remainingItems = 0;
    for (const item of prepared) {
      if (item.joined > day) continue;
      scope += item.points;
      scopeItems += 1;
      if (item.done === null || item.done > day) {
        remainingPoints += item.points;
        remainingItems += 1;
      }
    }
    const date = isoDateOfDayNumber(day);
    out.push({
      date,
      workingDay: isWorkingDay(date, input.calendar),
      scope,
      scopeItems,
      remainingPoints,
      remainingItems,
    });
  }
  return out;
}

export function iterationStatusOn(iteration: IterationSpan, today: string): IterationPhase {
  if (iteration.status === 'completed') return 'completed';
  if (today < iteration.startsOn) return 'planned';
  if (today <= iteration.endsOn) return 'active';
  return 'ended';
}

/** Working days left from `today` (inclusive) to the end (inclusive); 0 once past it. */
export function workingDaysLeft(
  iteration: IterationSpan,
  calendar: WorkingCalendar,
  today: string,
): number {
  const from = today < iteration.startsOn ? iteration.startsOn : today;
  const afterEnd = isoDateOfDayNumber(dayNumberOf(iteration.endsOn) + 1);
  if (from >= afterEnd) return 0;
  return workingDaysBetween(from, afterEnd, calendar);
}

/**
 * The default dates for a new iteration: the first working day after the latest `endsOn` (or the
 * first working day on or after `today`, whichever is later), ten working days long.
 */
export function nextFreeSlot(
  iterations: readonly IterationSpan[],
  calendar: WorkingCalendar,
  today: string,
): { readonly startsOn: string; readonly endsOn: string } {
  const firstFromToday = nthWorkingDay(today, 1, calendar);
  let startsOn = firstFromToday;
  const lastEnd = iterations.reduce<string | null>(
    (latest, it) => (latest === null || it.endsOn > latest ? it.endsOn : latest),
    null,
  );
  if (lastEnd !== null) {
    const afterLast = addWorkingDays(lastEnd, 1, calendar);
    if (afterLast > startsOn) startsOn = afterLast;
  }
  const endsOn = nthWorkingDay(startsOn, DEFAULT_ITERATION_WORKING_DAYS, calendar);
  return { startsOn, endsOn };
}
