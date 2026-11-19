import type { SignalFinding } from './signal-finding.js';
import { utcDate, wholeDaysBetween } from './signal-finding.js';

/**
 * Rule 8 (62-A1a) — **Approved time not invoiced** (money, finance only): a project holds billable
 * time from approved timesheets that is on no invoice line, and the oldest of it was worked at
 * least the threshold number of days ago. One signal per project, not per entry: the finance
 * team invoices a project, not a row. The same unbilled rows `finance-reports` lists, narrowed to
 * approved weeks.
 */

export interface UninvoicedTimeFacts {
  readonly projectId: string;
  readonly minutes: number;
  /** `YYYY-MM-DD` of the oldest such entry; null when there is none. */
  readonly oldestSpentOn: string | null;
}

export function evaluateApprovedTimeNotInvoiced(
  facts: UninvoicedTimeFacts,
  thresholdDays: number,
  now: Date,
): SignalFinding | null {
  if (facts.minutes <= 0 || facts.oldestSpentOn === null) return null;
  const oldest = utcDate(facts.oldestSpentOn);
  if (oldest === null) return null;
  const waitedDays = wholeDaysBetween(oldest, now);
  if (waitedDays < thresholdDays) return null;
  return {
    rule: 'approved_time_not_invoiced',
    subjectType: 'project',
    subjectId: facts.projectId,
    projectId: facts.projectId,
    measure: waitedDays,
    threshold: thresholdDays,
  };
}
