import type { SignalFinding } from './signal-finding.js';
import { utcDate, wholeDaysBetween } from './signal-finding.js';

/**
 * Rule 3 — **Overdue invoice** (money): a sent invoice with an amount still to collect is at
 * least the threshold number of days past its due date. Drafts, paid, void and credited invoices
 * are never overdue.
 */

const COLLECTIBLE_STATES: ReadonlySet<string> = new Set(['sent', 'partially_paid']);

export interface OverdueInvoiceFacts {
  readonly invoiceId: string;
  readonly projectId: string | null;
  readonly state: string;
  /** `YYYY-MM-DD`; null when the invoice has no due date. */
  readonly dueDate: string | null;
  readonly totalMinor: number;
  readonly paidMinor: number;
}

export function evaluateOverdueInvoice(
  facts: OverdueInvoiceFacts,
  thresholdDays: number,
  now: Date,
): SignalFinding | null {
  if (!COLLECTIBLE_STATES.has(facts.state)) return null;
  if (facts.totalMinor - facts.paidMinor <= 0) return null;
  const due = facts.dueDate === null ? null : utcDate(facts.dueDate);
  if (due === null) return null;
  const overdueDays = wholeDaysBetween(due, now);
  if (overdueDays < thresholdDays) return null;
  return {
    rule: 'overdue_invoice',
    subjectType: 'client_invoice',
    subjectId: facts.invoiceId,
    projectId: facts.projectId,
    measure: overdueDays,
    threshold: thresholdDays,
  };
}
