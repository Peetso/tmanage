import {
  WorkingCalendarRangeError,
  dayNumberOf,
  isIsoDate,
  isWorkingDay,
  weekdaysOfMask,
  workingDaysBetween,
} from '@tmanage/domain';
import type { WorkingCalendar } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';

/**
 * 53-08 workload hours and capacity (R20-b) — the pure arithmetic, no I/O.
 *
 * One person's load per week: the hours of their open work items (estimate spread across the item's
 * working days), their project allocations (explicit `hours_per_week`, else `percent` of capacity),
 * against their weekly capacity (shrunk by holidays and time off). Work the reader may not read is
 * summed into `otherProjectsHours` — a number with no project id and no title. Hours only: no score,
 * no ranking (master plan: no surveillance). Every hour figure on the wire is rounded to 0.5 h.
 */

export const MAX_LOAD_WEEKS = 26;

/** One Monday-to-Sunday bucket; both ends inclusive ISO dates. */
export interface WeekBucket {
  readonly weekStart: string;
  readonly weekEnd: string;
}

export interface LoadItem {
  readonly projectId: string;
  /** Whether the reader may read this item (per-row `work.read`). Unreadable → the bucket. */
  readonly readable: boolean;
  /** Local ISO dates (the calendar's zone), or null. */
  readonly startOn: string | null;
  readonly dueOn: string | null;
  readonly estimateMinutes: number | null;
}

export interface LoadAllocation {
  readonly projectId: string;
  readonly readable: boolean;
  readonly status: 'tentative' | 'confirmed';
  readonly percent: number;
  readonly hoursPerWeek: number | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
}

export interface LoadCapacity {
  readonly weeklyHours: number;
  readonly effectiveFrom: string;
}

export interface DateRange {
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface PersonLoadWeek {
  readonly weekStart: string;
  readonly capacityHours: number;
  /** Readable item hours + confirmed allocation hours on readable projects. */
  readonly plannedHours: number;
  /** Tentative allocation hours, kept apart from planned. */
  readonly tentativeHours: number;
  /** Hours on work the reader may not read: no project id, no title. */
  readonly otherProjectsHours: number;
  /** max(0, planned + other projects − capacity). */
  readonly overBy: number;
  readonly projects: readonly { readonly projectId: string; readonly hours: number }[];
}

export interface PersonLoad {
  readonly weeks: readonly PersonLoadWeek[];
}

/** Round to the nearest half hour. */
export function roundHalf(hours: number): number {
  return Math.round(hours * 2) / 2;
}

const MS_PER_DAY = 86_400_000;

function isoDateOfDayNumber(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  return isoDateOfDayNumber(dayNumberOf(isoDate) + days);
}

/** Monday on or before `date` (weekday 0 = Sunday). */
function mondayOf(date: string): string {
  const day = dayNumberOf(date);
  const weekday = (((day + 4) % 7) + 7) % 7;
  return isoDateOfDayNumber(day - ((weekday + 6) % 7));
}

function invalid(field: string, message: string, auditCode?: string): ApiError {
  return new ApiError(
    400,
    'validation_failed',
    `${field} is invalid`,
    [{ field, message }],
    auditCode,
  );
}

/**
 * The Monday-start week buckets covering `[from, to]`. Both must be ISO dates with `to ≥ from`;
 * more than {@link MAX_LOAD_WEEKS} buckets is a 400 (`window_too_long`) before any read.
 */
export function weekBuckets(from: unknown, to: unknown): readonly WeekBucket[] {
  if (!isIsoDate(from)) throw invalid('from', 'must be an ISO-8601 date (YYYY-MM-DD)');
  if (!isIsoDate(to)) throw invalid('to', 'must be an ISO-8601 date (YYYY-MM-DD)');
  if (to < from) throw invalid('to', 'must not be before from');
  const first = dayNumberOf(mondayOf(from));
  const last = dayNumberOf(to);
  const count = Math.floor((last - first) / 7) + 1;
  if (count > MAX_LOAD_WEEKS) {
    throw invalid('to', `window_too_long: at most ${MAX_LOAD_WEEKS} weeks`, 'window_too_long');
  }
  return Array.from({ length: count }, (_, i) => {
    const weekStart = isoDateOfDayNumber(first + i * 7);
    return { weekStart, weekEnd: addDays(weekStart, 6) };
  });
}

/** Working days in the inclusive range `[from, to]` (0 when empty). */
function workingDaysInclusive(from: string, to: string, calendar: WorkingCalendar): number {
  if (to < from) return 0;
  return workingDaysBetween(from, addDays(to, 1), calendar);
}

interface ItemSpan {
  readonly lo: string;
  readonly hi: string;
  /** Working days in `[lo, hi]`; 0 means the whole estimate lands in the due (else start) week. */
  readonly total: number;
  readonly hours: number;
  readonly anchor: string;
}

function itemSpan(item: LoadItem, calendar: WorkingCalendar): ItemSpan | null {
  const minutes = item.estimateMinutes;
  if (minutes === null || !(minutes > 0)) return null;
  const hours = minutes / 60;
  const start = item.startOn;
  const due = item.dueOn;
  if (start === null && due === null) return null;
  if (start === null || due === null) {
    const only = (start ?? due) as string;
    return { lo: only, hi: only, total: 0, hours, anchor: only };
  }
  const [lo, hi] = start <= due ? [start, due] : [due, start];
  try {
    return { lo, hi, total: workingDaysInclusive(lo, hi, calendar), hours, anchor: due };
  } catch (error) {
    // A span beyond the calendar horizon is a data error, not load: it contributes nothing.
    if (error instanceof WorkingCalendarRangeError) return null;
    throw error;
  }
}

function spreadSpan(span: ItemSpan | null, week: WeekBucket, calendar: WorkingCalendar): number {
  if (span === null) return 0;
  if (span.total === 0) {
    return span.anchor >= week.weekStart && span.anchor <= week.weekEnd ? span.hours : 0;
  }
  const from = span.lo > week.weekStart ? span.lo : week.weekStart;
  const to = span.hi < week.weekEnd ? span.hi : week.weekEnd;
  const inWeek = workingDaysInclusive(from, to, calendar);
  return (span.hours * inWeek) / span.total;
}

/**
 * The hours of `item` that fall in `week`: estimate × (the item's working days inside the week ÷ its
 * working days overall). No estimate or no dates → 0; a single date (due-only, or start-only) lands
 * the whole estimate in that date's week, as does a span with no working day in it.
 */
export function spreadItemHours(
  item: LoadItem,
  week: WeekBucket,
  calendar: WorkingCalendar,
): number {
  return spreadSpan(itemSpan(item, calendar), week, calendar);
}

function inRanges(date: string, ranges: readonly DateRange[]): boolean {
  return ranges.some((range) => date >= range.startsOn && date <= range.endsOn);
}

/**
 * Capacity hours in `week`: weeklyHours × (working days in the week on or after `effectiveFrom`,
 * minus time-off days) ÷ the calendar's working days per week. A holiday shrinks it; time off
 * removes its days; before `effectiveFrom` it is 0.
 */
export function capacityHours(
  weeklyHours: number,
  effectiveFrom: string,
  week: WeekBucket,
  calendar: WorkingCalendar,
  timeOffRanges: readonly DateRange[],
): number {
  const perWeek = weekdaysOfMask(calendar.workingDaysMask).length;
  if (perWeek === 0 || !(weeklyHours > 0)) return 0;
  let available = 0;
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(week.weekStart, i);
    if (day < effectiveFrom) continue;
    if (!isWorkingDay(day, calendar)) continue;
    if (inRanges(day, timeOffRanges)) continue;
    available += 1;
  }
  return (weeklyHours * available) / perWeek;
}

