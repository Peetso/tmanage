import { createHash } from 'node:crypto';
import type { BounceKind } from './bounce-report.js';
import { emailAddressHash } from './list-unsubscribe.js';
import type { MailDelivery, Mailer, MailMessage, MailReceipt, ReceiptMailer } from './mailer.js';

/**
 * MAILREST — a recipient the SMTP server refuses at send time suppresses the address, for every
 * sending identity (noreply@, hello@, support@, security@, and the person mailboxes when
 * EMAIL_SEND_AS is on).
 *
 * ## Why this and not reading the hello@ / support@ mailboxes
 *
 * A bounce that arrives later, as a delivery report, goes back to the mailbox that sent the mail.
 * The bounce intake (`POST /v1/public/inbound-email/bounces`) only sees reports something posts
 * to it. Reading hello@ and support@ ourselves would need an IMAP login (the mailbox password, in
 * one more place and used for reading, not only sending), or the Hostinger Mail API token (not
 * set, and its read scope covers people's real replies), plus a new IMAP dependency. So that path
 * is not built; a refusal the server gives during the SMTP conversation is recorded here instead,
 * in the same `mail_recipient_bounces` store the intake writes, with the intake's own rules.
 *
 * ## What counts
 *
 * Only a 5xx reply to `RCPT TO` (nodemailer: `command` 'RCPT TO', `responseCode` 500–599): that
 * reply is about the recipient. A refused `MAIL FROM` (our own sender), a refused login (535),
 * a 5xx after `DATA` (about the content) and every 4xx (try again later) are not about the
 * address and are never recorded. With an RFC 3463 code in the reply, 5.1.x and 5.2.1 are
 * **hard** (the address will not take mail) and anything else is **soft**; a reply without a code
 * is soft, so a server's vague 550 can suppress only on its third refusal within 30 days.
 *
 * ## Counted once per message
 *
 * The reference is a hash of the company, recipient, subject and text: the drainer's retries of
 * one queued row and the person-mail retries of one tip are the same message and count once.
 *
 * The recorder failing (no grant yet, database down) never changes the send's outcome: the
 * original error is thrown either way.
 */

export interface SmtpRefusal {
  readonly kind: BounceKind;
  /** The RFC 3463 code from the reply, or `5.0.0` when the server gave none. */
  readonly status: string;
}

interface SmtpLikeError {
  readonly responseCode?: unknown;
  readonly command?: unknown;
  readonly response?: unknown;
}

/** An RFC 3463 code in the reply text; anchored on separators, no nested quantifiers. */
const ENHANCED = /(?:^|[\s(-])([245])\.(\d{1,3})\.(\d{1,3})(?=$|[\s):;,.])/u;
const MAX_RESPONSE = 512;

/** The recipient refusal an SMTP error carries, or `null` for any other failure. */
export function smtpRecipientRefusal(error: unknown): SmtpRefusal | null {
  if (typeof error !== 'object' || error === null) return null;
  const smtp = error as SmtpLikeError;
  const code = typeof smtp.responseCode === 'number' ? smtp.responseCode : null;
  if (code === null || code < 500 || code > 599) return null;
  const command = typeof smtp.command === 'string' ? smtp.command.trim().toUpperCase() : '';
  if (!command.startsWith('RCPT')) return null;
  const response = typeof smtp.response === 'string' ? smtp.response.slice(0, MAX_RESPONSE) : '';
  const match = ENHANCED.exec(response.slice(3));
  if (match === null || match[1] !== '5') return { kind: 'soft', status: '5.0.0' };
  const [, , subject, detail] = match;
  const status = `5.${subject ?? '0'}.${detail ?? '0'}`;
  const hard = subject === '1' || (subject === '2' && detail === '1');
  return { kind: hard ? 'hard' : 'soft', status };
}

/** The per-message reference (`last_message_ref`, at most 32 ASCII): `s.` + 16 base64url. */
export function refusalReference(message: MailMessage): string {
  const digest = createHash('sha256')
    .update(
      [
        message.organizationId ?? '',
        message.to.trim().toLowerCase(),
        message.subject,
        message.text,
      ].join('\n'),
      'utf8',
    )
    .digest('base64url');
  return `s.${digest.slice(0, 16)}`;
}

