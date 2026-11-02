import { addWorkingDays, dayNumberOf, workingDaysBetween } from '../calendar/working-calendar.js';
import type { WorkingCalendar } from '../calendar/working-calendar.js';

/**
 * 53-04 — typed dependencies (FS / SS / FF / SF with a working-day lag), the cycle guard and the
 * cascade a schedule change sends down the graph. Pure: dates are ISO `YYYY-MM-DD` civil dates in
 * the company calendar's zone; the API converts instants to and from them.
 *
 * An edge reads "`workItemId` depends on `dependsOnWorkItemId`": the predecessor constrains the
 * successor. Per kind, with `lag` working days added to the predecessor's date:
 *
 * | kind | constrains          | earliest                 |
 * | ---- | ------------------- | ------------------------ |
 * | FS   | successor start     | predecessor due + lag    |
 * | SS   | successor start     | predecessor start + lag  |
 * | FF   | successor due       | predecessor due + lag    |
 * | SF   | successor due       | predecessor start + lag  |
 *
 * A due date is a deadline, not a finished day, so FS with no lag lets the successor start on the
 * predecessor's due day; a team that wants the next day sets lag 1.
 */

export const DEPENDENCY_KINDS = ['FS', 'SS', 'FF', 'SF'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];
export const DEPENDENCY_SOURCES = ['ui', 'api', 'mcp', 'import', 'automation'] as const;
export type DependencySource = (typeof DEPENDENCY_SOURCES)[number];
export const DEPENDENCY_STATUSES = ['active', 'suspended'] as const;
export type DependencyStatus = (typeof DEPENDENCY_STATUSES)[number];
export const MIN_DEPENDENCY_LAG = -30;
export const MAX_DEPENDENCY_LAG = 365;

export function isDependencyKind(value: unknown): value is DependencyKind {
  return typeof value === 'string' && (DEPENDENCY_KINDS as readonly string[]).includes(value);
}

export function isDependencyLag(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= MIN_DEPENDENCY_LAG &&
    (value as number) <= MAX_DEPENDENCY_LAG
  );
}

export interface DependencyLink {
  readonly workItemId: string;
  readonly dependsOnWorkItemId: string;
}

export interface TypedDependencyEdge extends DependencyLink {
  readonly kind: DependencyKind;
  readonly lag: number;
}

/** predecessor → its successors. */
function successorsOf(edges: readonly DependencyLink[]): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    const list = next.get(edge.dependsOnWorkItemId);
    if (list) list.push(edge.workItemId);
    else next.set(edge.dependsOnWorkItemId, [edge.workItemId]);
  }
  return next;
}

/**
 * Would adding `candidate` close a loop? Returns the loop as ids — the successor, then the chain
 * of its successors that reaches the proposed predecessor — or null. A self-edge is `[id]`.
 */
export function findCycle(
  edges: readonly DependencyLink[],
  candidate: DependencyLink,
): readonly string[] | null {
  const start = candidate.workItemId;
  const target = candidate.dependsOnWorkItemId;
  if (start === target) return [start];
  const next = successorsOf(edges);
  const parent = new Map<string, string | null>([[start, null]]);
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop() as string;
    for (const succ of next.get(node) ?? []) {
      if (parent.has(succ)) continue;
      parent.set(succ, node);
      if (succ === target) {
        const path: string[] = [];
        for (let at: string | null = succ; at !== null; at = parent.get(at) ?? null) path.push(at);
        return path.reverse();
      }
      stack.push(succ);
    }
  }
  return null;
}

/** Predecessors before successors (Kahn, ties by id for a stable answer); null on a cycle. */
export function topologicalOrder(
  edges: readonly DependencyLink[],
  nodes: Iterable<string> = [],
): readonly string[] | null {
  const all = new Set<string>(nodes);
  for (const edge of edges) {
    all.add(edge.workItemId);
    all.add(edge.dependsOnWorkItemId);
  }
  const indegree = new Map<string, number>([...all].map((id) => [id, 0]));
  for (const edge of edges) indegree.set(edge.workItemId, (indegree.get(edge.workItemId) ?? 0) + 1);
  const next = successorsOf(edges);
  const ready = [...all].filter((id) => indegree.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const node = ready.shift() as string;
    order.push(node);
    for (const succ of next.get(node) ?? []) {
      const left = (indegree.get(succ) ?? 0) - 1;
      indegree.set(succ, left);
      if (left === 0) {
        ready.push(succ);
        ready.sort();
      }
    }
  }
  return order.length === all.size ? order : null;
}

export interface ScheduleItem {
  readonly id: string;
  readonly startAt: string | null;
  readonly dueAt: string | null;
  readonly projectId: string;
}

