import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type {
  MailDelivery,
  MailFromOptions,
  MailMessage,
  MailReceipt,
  ReceiptMailer,
} from './mailer.js';
import { safeAttachment } from './mailer.js';

/**
 * The `smtp` driver — nodemailer over one configured submission endpoint.
 *
 * nodemailer rather than a hand-rolled client, said plainly because this repository leans
 * against dependencies: SMTP submission is dot-stuffing, CRLF framing, AUTH encodings,
 * STARTTLS negotiation and MIME header folding, every one of them a place where a
 * hand-rolled client silently corrupts or leaks. It is the `@node-rs/argon2` decision again
 * — the primitive is somebody's whole project, not a slice of this one. Zero transitive
 * dependencies; `smtp-mailer.test.ts` proves this wrapper end-to-end against a scripted
 * SMTP server on a local socket rather than trusting the library blind.
 */

export interface SmtpMailerOptions extends MailFromOptions {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS from the first byte (465). False starts plain and upgrades via STARTTLS. */
  readonly secure: boolean;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  /**
   * Socket-level TLS options, passed to the driver verbatim. Exists for the relay whose
   * certificate no public authority signed — and for the suite, whose scripted server's
   * certificate is its own. Absent means full verification, which is the right default.
   */
  readonly tls?: { readonly rejectUnauthorized?: boolean } | undefined;
}

export class SmtpMailer implements ReceiptMailer {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(options: SmtpMailerOptions) {
    const auth =
      options.username === undefined || options.password === undefined
        ? undefined
        : { user: options.username, pass: options.password };
    this.transport = createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      /**
       * Explicit, because nodemailer's defaults are too generous for the caller. The relay
       * runs its sends serially after a batch commits and consults no `AbortSignal` while it
       * does (see the dispatcher's module doc), so a host that accepts packets and answers
       * nothing would otherwise hold the whole relay — and swallow its SIGTERM — for
       * `batchSize` times nodemailer's two-minute connection timeout. Ten seconds is far
       * above any healthy submission endpoint's latency and bounds the stall at
       * `batchSize` × 10s.
       */
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
      /**
       * With credentials, TLS is mandatory, not opportunistic. nodemailer's default on a
       * `secure: false` connection is to use STARTTLS only when the server offers it and to
       * authenticate either way — so an on-path attacker who strips the STARTTLS capability
       * from the EHLO reply gets `AUTH PLAIN`'s base64 password and the invitation token in
       * cleartext, silently. `requireTLS` makes the session that cannot upgrade fail
       * loudly instead. An unauthenticated relay (a localhost forwarder) may stay plain:
       * it holds no credential to lose, and the operator chose it knowingly.
       */
      requireTLS: auth !== undefined && !options.secure,
      ...(auth === undefined ? {} : { auth }),
      ...(options.tls === undefined ? {} : { tls: { ...options.tls } }),
    });
    // nodemailer encodes the display name (RFC 2047) and refuses newlines in headers, so
    // the from line is built once here rather than sanitized per send.
    this.from = `"${options.fromName.replaceAll('"', "'")}" <${options.fromAddress}>`;
  }

  async send(message: MailMessage): Promise<MailDelivery> {
    return (await this.submit(message)).delivery;
  }

  /** 56-31: `send`, plus the server's message id for DSN matching (56-26). */
  async submit(message: MailMessage): Promise<MailReceipt> {
    const result = await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
      ...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
      ...(message.attachments === undefined || message.attachments.length === 0
        ? {}
        : {
            attachments: message.attachments.map((attachment) => {
              const safe = safeAttachment(attachment);
              return {
                filename: safe.filename,
                contentType: safe.contentType,
                content: Buffer.from(safe.content),
              };
            }),
          }),
    });
    // `sendMail` resolves once the server accepts the message; a recipient the server
    // refused is in `rejected` without the promise rejecting, and swallowing that would
    // report `'sent'` for a mail nobody will receive.
    const rejected = result.rejected ?? [];
    if (rejected.length > 0) {
      throw new Error(`the SMTP server refused ${rejected.length} recipient(s)`);
    }
    const messageId = typeof result.messageId === 'string' ? result.messageId.slice(0, 255) : null;
    return { delivery: 'sent', messageId };
  }
}
