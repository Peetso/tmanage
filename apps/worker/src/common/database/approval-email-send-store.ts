import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

/**
 * QA-FIX-O H1 — the worker's half of `approval_email_sends` (0387, TENANT): settle one approver's
 * approval-request e-mail row once. The API inserted it `queued` beside the outbox event; this is
 * the only code that moves it.
 *
 * AS-2: the UPDATE is conditional on `state = 'queued'`, so a redelivered event (at-least-once) or
 * a quiet-hours resume never rewrites an outcome already recorded. DA-10: `settled_at` is a bound
 * `Date`, never the server clock. Grant: SELECT, UPDATE for `tmanage_worker` (users.sql 0387).
 */

export type ApprovalEmailOutcome =
  | { readonly state: 'sent' | 'failed'; readonly cause: null }
  | { readonly state: 'not_sent'; readonly cause: 'mail_off' | 'no_access' | 'no_transport' };

export interface ApprovalEmailSendRef {
  readonly organizationId: string;
  readonly sendRowId: string;
}

const SETTLE = `UPDATE approval_email_sends
    SET state = ?, cause = ?, settled_at = ?
  WHERE organization_id = ? AND id = ? AND state = 'queued'`;

/** Settle inside the caller's transaction (an outcome known before any mail is sent). */
export async function settleApprovalEmailSend(
  tx: WorkerTransaction,
  ref: ApprovalEmailSendRef,
  outcome: ApprovalEmailOutcome,
  at: Date = new Date(),
): Promise<void> {
  await tx.query(SETTLE, [outcome.state, outcome.cause, at, ref.organizationId, ref.sendRowId]);
}

/** Settles a row after the batch committed, when the SMTP answer is known, in its own transaction. */
export interface ApprovalEmailSettler {
  settle(ref: ApprovalEmailSendRef, outcome: ApprovalEmailOutcome): Promise<void>;
}

export function createApprovalEmailSettler(database: WorkerDatabase): ApprovalEmailSettler {
  return {
    async settle(ref, outcome) {
      await database.transaction((tx) => settleApprovalEmailSend(tx, ref, outcome));
    },
  };
}
