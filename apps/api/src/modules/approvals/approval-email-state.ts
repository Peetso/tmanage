import type { ApprovalEmailSendRow } from '../../common/database/schema.js';

/**
 * QA-FIX-O H1 — what the deliverable page says about each approver's approval-request e-mail, and
 * whether "Resend email" is offered. Pure, so the table test can enumerate it.
 *
 * The facts are the `approval_email_sends` rows (0387): one per approver per send, `queued` until
 * the worker settles it. Only each approver's newest send counts; an older send's outcome is
 * history. An approver with no row was never e-mailed ("Email the approver now" was off).
 */

export type ApprovalEmailState = 'not_requested' | 'queued' | 'sent' | 'failed' | 'not_sent';

/** Why a row is `not_sent`. Anything else the worker might write reads as unknown (null). */
export type ApprovalEmailCause = 'mail_off' | 'no_access' | 'no_transport';

const CAUSES: ReadonlySet<string> = new Set<ApprovalEmailCause>([
  'mail_off',
  'no_access',
  'no_transport',
]);

const STATES: ReadonlySet<string> = new Set(['queued', 'sent', 'failed', 'not_sent']);

export interface ApproverEmailFacts {
  readonly state: ApprovalEmailState;
  readonly cause: ApprovalEmailCause | null;
  /** When the newest send was asked for, ISO; null when never asked. */
  readonly requestedAt: string | null;
  /** When the worker settled it, ISO; null while queued or never asked. */
  readonly settledAt: string | null;
}

/**
 * A queued send younger than this blocks a resend: it is still in flight (the relay polls every
 * few seconds), and a second click must not mail the approver twice (HT-4's natural key). Older
 * than this, the send is treated as stuck and a resend is allowed.
 */
export const RESEND_HOLD_MS = 5 * 60_000;

const NEVER: ApproverEmailFacts = {
  state: 'not_requested',
  cause: null,
  requestedAt: null,
  settledAt: null,
};

/** Each approver's newest send. `rows` may be in any order. */
export function newestSendPerRecipient(
  rows: readonly ApprovalEmailSendRow[],
): ReadonlyMap<string, ApprovalEmailSendRow> {
  const newest = new Map<string, ApprovalEmailSendRow>();
  for (const row of rows) {
    const seen = newest.get(row.recipientUserId);
    if (
      seen === undefined ||
      row.createdAt.getTime() > seen.createdAt.getTime() ||
      (row.createdAt.getTime() === seen.createdAt.getTime() && row.id > seen.id)
    ) {
      newest.set(row.recipientUserId, row);
    }
  }
  return newest;
}

export function approverEmailFacts(row: ApprovalEmailSendRow | undefined): ApproverEmailFacts {
  if (row === undefined) return NEVER;
  const state = STATES.has(row.state) ? (row.state as ApprovalEmailState) : 'queued';
  return {
    state,
    cause:
      state === 'not_sent' && row.cause !== null && CAUSES.has(row.cause)
        ? (row.cause as ApprovalEmailCause)
        : null,
    requestedAt: row.createdAt.toISOString(),
    settledAt: row.settledAt ? row.settledAt.toISOString() : null,
  };
}

/** A resend is refused while any approver's newest send is queued and younger than the hold. */
export function resendInFlight(
  rows: readonly ApprovalEmailSendRow[],
  reviewerIds: readonly string[],
  now: Date,
): boolean {
  const newest = newestSendPerRecipient(rows);
  return reviewerIds.some((id) => {
    const row = newest.get(id);
    return (
      row !== undefined &&
      row.state === 'queued' &&
      now.getTime() - row.createdAt.getTime() < RESEND_HOLD_MS
    );
  });
}