/** The `mail_recipient_bounces` fields one more refusal changes. */
export interface RecipientBounceRecord {
  readonly hardCount: number;
  readonly softCount: number;
  readonly lastKind: string;
  readonly lastStatus: string;
  readonly lastMessageRef: string;
  readonly lastBouncedAt: Date;
  readonly suppressedAt: Date | null;
}

export const REFUSAL_SOFT_LIMIT = 3;
export const REFUSAL_SOFT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The record after one more refusal, or `null` when this message was already counted. The same
 * rules as the intake (`nextBounceState`, apps/api mail-bounces): the first hard one, or the third
 * soft one within 30 days, suppresses; a suppression is never lifted here.
 */
export function nextRefusalState(
  existing: RecipientBounceRecord | null,
  refusal: SmtpRefusal,
  reference: string,
  at: Date,
): RecipientBounceRecord | null {
  const hard = refusal.kind === 'hard';
  if (existing === null) {
    return {
      hardCount: hard ? 1 : 0,
      softCount: hard ? 0 : 1,
      lastKind: refusal.kind,
      lastStatus: refusal.status,
      lastMessageRef: reference,
      lastBouncedAt: at,
      suppressedAt: hard ? at : null,
    };
  }
  const sameMessage = existing.lastMessageRef === reference;
  const escalates = sameMessage && hard && existing.lastKind === 'soft';
  if (sameMessage && !escalates) return null;
  let hardCount = existing.hardCount;
  let softCount = existing.softCount;
  if (escalates) {
    softCount = Math.max(0, softCount - 1);
    hardCount += 1;
  } else if (hard) {
    hardCount += 1;
  } else {
    const stale = at.getTime() - existing.lastBouncedAt.getTime() > REFUSAL_SOFT_WINDOW_MS;
    softCount = stale ? 1 : softCount + 1;
  }
  const suppress = hard || softCount >= REFUSAL_SOFT_LIMIT;
  return {
    hardCount,
    softCount,
    lastKind: refusal.kind,
    lastStatus: refusal.status,
    lastMessageRef: reference,
    lastBouncedAt: at,
    suppressedAt: existing.suppressedAt ?? (suppress ? at : null),
  };
}

export interface RefusalInput {
  readonly organizationId: string;
  readonly addressHash: string;
  readonly refusal: SmtpRefusal;
  readonly reference: string;
  readonly at: Date;
}

/** Writes one refusal into the company's bounce store (the worker's `mail_recipient_bounces`). */
export interface RefusalRecorder {
  recordRefusal(input: RefusalInput): Promise<void>;
}

/**
 * Wraps the sending identities. A message that names its company and is refused at `RCPT TO` is
 * recorded, then the original error is thrown unchanged (the drainer and the producers decide
 * what a failure means, as before).
 */
export class SmtpRefusalMailer implements ReceiptMailer {
  constructor(
    private readonly inner: Mailer | ReceiptMailer,
    private readonly recorder: RefusalRecorder,
    private readonly log: (line: string) => void = (line) => console.warn(line),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(message: MailMessage): Promise<MailDelivery> {
    return (await this.submit(message)).delivery;
  }

  async submit(message: MailMessage): Promise<MailReceipt> {
    try {
      const inner = this.inner;
      if ('submit' in inner && typeof inner.submit === 'function')
        return await inner.submit(message);
      return { delivery: await inner.send(message), messageId: null };
    } catch (error) {
      await this.note(message, error);
      throw error;
    }
  }

  private async note(message: MailMessage, error: unknown): Promise<void> {
    const refusal = smtpRecipientRefusal(error);
    if (refusal === null || message.organizationId === undefined) return;
    try {
      await this.recorder.recordRefusal({
        organizationId: message.organizationId,
        addressHash: emailAddressHash(message.to),
        refusal,
        reference: refusalReference(message),
        at: this.now(),
      });
    } catch {
      this.log('[mailer] could not record an SMTP recipient refusal');
    }
  }
}
