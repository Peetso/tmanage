/**
 * The mail port — the interface the rest of the application sends through.
 *
 * Modeled on `BreachedPasswordScreen` (identity/password.ts): a one-method interface whose
 * concrete driver is chosen by configuration, so a producer never knows whether the message
 * crossed a network. `packages/config` already names the two drivers — `EMAIL_DRIVER` is
 * `console` or `smtp` — and this file is the type both implement.
 *
 * ## `send` returns what actually happened, and `'none'` is a real answer
 *
 * `35-NOTIFICATION-AND-EMAIL-COPY` §1: "In-app is canonical. Email/push are delivery
 * channels." A deployment without a mail host is therefore not broken — it is the bootstrap
 * profile's normal state, and the invitation screen keeps printing the link. The console
 * driver returns `'none'` because it *printed* rather than *sent*, and a caller that told a
 * user "an email is on its way" on that answer would be lying. `'sent'` means an SMTP server
 * accepted the message; a thrown error means it did not.
 */

export interface MailMessage {
  /** One recipient address. Every producer so far mails exactly one person per message. */
  readonly to: string;
  readonly subject: string;
  /**
   * Plain text only. `35-NOTIFICATION-AND-EMAIL-COPY` §3's templates are sentences with a
   * link, and a text body cannot smuggle markup past a client or hide a different href
   * under the visible one — the phishing shape a credential-bearing mail must not have.
   */
  readonly text: string;
  /**
   * An optional HTML alternative of the same message. `text` stays the authoritative body —
   * every client that cannot or will not render HTML shows it — and a producer that adds
   * `html` must keep every link's `href` identical to the URL it prints as text, so the visible
   * link and the clicked one cannot differ (the phishing shape this port refuses to enable).
   */
  readonly html?: string;
  /**
   * Where a reply goes. The `From` address is the platform's no-reply mailbox; a message whose
   * copy says "reply to the inviter" has to route the reply there or it says something untrue.
   */
  readonly replyTo?: string;
  /**
   * 51-11. Extra message headers — today only `List-Unsubscribe` and `List-Unsubscribe-Post`,
   * stamped by `NotificationMailTransport` on notification mail (Gmail/Yahoo bulk-sender rule).
   * A producer never sets these itself; a value holding CR or LF is refused by the transport.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * 56-31. Which template this is (`password_reset`, `invitation`, `digest`, …). The queue maps it
   * to a lane in exactly one place, `laneForTemplate` (lanes.ts); there is deliberately no `lane`
   * field, so no producer and no request can pick its own priority. Unknown or absent keys are
   * `transactional`, never `auth`.
   */
  readonly templateKey?: string;
}

/** What became of one message: accepted by a server, or printed by the console driver. */
export type MailDelivery = 'sent' | 'none';

/** 56-31. What the drainer records from a submission: the SMTP server's message id, if any. */
export interface MailReceipt {
  readonly delivery: MailDelivery;
  readonly messageId: string | null;
}

/** A transport that can report its receipt (SmtpMailer, SendCeilingMailer over one). */
export interface ReceiptMailer extends Mailer {
  submit(message: MailMessage): Promise<MailReceipt>;
}

export interface Mailer {
  /**
   * Deliver one message, or throw.
   *
   * Implementations do not retry and do not swallow: the producer decides what a failure
   * means for its own request, and `InvitationMailer` is the one that catches.
   */
  send(message: MailMessage): Promise<MailDelivery>;
}

/** What every driver needs to say who the mail is from. */
export interface MailFromOptions {
  readonly fromAddress: string;
  readonly fromName: string;
}
