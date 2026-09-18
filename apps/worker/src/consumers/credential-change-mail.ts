import { findCredentialNoticeRecipient } from '../common/database/notice-store.js';
import type { ClaimedCredentialNotice } from '../common/database/notice-store.js';
import type { QueueHandler } from '../outbox/dispatcher.js';
import type { CredentialChangeMailer } from '../notifications/credential-change-mailer.js';

/**
 * The credential-change notice consumer — x31, closing x10's review finding C1 ("the table is
 * written atomically and never read").
 *
 * ## The shape is the client-request mail consumer's, for the same reasons
 *
 * The read happens **inside** the batch transaction; the send is handed to
 * `effects.afterCommit`. A handler that called SMTP directly would hold the batch's
 * transaction — and the claim's row locks — across a round trip to a host this process does
 * not control. See the dispatcher's module doc.
 *
 * ## At-most-once, and why that is the right guarantee *here*
 *
 * An effect runs only if the batch committed, and a committed batch has already stamped
 * `published_at`, so a failed send is never retried. For the client-request mail that is a
 * trade against the in-app notification, which is canonical. Here it is the *decision*
 * (`MAIL-SECOND-PRODUCER-DECISION` §3): `credential_change_notices` has no idempotency key —
 * 0020 says so by design — so a retry could only be an unguarded second send of a security
 * notice. Publishing before sending bounds the duplicate risk to zero at the cost of a mail
 * that can be lost, and a lost security receipt is recoverable (the row stays, `ID-05` shows
 * the change on the screen) where a stream of duplicates trains the owner to ignore them.
 * That residual is accepted and stated rather than hidden.
 *
 * ## Access is re-resolved, and a missing user is silence
 *
 * The notice carries a `user_id` and nothing else about the person. The address and name are
 * read from `users` at delivery, by primary key — so an address changed since the queue was
 * written is the address the mail goes to, and a user row that is gone yields `null`, which
 * returns without staging anything. A throw would instead spend an attempt, retry, and park a
 * row about an account nobody can be told about — a page raised by design rather than by a
 * fault.
 */
export function createCredentialChangeMail(
  mailer: CredentialChangeMailer,
): QueueHandler<ClaimedCredentialNotice> {
  return async (notice, tx, effects) => {
    if (!mailer.enabled) return; // No transport: do not pay for the read.

    const recipient = await findCredentialNoticeRecipient(tx, notice.userId);
    if (recipient === null) return; // The account is gone; there is nobody to tell.

    effects.afterCommit(async () => {
      await mailer.deliver({
        recipient,
        action: notice.action,
        occurredAt: notice.occurredAt,
      });
    });
  };
}
