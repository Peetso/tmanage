import type { MailDelivery, MailFromOptions, Mailer, MailMessage } from './mailer.js';
import { safeAttachment } from './mailer.js';

/**
 * The `console` driver — `.env.example`'s "writes to the log and sends nothing".
 *
 * A development substitute in ADR-0002's sense, and `packages/config` refuses it when
 * `NODE_ENV=production` for exactly that reason. It exists so a developer can watch what
 * *would* have been sent — the whole message, credential link included, because seeing the
 * link is the point of running it locally — without a mail host anywhere in the loop.
 *
 * It returns `'none'`, not `'sent'`: printing is not delivery, and the invitation screen
 * keeps telling the issuer to send the link themselves.
 */
export class ConsoleMailer implements Mailer {
  constructor(private readonly options: MailFromOptions) {}

  send(message: MailMessage): Promise<MailDelivery> {
    // `warn` rather than `info` because the lint policy (`no-console` allowing warn/error)
    // reserves stdout-adjacent logging for the two levels main.ts already uses. The prefix
    // makes the block findable in a dev server's scroll.
    console.warn(
      [
        '[mailer] console driver — nothing was sent',
        `From: ${message.from?.name ?? this.options.fromName} <${message.from?.address ?? this.options.fromAddress}>`,
        ...(message.replyTo === undefined ? [] : [`Reply-To: ${message.replyTo}`]),
        `To: ${message.to}`,
        `Subject: ${message.subject}`,
        ...(message.attachments ?? []).map((attachment) => {
          const safe = safeAttachment(attachment);
          return `Attachment: ${safe.filename} (${safe.contentType}, ${String(safe.content.byteLength)} bytes)`;
        }),
        '',
        message.text,
      ].join('\n'),
    );
    return Promise.resolve('none');
  }
}
