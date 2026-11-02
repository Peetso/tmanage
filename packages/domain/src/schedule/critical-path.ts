import { addWorkingDays, dayNumberOf, workingDaysBetween } from '../calendar/working-calendar.js';
import type { WorkingCalendar } from '../calendar/working-calendar.js';
import { DependencyCycleDetected, topologicalOrder } from './dependencies.js';
import type { ScheduleItem, TypedDependencyEdge } from './dependencies.js';

/**
 * 53-06 — the critical path method over the typed dependency graph (53-04) in working days (53-02).
 * Pure: dates are ISO `YYYY-MM-DD` civil dates in the company calendar's zone.
 *
 * - **Durations** are working days between an item's own start and due (`workingDaysBetween`); an
 *   item with one date is a milestone on it (duration 0). An item with no date is left out and
 *   listed in `unscheduled`; an edge to or from it constrains nothing.
 * - **Forward pass** in `topologicalOrder`. An item's own planned start is a floor (work is never
 *   scheduled before it is planned); each predecessor edge adds a bound with its lag through
 *   `addWorkingDays`, exactly as `cascade()` reads it — FS: start ≥ pred finish + lag; SS: start ≥
 *   pred start + lag; FF: finish ≥ pred finish + lag; SF: finish ≥ pred start + lag.
 * - **External predecessors** (another project's items, or ones the caller does not pass as items)
 *   are fixed dates: they bound their successors and are never rows of the answer.
 * - **Backward pass** from the latest early finish (the critical end date), mirroring each bound.
 * - **Total float** is late start − early start in working days, never below 0 (a negative value can
 *   only come from a weekend rounding of a lag); an item is critical when its float is 0.
 */

export interface CriticalPathRow {
  readonly id: string;
  readonly earlyStart: string;
  readonly earlyFinish: string;
  readonly lateStart: string;
  readonly lateFinish: string;
  readonly totalFloatDays: number;
  readonly isCritical: boolean;
}

export interface CriticalPathResult {
  /** One row per scheduled item, in topological order. */
  readonly rows: readonly CriticalPathRow[];
  /** The latest early finish; null when no item has a date. */
  readonly criticalEndDate: string | null;
  readonly criticalIds: readonly string[];
  /** Items with neither a start nor a due date. */
  readonly unscheduled: readonly string[];
}

export interface ExternalScheduleItem {
  readonly id: string;
  readonly startAt: string | null;
  readonly dueAt: string | null;
}

interface Span {
  start: string;
  finish: string;
  readonly duration: number;
}

const later = (a: string, b: string): string => (dayNumberOf(a) >= dayNumberOf(b) ? a : b);
const earlier = (a: string, b: string): string => (dayNumberOf(a) <= dayNumberOf(b) ? a : b);

