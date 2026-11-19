import { PENDING_APPROVAL_STATES } from '../state-machines/approval.js';
import type { SignalFinding } from './signal-finding.js';
import { wholeDaysBetween } from './signal-finding.js';

/**
 * Rule 7 (62-A1a) — **Approval waiting on the client**: an approval the client has been asked for
 * (requested or viewed, not decided) has waited at least the threshold number of days. An
 * approval is stored at `requested` when it is opened, so its creation time is when the wait began.
 */

const PENDING: ReadonlySet<string> = new Set(PENDING_APPROVAL_STATES);

export interface ApprovalWaitFacts {
  readonly approvalId: string;
  readonly projectId: string;
  readonly state: string;
  readonly requestedAt: Date;
}

export function evaluateApprovalWaitingOnClient(
  facts: ApprovalWaitFacts,
  thresholdDays: number,
  now: Date,
): SignalFinding | null {
  if (!PENDING.has(facts.state)) return null;
  const waitedDays = wholeDaysBetween(facts.requestedAt, now);
  if (waitedDays < thresholdDays) return null;
  return {
    rule: 'approval_waiting_on_client',
    subjectType: 'approval',
    subjectId: facts.approvalId,
    projectId: facts.projectId,
    measure: waitedDays,
    threshold: thresholdDays,
  };
}
