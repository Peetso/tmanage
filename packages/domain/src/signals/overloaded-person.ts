import { MS_PER_DAY } from './signal-finding.js';
import type { SignalFinding } from './signal-finding.js';
import { isOpenWorkState } from './work-states.js';

/**
 * Rule 2 — **Overloaded person**: the work planned for a person over the next seven days is at
 * least the threshold share of their weekly capacity ("110 % of capacity"). Planned work is the
 * remaining estimate of every open item they own that is due within the week or already late.
 * A person with no capacity row is never measured: zero capacity has no meaningful share.
 */

export const OVERLOAD_HORIZON_DAYS = 7;

export interface OverloadFacts {
  readonly membershipId: string;
  readonly weeklyCapacityMinutes: number;
  readonly plannedMinutes: number;
}

export interface PlannedItem {
  readonly state: string;
  readonly dueAt: Date | null;
  readonly remainingMinutes: number;
}

/** The remaining minutes of open items due within {@link OVERLOAD_HORIZON_DAYS} (or late). */
export function plannedMinutesThisWeek(items: readonly PlannedItem[], now: Date): number {
  const horizon = now.getTime() + OVERLOAD_HORIZON_DAYS * MS_PER_DAY;
  return items
    .filter((item) => isOpenWorkState(item.state) && item.dueAt !== null)
    .filter((item) => (item.dueAt as Date).getTime() <= horizon)
    .reduce((sum, item) => sum + Math.max(0, item.remainingMinutes), 0);
}

export function evaluateOverloadedPerson(
  facts: OverloadFacts,
  thresholdPercent: number,
): SignalFinding | null {
  if (facts.weeklyCapacityMinutes <= 0) return null;
  if (facts.plannedMinutes * 100 < thresholdPercent * facts.weeklyCapacityMinutes) return null;
  return {
    rule: 'overloaded_person',
    subjectType: 'membership',
    subjectId: facts.membershipId,
    projectId: null,
    measure: Math.floor((facts.plannedMinutes * 100) / facts.weeklyCapacityMinutes),
    threshold: thresholdPercent,
  };
}