/** Throws {@link DependencyCycleDetected} on a loop and `WorkingCalendarRangeError` past the horizon. */
export function criticalPath(input: {
  readonly items: readonly ScheduleItem[];
  readonly edges: readonly TypedDependencyEdge[];
  readonly calendar: WorkingCalendar;
  readonly external?: readonly ExternalScheduleItem[];
}): CriticalPathResult {
  const { calendar } = input;
  const planned = new Map<string, Span>();
  const unscheduled: string[] = [];
  for (const item of input.items) {
    if (item.startAt === null && item.dueAt === null) {
      unscheduled.push(item.id);
      continue;
    }
    const start = item.startAt ?? (item.dueAt as string);
    const finish = item.dueAt ?? (item.startAt as string);
    const duration = Math.max(0, workingDaysBetween(start, finish, calendar));
    planned.set(item.id, { start, finish: addWorkingDays(start, duration, calendar), duration });
  }

  const fixed = new Map<string, { start: string; finish: string }>();
  for (const ext of input.external ?? []) {
    if (planned.has(ext.id) || (ext.startAt === null && ext.dueAt === null)) continue;
    fixed.set(ext.id, {
      start: ext.startAt ?? (ext.dueAt as string),
      finish: ext.dueAt ?? (ext.startAt as string),
    });
  }

  const inner = input.edges.filter(
    (e) => planned.has(e.workItemId) && planned.has(e.dependsOnWorkItemId),
  );
  const order = topologicalOrder(inner, planned.keys());
  if (order === null) throw new DependencyCycleDetected();

  const incoming = new Map<string, TypedDependencyEdge[]>();
  const outgoing = new Map<string, TypedDependencyEdge[]>();
  for (const edge of input.edges) {
    if (!planned.has(edge.workItemId)) continue;
    if (!planned.has(edge.dependsOnWorkItemId) && !fixed.has(edge.dependsOnWorkItemId)) continue;
    const into = incoming.get(edge.workItemId);
    if (into) into.push(edge);
    else incoming.set(edge.workItemId, [edge]);
    if (!planned.has(edge.dependsOnWorkItemId)) continue;
    const out = outgoing.get(edge.dependsOnWorkItemId);
    if (out) out.push(edge);
    else outgoing.set(edge.dependsOnWorkItemId, [edge]);
  }

  // Forward pass: early start / finish.
  const early = new Map<string, Span>();
  for (const id of order) {
    const own = planned.get(id) as Span;
    let start = own.start;
    let finishFloor: string | null = null;
    for (const edge of incoming.get(id) ?? []) {
      const pred = early.get(edge.dependsOnWorkItemId) ?? fixed.get(edge.dependsOnWorkItemId);
      if (!pred) continue;
      const anchor = edge.kind === 'FS' || edge.kind === 'FF' ? pred.finish : pred.start;
      const bound = addWorkingDays(anchor, edge.lag, calendar);
      if (edge.kind === 'FS' || edge.kind === 'SS') start = later(start, bound);
      else finishFloor = finishFloor === null ? bound : later(finishFloor, bound);
    }
    let finish = addWorkingDays(start, own.duration, calendar);
    if (finishFloor !== null && dayNumberOf(finishFloor) > dayNumberOf(finish)) {
      finish = finishFloor;
      start = addWorkingDays(finish, -own.duration, calendar);
    }
    early.set(id, { start, finish, duration: own.duration });
  }

  let end: string | null = null;
  for (const span of early.values()) end = end === null ? span.finish : later(end, span.finish);
  if (end === null) return { rows: [], criticalEndDate: null, criticalIds: [], unscheduled };

  // Backward pass: late finish / start, in reverse topological order.
  const late = new Map<string, Span>();
  for (const id of [...order].reverse()) {
    const { duration } = early.get(id) as Span;
    let finish = end;
    for (const edge of outgoing.get(id) ?? []) {
      const succ = late.get(edge.workItemId) as Span;
      const anchor = edge.kind === 'FS' || edge.kind === 'SS' ? succ.start : succ.finish;
      const bound = addWorkingDays(anchor, -edge.lag, calendar);
      // FS / FF bound this item's finish; SS / SF bound its start (so its finish, + duration).
      const finishBound =
        edge.kind === 'FS' || edge.kind === 'FF'
          ? bound
          : addWorkingDays(bound, duration, calendar);
      finish = earlier(finish, finishBound);
    }
    late.set(id, { start: addWorkingDays(finish, -duration, calendar), finish, duration });
  }

  const rows: CriticalPathRow[] = order.map((id) => {
    const e = early.get(id) as Span;
    const l = late.get(id) as Span;
    const totalFloatDays = Math.max(0, workingDaysBetween(e.start, l.start, calendar));
    return {
      id,
      earlyStart: e.start,
      earlyFinish: e.finish,
      lateStart: l.start,
      lateFinish: l.finish,
      totalFloatDays,
      isCritical: totalFloatDays === 0,
    };
  });
  return {
    rows,
    criticalEndDate: end,
    criticalIds: rows.filter((r) => r.isCritical).map((r) => r.id),
    unscheduled,
  };
}
