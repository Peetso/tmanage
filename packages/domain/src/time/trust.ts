/**
 * Time you can trust (owner rule, 2026-11-23): "The timer exists so the accountant, HR, managers
 * and the client can see how much the employee worked and how long the task took." Time that
 * reaches them must say whether it was measured or typed in, and typed-in time counts only once a
 * manager accepts it (or, when the owner chose so, at once but flagged).
 *
 * This module is the ONE place that decides (AR-8):
 *
 * - what kind of time an entry is ({@link timeTrustOf}): `measured` (the server's timer, or the
 *   server's automatic sessions) or `hand` (typed in, or a correction of measured time);
 * - whether an entry counts in totals, reports, invoices, payroll exports and the client portal
 *   ({@link entryCounts}). The API stores the answer in `work_item_time_logs.counted` (0410) at
 *   every state change, so each reader filters one column instead of deciding again;
 * - the owner's policy and its defaults ({@link DEFAULT_TIME_TRUST_POLICY}): adding time by hand is
 *   OFF, hand time counts only after approval, and a forgotten timer stops after 10 hours.
 *
 * Reference models (vendor help pages, read 2026-11-23): Harvest "Approval" and locked
 * timesheets; Toggl Track "Timesheet approvals" and "Lock time entries"; Clockify "Force timer",
 * "Lock time entries" and "Approval"; Tempo Timesheets for Jira "Timesheet approval". Each gates
 * typed time behind an approver or forbids it, and none lets a member rewrite a measured entry in
 * place: a change is a new, reviewed record.
 *
 * Pure: no clock, no I/O (AR-1). The API, the web and the worker (which restates the cap, it may
 * not import the API) read the same rules.
 */

/** `work_item_time_logs.source`: how the minutes came to be. */
export const TIME_ENTRY_SOURCES = ['manual', 'timer', 'automatic', 'correction'] as const;
export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number];

/** What a report may call the minutes. */
export type TimeTrust = 'measured' | 'hand';

/** `work_item_time_logs.approval_state` (0410), a closed list checked here. */
export const TIME_APPROVAL_STATES = ['none', 'pending', 'approved', 'rejected'] as const;
export type TimeApprovalState = (typeof TIME_APPROVAL_STATES)[number];

/** How hand-added time counts while it waits for a manager. */
export const HAND_TIME_COUNT_MODES = ['after_approval', 'at_once_flagged'] as const;
export type HandTimeCountMode = (typeof HAND_TIME_COUNT_MODES)[number];

/** The forgotten-timer cap the owner may choose, in hours. */
export const IDLE_CAP_MIN_HOURS = 4;
export const IDLE_CAP_MAX_HOURS = 24;
export const IDLE_CAP_DEFAULT_HOURS = 10;

/** A reason for hand time or a correction: 3..500 characters (the `reason` column is 500). */
export const TIME_REASON_MIN = 3;
export const TIME_REASON_MAX = 500;

/** The owner's choices under Admin > Time. */
export interface TimeTrustPolicy {
  /** "Members may add time by hand". Default false. */
  readonly handTimeAllowed: boolean;
  /** Default `after_approval`. */
  readonly handTimeCountMode: HandTimeCountMode;
  /** A timer running longer is stopped and marked "needs review". Default 10. */
  readonly idleCapHours: number;
}

export const DEFAULT_TIME_TRUST_POLICY: TimeTrustPolicy = Object.freeze({
  handTimeAllowed: false,
  handTimeCountMode: 'after_approval',
  idleCapHours: IDLE_CAP_DEFAULT_HOURS,
});

export function isTimeEntrySource(value: unknown): value is TimeEntrySource {
  return (TIME_ENTRY_SOURCES as readonly unknown[]).includes(value);
}

export function isTimeApprovalState(value: unknown): value is TimeApprovalState {
  return (TIME_APPROVAL_STATES as readonly unknown[]).includes(value);
}

