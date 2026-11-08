import type { TimelineMilestoneMoveInput, TimelineMoveInput } from '../../lib/api/work-views';

/**
 * 53-03 Editable Gantt — the pure date rules behind a drag, a resize and the keyboard path, kept
 * out of the screen so a unit can prove them without a DOM.
 */

export const DAY = 86_400_000;

/** What a gesture changes: the whole bar, its start edge, or its end edge. */
export type EditMode = 'move' | 'start' | 'end';

interface Dated {
  readonly startAt: string | null;
  readonly dueAt: string | null;
}

const parse = (value: string | null): number | null => {
  if (value === null) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
};

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());

/**
 * The dates a bar would have after `days` whole days of `mode`. A move shifts both ends; a resize
 * shifts one end and never lets it cross the other (a bar is at least its single day). A bar with
 * one dated end resizes from that end. An undated bar has nothing to move and is returned as is.
 */
export function shiftSchedule(row: Dated, mode: EditMode, days: number): TimelineMoveInput {
  const start = parse(row.startAt);
  const due = parse(row.dueAt);
  const delta = days * DAY;
  if (start === null && due === null) return { startAt: row.startAt, dueAt: row.dueAt };
  if (mode === 'move') {
    return {
      startAt: iso(start === null ? null : start + delta),
      dueAt: iso(due === null ? null : due + delta),
    };
  }
  if (mode === 'start') {
    const anchor = (start ?? due) as number;
    const next = due === null ? anchor + delta : Math.min(anchor + delta, due);
    return { startAt: iso(next), dueAt: iso(due) };
  }
  const anchor = (due ?? start) as number;
  const next = start === null ? anchor + delta : Math.max(anchor + delta, start);
  return { startAt: iso(start), dueAt: iso(next) };
}

/**
 * The keyboard alternative to dragging (A11Y-05): ←/→ move by a day, Shift by a week, Alt changes
 * the end instead of moving. "Later" follows the axis: in a right-to-left document time runs to the
 * left, so ← is later. `null` for a key that is not a step.
 */
export function stepForKey(
  key: string,
  options: { readonly shift: boolean; readonly alt: boolean; readonly rtl: boolean },
): { mode: EditMode; days: number } | null {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const later = key === 'ArrowRight' ? !options.rtl : options.rtl;
  const size = options.shift ? 7 : 1;
  return { mode: options.alt ? 'end' : 'move', days: later ? size : -size };
}

/** Whole days a horizontal pointer travel stands for; mirrored for a right-to-left axis. */
export function daysForTravel(
  dx: number,
  laneWidth: number,
  totalDays: number,
  rtl: boolean,
): number {
  if (laneWidth <= 0) return 0;
  const days = Math.round(((rtl ? -dx : dx) / laneWidth) * totalDays);
  return days === 0 ? 0 : days; // never -0
}

interface MilestoneDates {
  readonly committedOn: string | null;
  readonly forecastOn: string | null;
  readonly date: string | null;
}

/**
 * Which field a dragged diamond writes — the one it is drawn from (committed, else forecast, else
 * due) — and the new `YYYY-MM-DD` day. `null` when the diamond has no day yet.
 */
export function milestoneMove(
  milestone: MilestoneDates,
  days: number,
): TimelineMilestoneMoveInput | null {
  if (milestone.date === null) return null;
  const field =
    milestone.committedOn !== null
      ? 'committedOn'
      : milestone.forecastOn !== null
        ? 'forecastOn'
        : 'dueOn';
  const at = Date.parse(`${milestone.date.slice(0, 10)}T00:00:00Z`) + days * DAY;
  return { field, date: new Date(at).toISOString().slice(0, 10) };
}

/** Whole days a later date runs past an earlier one, or `null` when either is missing. */
export function slipDays(baseline: string | null, current: string | null): number | null {
  const a = parse(baseline);
  const b = parse(current);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY);
}
