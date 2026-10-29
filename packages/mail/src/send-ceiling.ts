import type { MailDelivery, Mailer, MailMessage, MailReceipt, ReceiptMailer } from './mailer.js';

/**
 * 51-11 / §9.2 — the host ceiling. Hostinger's hosting mail caps each mailbox per hour and per
 * day; a process that keeps submitting past the cap gets the mailbox throttled or suspended, and
 * then the password-reset mail that matters fails with the digest that did not.
 *
 * `SendCeilingMailer` wraps a transport and refuses — throws `MailCeilingReachedError`, which the
 * producers' `deliver` already absorbs as `'failed'` — once the process has submitted its share of
 * the sliding hour or day. Bulk/notification mail (anything carrying `List-Unsubscribe`) may use
 * only `bulkShare` of each window, so transactional mail (invitations, resets, security notices)
 * always keeps headroom. Which lane goes first beyond that is 56-31's ordering, not this file's.
 *
 * The counter is in-process: the worker relay is the bulk sender, and the API's transactional
 * sends are a handful per hour. A shared, durable counter is 56-31's when lanes land.
 */

/** Planning assumption (§9.2): ≈ 300/h, ≈ 3,000/day per mailbox — verified in hPanel by 51-16. */
export const HOST_MAIL_CEILING: SendCeiling = { perHour: 300, perDay: 3000, bulkShare: 0.8 };

export interface SendCeiling {
  readonly perHour: number;
  readonly perDay: number;
  /** The fraction of each window bulk/notification mail may use (0–1). */
  readonly bulkShare: number;
}

export class MailCeilingReachedError extends Error {
  constructor(readonly window: 'hour' | 'day') {
    super(`the mailbox send ceiling for this ${window} is reached; message not submitted`);
    this.name = 'MailCeilingReachedError';
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Whether a message is bulk/notification mail: the transport stamped an unsubscribe header. */
export function isBulkMessage(message: MailMessage): boolean {
  return message.headers?.['List-Unsubscribe'] !== undefined;
}

export class SendCeilingMailer implements ReceiptMailer {
  /** Submission instants (ms) inside the last day, oldest first. */
  private readonly sent: number[] = [];

  constructor(
    private readonly inner: Mailer,
    private readonly ceiling: SendCeiling = HOST_MAIL_CEILING,
    private readonly now: () => number = Date.now,
  ) {}

  async send(message: MailMessage): Promise<MailDelivery> {
    return (await this.submit(message)).delivery;
  }

  /** 56-31: the same ceiling, passing the inner transport's receipt through when it has one. */
  async submit(message: MailMessage): Promise<MailReceipt> {
    const at = this.now();
    while (this.sent.length > 0 && (this.sent[0] ?? at) <= at - DAY_MS) this.sent.shift();
    const share = isBulkMessage(message) ? Math.min(Math.max(this.ceiling.bulkShare, 0), 1) : 1;
    const hourLimit = Math.floor(this.ceiling.perHour * share);
    const dayLimit = Math.floor(this.ceiling.perDay * share);
    const inHour = this.sent.filter((instant) => instant > at - HOUR_MS).length;
    if (inHour >= hourLimit) throw new MailCeilingReachedError('hour');
    if (this.sent.length >= dayLimit) throw new MailCeilingReachedError('day');
    // Counted before the attempt: the server counts a submission it then refuses, too.
    this.sent.push(at);
    const inner = this.inner as Partial<ReceiptMailer> & Mailer;
    if (typeof inner.submit === 'function') return inner.submit(message);
    return { delivery: await this.inner.send(message), messageId: null };
  }
}