export interface CascadeMove {
  readonly id: string;
  readonly startAt: string | null;
  readonly dueAt: string | null;
  /** Working days the item slid forward (always > 0: a cascade never pulls work earlier). */
  readonly deltaWorkingDays: number;
}

export interface CascadeResult {
  /** The successors that move, in topological order. The moved item itself is not listed. */
  readonly moves: readonly CascadeMove[];
  /** Reached successors with no dates at all: nothing to move, listed so the UI can say so. */
  readonly unscheduled: readonly string[];
}

export class DependencyCycleDetected extends Error {
  constructor() {
    super('the dependency graph has a cycle');
    this.name = 'DependencyCycleDetected';
  }
}

const later = (a: string, b: string): string => (dayNumberOf(a) >= dayNumberOf(b) ? a : b);

/**
 * Push `moved`'s new dates down the graph. Every successor reachable from it is visited in
 * topological order and gets `earliest = max(current, constraint)` for each predecessor edge;
 * its duration in working days is kept. A backward move never pulls a successor earlier (the
 * industry default: slack is the planner's to give back, not the engine's to take).
 *
 * An item with only one date is treated as a milestone on that date and keeps the one field.
 */
export function cascade(input: {
  readonly items: readonly ScheduleItem[];
  readonly edges: readonly TypedDependencyEdge[];
  readonly moved: {
    readonly id: string;
    readonly startAt: string | null;
    readonly dueAt: string | null;
  };
  readonly calendar: WorkingCalendar;
}): CascadeResult {
  const { calendar } = input;
  const dates = new Map<string, { startAt: string | null; dueAt: string | null }>();
  for (const item of input.items) dates.set(item.id, { startAt: item.startAt, dueAt: item.dueAt });
  dates.set(input.moved.id, { startAt: input.moved.startAt, dueAt: input.moved.dueAt });

  // The successors reachable from the moved item, and only the edges among them.
  const next = successorsOf(input.edges);
  const reached = new Set<string>([input.moved.id]);
  const stack = [input.moved.id];
  while (stack.length > 0) {
    for (const succ of next.get(stack.pop() as string) ?? []) {
      if (!reached.has(succ)) {
        reached.add(succ);
        stack.push(succ);
      }
    }
  }
  const inner = input.edges.filter(
    (e) => reached.has(e.workItemId) && reached.has(e.dependsOnWorkItemId),
  );
  const order = topologicalOrder(inner, reached);
  if (order === null) throw new DependencyCycleDetected();

  const incoming = new Map<string, TypedDependencyEdge[]>();
  for (const edge of input.edges) {
    const list = incoming.get(edge.workItemId);
    if (list) list.push(edge);
    else incoming.set(edge.workItemId, [edge]);
  }

  const moves: CascadeMove[] = [];
  const unscheduled: string[] = [];
  for (const id of order) {
    if (id === input.moved.id) continue;
    const current = dates.get(id);
    if (!current || (current.startAt === null && current.dueAt === null)) {
      unscheduled.push(id);
      continue;
    }
    const start0 = current.startAt ?? (current.dueAt as string);
    const due0 = current.dueAt ?? (current.startAt as string);
    const duration = Math.max(0, workingDaysBetween(start0, due0, calendar));

    let start = start0;
    let due = due0;
    let dueFloor: string | null = null;
    for (const edge of incoming.get(id) ?? []) {
      const pred = dates.get(edge.dependsOnWorkItemId);
      if (!pred) continue;
      const predStart = pred.startAt ?? pred.dueAt;
      const predDue = pred.dueAt ?? pred.startAt;
      const anchor = edge.kind === 'FS' || edge.kind === 'FF' ? predDue : predStart;
      if (anchor === null) continue;
      const bound = addWorkingDays(anchor, edge.lag, calendar);
      if (edge.kind === 'FS' || edge.kind === 'SS') start = later(start, bound);
      else dueFloor = dueFloor === null ? bound : later(dueFloor, bound);
    }
    if (start !== start0) due = addWorkingDays(start, duration, calendar);
    if (dueFloor !== null && dayNumberOf(dueFloor) > dayNumberOf(due)) {
      due = dueFloor;
      start = addWorkingDays(due, -duration, calendar);
    }
    if (start === start0 && due === due0) continue;

    const moved = {
      startAt: current.startAt === null ? null : start,
      dueAt: current.dueAt === null ? null : due,
    };
    dates.set(id, moved);
    moves.push({
      id,
      ...moved,
      deltaWorkingDays: workingDaysBetween(due0, due, calendar),
    });
  }
  return { moves, unscheduled };
}
