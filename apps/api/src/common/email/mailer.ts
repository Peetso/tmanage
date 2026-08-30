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
}

/** What became of one message: accepted by a server, or printed by the console driver. */
export type MailDelivery = 'sent' | 'none';

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