/**
 * An allocation's hours in `week`, split by status: `hours_per_week` when set, else
 * `percent / 100 × capacityHours`. An allocation whose window misses the week is 0.
 */
export function allocationHours(
  allocation: LoadAllocation,
  week: WeekBucket,
  capacity: number,
): { readonly confirmed: number; readonly tentative: number } {
  const startsBy = allocation.startDate === null || allocation.startDate <= week.weekEnd;
  const endsAfter = allocation.endDate === null || allocation.endDate >= week.weekStart;
  if (!startsBy || !endsAfter) return { confirmed: 0, tentative: 0 };
  const hours = allocation.hoursPerWeek ?? (allocation.percent / 100) * capacity;
  return allocation.status === 'tentative'
    ? { confirmed: 0, tentative: hours }
    : { confirmed: hours, tentative: 0 };
}

export interface BuildPersonLoadInput {
  readonly weeks: readonly WeekBucket[];
  readonly items: readonly LoadItem[];
  readonly allocations: readonly LoadAllocation[];
  readonly capacity: LoadCapacity | null;
  readonly timeOff: readonly DateRange[];
  readonly calendar: WorkingCalendar;
}

/**
 * Fold one person's items, allocations, capacity and time off into the week rows. Readable work is
 * itemised by project; unreadable work only adds to `otherProjectsHours`. Tentative allocations are
 * reported apart and never count toward planned hours or `overBy`.
 */
export function buildPersonLoad(input: BuildPersonLoadInput): PersonLoad {
  const spans = input.items.map((item) => ({ item, span: itemSpan(item, input.calendar) }));

  const weeks = input.weeks.map((week): PersonLoadWeek => {
    const capacity =
      input.capacity === null
        ? 0
        : capacityHours(
            input.capacity.weeklyHours,
            input.capacity.effectiveFrom,
            week,
            input.calendar,
            input.timeOff,
          );

    const byProject = new Map<string, number>();
    const add = (projectId: string, hours: number): void => {
      if (hours > 0) byProject.set(projectId, (byProject.get(projectId) ?? 0) + hours);
    };
    let other = 0;
    let tentative = 0;

    for (const { item, span } of spans) {
      const hours = spreadSpan(span, week, input.calendar);
      if (item.readable) add(item.projectId, hours);
      else other += hours;
    }
    for (const allocation of input.allocations) {
      const split = allocationHours(allocation, week, capacity);
      tentative += split.tentative;
      if (allocation.readable) add(allocation.projectId, split.confirmed);
      else other += split.confirmed;
    }

    const planned = [...byProject.values()].reduce((sum, h) => sum + h, 0);
    const projects = [...byProject.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([projectId, hours]) => ({ projectId, hours: roundHalf(hours) }));

    return {
      weekStart: week.weekStart,
      capacityHours: roundHalf(capacity),
      plannedHours: roundHalf(planned),
      tentativeHours: roundHalf(tentative),
      otherProjectsHours: roundHalf(other),
      overBy: roundHalf(Math.max(0, planned + other - capacity)),
      projects,
    };
  });

  return { weeks };
}