export function isHandTimeCountMode(value: unknown): value is HandTimeCountMode {
  return (HAND_TIME_COUNT_MODES as readonly unknown[]).includes(value);
}

export function isIdleCapHours(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= IDLE_CAP_MIN_HOURS &&
    value <= IDLE_CAP_MAX_HOURS
  );
}

/** Measured = the server stamped start and stop (timer) or the sessions (automatic). */
export function timeTrustOf(source: string): TimeTrust {
  return source === 'timer' || source === 'automatic' ? 'measured' : 'hand';
}

/** The facts {@link entryCounts} judges, as stored on the row. */
export interface CountedFacts {
  readonly source: string;
  readonly approvalState: string;
  readonly needsReview: boolean;
  /** Set on an entry once a correction of it was approved: the correction counts instead. */
  readonly supersededBy: string | null;
}

/**
 * Does this entry count in totals, reports, invoices, payroll exports and the client portal?
 *
 * - A rejected entry never counts; a superseded one never counts (its approved correction does).
 * - Measured time counts, except a timer the system stopped at the cap ("needs review"): it never
 *   silently counts. A manager accepts it (approved) or the person asks for a correction.
 * - A correction counts only once approved.
 * - Hand time counts once approved; while pending only when the owner chose "count at once, but
 *   flag it". Hand time from before this rule (`none`) keeps counting and keeps its label.
 */
export function entryCounts(facts: CountedFacts, mode: HandTimeCountMode): boolean {
  if (facts.approvalState === 'rejected' || facts.supersededBy !== null) return false;
  if (facts.source === 'correction') return facts.approvalState === 'approved';
  if (timeTrustOf(facts.source) === 'measured') {
    return !facts.needsReview || facts.approvalState === 'approved';
  }
  if (facts.approvalState === 'pending') return mode === 'at_once_flagged';
  return true;
}

/** Measured and hand minutes of counted entries: the split every report shows. */
export interface TimeTrustTotals {
  readonly measuredMinutes: number;
  readonly handMinutes: number;
  /** Minutes still waiting for a manager (hand time, corrections, capped timers). */
  readonly pendingMinutes: number;
}

export function trustTotals(
  entries: readonly {
    readonly minutes: number;
    readonly source: string;
    readonly counted: boolean;
    readonly approvalState: string;
  }[],
): TimeTrustTotals {
  let measuredMinutes = 0;
  let handMinutes = 0;
  let pendingMinutes = 0;
  for (const entry of entries) {
    if (entry.approvalState === 'pending') pendingMinutes += entry.minutes;
    if (!entry.counted) continue;
    if (timeTrustOf(entry.source) === 'measured') measuredMinutes += entry.minutes;
    else handMinutes += entry.minutes;
  }
  return { measuredMinutes, handMinutes, pendingMinutes };
}

/** Why typed-in time is refused. `null` = allowed. */
export type HandTimeRefusal = 'hand_time_off' | 'reason_required';

export function handTimeRefusal(
  policy: Pick<TimeTrustPolicy, 'handTimeAllowed'>,
  reason: string | null,
): HandTimeRefusal | null {
  if (!policy.handTimeAllowed) return 'hand_time_off';
  if (reason === null || reason.trim().length < TIME_REASON_MIN) return 'reason_required';
  return null;
}

/**
 * The refusal in the owner's words, the same for a person, the AI and an MCP client, so a refusal
 * is never a bare 403.
 */
export const HAND_TIME_REFUSAL_MESSAGES: Readonly<Record<HandTimeRefusal, string>> = {
  hand_time_off:
    'The owner turned off adding time by hand. Use the timer. If timer time is wrong, ask for a correction.',
  reason_required: 'Time added by hand needs a reason (3 to 500 characters).',
};

/** A measured entry is never rewritten: its minutes, start, end and day are the server's. */
export const MEASURED_EDIT_REFUSAL =
  'Timer time cannot be changed. Ask for a correction with a reason; a manager approves it.';
