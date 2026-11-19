import { MS_PER_DAY } from './signal-finding.js';
import type { SignalFinding } from './signal-finding.js';
import { isOpenWorkState } from './work-states.js';

/**
 * Rule 1 — **Deadline at risk**: an open work item is due within the threshold (days before) and
 * either is already past due, or the work left on it — together with the same person's work due
 * earlier — does not fit in the time that person has until the due date.
 *
 * "Fits" is the earliest-deadline-first check: a person works their queue in due order, so an item
 * is reachable only if every remaining estimate due no later than it fits in their capacity up to
 * its due date. An item with nobody on it has no capacity: any work left puts it at risk. An item
 * with no estimate has no work left to measure and is at risk only once it is late.
 */

export interface DeadlineWorkFacts {
  readonly workItemId: string;
  readonly projectId: string;
  readonly state: string;
  readonly dueAt: Date;
  /** Estimate minus logged time, never below zero; zero without an estimate. */
  readonly remainingMinutes: number;
  /** This item's remaining minutes plus every earlier-due open item of the same assignee. */
  readonly queuedMinutes: number;
  /** The assignee's capacity from now to the due date; null when nobody is assigned. */
  readonly capacityMinutesUntilDue: number | null;
}

export interface QueuedItem {
  readonly workItemId: string;
  readonly dueAt: Date;
  readonly remainingMinutes: number;
}

/** Per item, the minutes queued up to and including it, in due order (ties by id). */
export function queuedMinutesByItem(items: readonly QueuedItem[]): ReadonlyMap<string, number> {
  const ordered = [...items].sort(
    (a, b) =>
      a.dueAt.getTime() - b.dueAt.getTime() ||
      (a.workItemId < b.workItemId ? -1 : a.workItemId > b.workItemId ? 1 : 0),
  );
  const queued = new Map<string, number>();
  let total = 0;
  for (const item of ordered) {
    total += Math.max(0, item.remainingMinutes);
    queued.set(item.workItemId, total);
  }
  return queued;
}

/** A weekly capacity spread evenly over the time from `now` to `dueAt`, in whole minutes. */
export function capacityMinutesUntil(weeklyMinutes: number, now: Date, dueAt: Date): number {
  const span = dueAt.getTime() - now.getTime();
  if (span <= 0 || weeklyMinutes <= 0) return 0;
  return Math.floor((weeklyMinutes * span) / (7 * MS_PER_DAY));
}

export function evaluateDeadlineAtRisk(
  facts: DeadlineWorkFacts,
  thresholdDays: number,
  now: Date,
): SignalFinding | null {
  if (!isOpenWorkState(facts.state)) return null;
  const untilDue = facts.dueAt.getTime() - now.getTime();
  if (untilDue > thresholdDays * MS_PER_DAY) return null;
  const late = untilDue <= 0;
  const doesNotFit =
    facts.remainingMinutes > 0 &&
    (facts.capacityMinutesUntilDue === null || facts.queuedMinutes > facts.capacityMinutesUntilDue);
  if (!late && !doesNotFit) return null;
  return {
    rule: 'deadline_at_risk',
    subjectType: 'work_item',
    subjectId: facts.workItemId,
    projectId: facts.projectId,
    measure: Math.floor(untilDue / MS_PER_DAY),
    threshold: thresholdDays,
  };
}
