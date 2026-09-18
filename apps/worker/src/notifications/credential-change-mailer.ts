import type { Mailer, MailMessage } from '@tmanage/mail';
import type { CredentialNoticeRecipient } from '../common/database/notice-store.js';

/**
 * `D05d`'s security-event receipt, as an email — the relay's third producer on the
 * `@tmanage/mail` port and the first that is not about a client request.
 *
 * ## What it says, and the four things it deliberately does not
 *
 * `35-NOTIFICATION-AND-EMAIL-COPY` §1 puts "MFA/credential changes" in the critical-security
 * class but writes no template for one, so the sentence is written here and kept to what the
 * notice row actually holds: **who**, **what changed**, and **when**. Absent, each for a
 * reason migration 0020 already gives:
 *
 * - **No link.** Every other template in this directory carries one into a tenant's portal.
 *   A credential change happens on the identity path, before any organization is resolved —
 *   there is no `orgSlug` to build a route with, and a link invented for this mail would be
 *   the one phishing shape a security notice must never have.
 * - **No address and no device.** `authentication_events` holds both; the notice table
 *   refuses them on purpose, because an intruder reading the owner's mailbox would otherwise
 *   be handed the addresses the owner signs in from.
 * - **No secret.** Not a password, not a seed, not a recovery code. The relay's credential
 *   cannot reach the tables that hold them at all (`scripts/db/users.sql`, D07).
 * - **No unsubscribe.** §7 exempts transactional mail, and a security receipt the owner
 *   could switch off is a control an attacker switches off first.
 *
 * ## An unknown action is not mailed
 *
 * {@link composeCredentialChangeEmail} returns `null` for an `action` outside the four
 * `CREDENTIAL_CHANGE_ACTIONS` the API writes. A fifth action added upstream would otherwise
 * be rendered by interpolating a raw column value into a sentence about somebody's account —
 * so the notice is drained and stamped, and nothing is sent, which is the same answer the
 * dispatcher gives an event type with no consumer.
 */

/** The four the API writes (`CREDENTIAL_CHANGE_ACTIONS`), each as the owner's own sentence. */
const CHANGED_BY_ACTION: Readonly<Record<string, string>> = {
  password_set: 'Your password was changed.',
  mfa_factor_enrolled: 'A two-factor authentication method was added to your account.',
  mfa_factor_disabled: 'A two-factor authentication method was removed from your account.',
  recovery_codes_issued: 'A new set of recovery codes was issued for your account.',
};

/** The subject line per action — short, and specific enough to read in a notification bar. */
const SUBJECT_BY_ACTION: Readonly<Record<string, string>> = {
  password_set: 'Your TManage password was changed',
  mfa_factor_enrolled: 'Two-factor authentication was added to your TManage account',
  mfa_factor_disabled: 'Two-factor authentication was removed from your TManage account',
  recovery_codes_issued: 'New TManage recovery codes were issued',
};

/**
 * Flattened before it reaches a header or a body, for `invitation-email.ts`'s reason: a
 * display name is a string a person typed, and a newline in a subject is how one message
 * grows a second recipient.
 */
function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

/** `2026-09-19 14:05 UTC` — the instant, in the one zone the notice is stored in. */
function utcMinute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export interface CredentialChangeEmailFacts {
  readonly recipient: CredentialNoticeRecipient;
  readonly action: string;
  readonly occurredAt: Date;
}

/** The message, or `null` when the action is outside the closed vocabulary — see the header. */
export function composeCredentialChangeEmail(
  facts: CredentialChangeEmailFacts,
): MailMessage | null {
  if (!Object.hasOwn(CHANGED_BY_ACTION, facts.action)) return null;
  const changed = CHANGED_BY_ACTION[facts.action];
  const subject = SUBJECT_BY_ACTION[facts.action];
  if (changed === undefined || subject === undefined) return null;

  const name = oneLine(facts.recipient.displayName);
  return {
    to: facts.recipient.email,
    subject,
    text: [
      `Hello ${name},`,
      `${changed} This happened at ${utcMinute(facts.occurredAt)}.`,
      `You are receiving this because the change was made to the TManage account that uses ` +
        `this address. If it was you, nothing further is needed. If it was not, your account ` +
        `may be compromised: sign in, change your password, and contact your studio ` +
        `administrator immediately.`,
    ].join('\n\n'),
  };
}

/** What became of one notice. `'none'` means no transport was configured to try. */
export type CredentialChangeMailDelivery = 'sent' | 'none' | 'skipped' | 'failed';

/**
 * `ClientRequestMailer`'s shape, for the notice queue. Like it, {@link deliver} never throws:
 * it runs on the far side of the batch's commit, where a throw could not un-publish the row
 * it belongs to, so absorbing the error into the operator's log is the only honest shape.
 */
export class CredentialChangeMailer {
  /** @param mailer `null` when no transport is wired — every database suite's default. */
  constructor(private readonly mailer: Mailer | null) {}

  /** Whether a transport exists to try; the consumer reads this before paying for the join. */
  get enabled(): boolean {
    return this.mailer !== null;
  }

  async deliver(facts: CredentialChangeEmailFacts): Promise<CredentialChangeMailDelivery> {
    if (this.mailer === null) return 'none';
    const message = composeCredentialChangeEmail(facts);
    if (message === null) return 'skipped';
    try {
      return await this.mailer.send(message);
    } catch (error) {
      // Absorbed loudly, and without the address: the driver's words may name the recipient,
      // so they go to the operator's log and nowhere else — never into the batch report.
      console.error('[worker] credential change email failed', error);
      return 'failed';
    }
  }
}
