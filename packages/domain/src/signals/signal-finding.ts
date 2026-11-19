import type { SignalRuleKey, SignalSubjectType } from './signal-catalog.js';

/**
 * What a rule returns when it fires: the subject, the project it belongs to (when it has one),
 * and the measured value next to the threshold it was compared with, so a notice and the briefing
 * can say why in words ("14 h of work left, 6 h free") without recomputing anything.
 */
export interface SignalFinding {
  readonly rule: SignalRuleKey;
  readonly subjectType: SignalSubjectType;
  readonly subjectId: string;
  readonly projectId: string | null;
  /** The measured figure in the rule's unit (days, per cent, times the usual). Whole number. */
  readonly measure: number;
  /** The threshold in force when the rule fired. */
  readonly threshold: number;
}

export const MS_PER_DAY = 86_400_000;

/** At most one signal per subject per rule in this window (plan 62 §4.7). */
export const SIGNAL_DEDUPE_WINDOW_MS = MS_PER_DAY;

/** Whole days from `from` to `to`, rounded down; negative when `to` is earlier. */
export function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * The calendar day (UTC, `YYYY-MM-DD`) a signal is filed under. Stored beside the signal and part
 * of its unique key, so two sweeps racing on one day write one row.
 */
export function signalDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Whether a subject may be raised again: never raised, or the last raise is at least
 * {@link SIGNAL_DEDUPE_WINDOW_MS} old. Together with the per-day unique key this keeps one signal
 * per subject per 24 hours, also across midnight.
 */
export function mayRaiseSignal(lastRaisedAt: Date | null, now: Date): boolean {
  return lastRaisedAt === null || now.getTime() - lastRaisedAt.getTime() >= SIGNAL_DEDUPE_WINDOW_MS;
}

/** The parse of a stored `YYYY-MM-DD` date as midnight UTC; null when it is not one. */
export function utcDate(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day
    ? null
    : parsed;
}
