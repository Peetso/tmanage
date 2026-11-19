import type { SignalFinding } from './signal-finding.js';
import { utcDate, wholeDaysBetween } from './signal-finding.js';

/**
 * Rule 6 — **Unusual expense** (money): a recent expense is at least the threshold times the usual
 * for its category — the median of the same category's other expenses over the
 * {@link UNUSUAL_EXPENSE_BASELINE_DAYS} before it (plan 62 §4.7: "3× the 90-day median").
 *
 * Only expenses spent within {@link UNUSUAL_EXPENSE_RECENT_DAYS} are judged (an old one is no
 * news), only submitted or approved ones (a draft is not spent, a rejected one is settled), and
 * only against at least {@link UNUSUAL_EXPENSE_MIN_SAMPLE} others (two rows are not a "usual").
 * Amounts are in the organization's base currency, so categories compare across currencies.
 */

export const UNUSUAL_EXPENSE_BASELINE_DAYS = 90;
export const UNUSUAL_EXPENSE_RECENT_DAYS = 7;
export const UNUSUAL_EXPENSE_MIN_SAMPLE = 3;

const JUDGED_STATES: ReadonlySet<string> = new Set(['submitted', 'approved']);

export interface UnusualExpenseFacts {
  readonly expenseId: string;
  readonly projectId: string | null;
  readonly state: string;
  /** `YYYY-MM-DD`. */
  readonly spentOn: string;
  readonly amountBaseMinor: number;
  /** The same category's other expenses in the baseline window, base currency. */
  readonly baselineAmountsBaseMinor: readonly number[];
}

/** The median of a list; null for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function evaluateUnusualExpense(
  facts: UnusualExpenseFacts,
  thresholdTimes: number,
  now: Date,
): SignalFinding | null {
  if (!JUDGED_STATES.has(facts.state)) return null;
  const spent = utcDate(facts.spentOn);
  if (spent === null || wholeDaysBetween(spent, now) > UNUSUAL_EXPENSE_RECENT_DAYS) return null;
  if (facts.baselineAmountsBaseMinor.length < UNUSUAL_EXPENSE_MIN_SAMPLE) return null;
  const usual = median(facts.baselineAmountsBaseMinor);
  if (usual === null || usual <= 0) return null;
  if (facts.amountBaseMinor < thresholdTimes * usual) return null;
  return {
    rule: 'unusual_expense',
    subjectType: 'expense',
    subjectId: facts.expenseId,
    projectId: facts.projectId,
    measure: Math.floor(facts.amountBaseMinor / usual),
    threshold: thresholdTimes,
  };
}
