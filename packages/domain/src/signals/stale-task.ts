import type { SignalFinding } from './signal-finding.js';
import { wholeDaysBetween } from './signal-finding.js';
import { isActiveWorkState } from './work-states.js';

/**
 * Rule 5 — **Stale task**: an active work item (picked up, not finished) has not changed for at
 * least the threshold number of days. Backlog is parked by design and never stale.
 */

export interface StaleTaskFacts {
  readonly workItemId: string;
  readonly projectId: string;
  readonly state: string;
  readonly updatedAt: Date;
}

export function evaluateStaleTask(
  facts: StaleTaskFacts,
  thresholdDays: number,
  now: Date,
): SignalFinding | null {
  if (!isActiveWorkState(facts.state)) return null;
  const idleDays = wholeDaysBetween(facts.updatedAt, now);
  if (idleDays < thresholdDays) return null;
  return {
    rule: 'stale_task',
    subjectType: 'work_item',
    subjectId: facts.workItemId,
    projectId: facts.projectId,
    measure: idleDays,
    threshold: thresholdDays,
  };
}
