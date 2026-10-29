import { createHash, randomUUID } from 'node:crypto';
import { authDeadlineMs, laneForTemplate, mailboxForLane } from './lanes.js';
import type { MailLane, Mailbox } from './lanes.js';
import type { MailDelivery, Mailer, MailMessage } from './mailer.js';

/**
 * 56-31 — the `Mailer` producers send through once the queue is on: `send` writes one
 * `mail_queue` row and returns; the worker drainer (`apps/worker/src/jobs/mail-drainer.ts`) is
 * the only code that submits to SMTP.
 *
 * `send` answers `'sent'` meaning *accepted for delivery* — the same promise an SMTP server's
 * 250 makes. A producer that tells a person "an email is on its way" is still telling the truth;
 * `'none'` stays reserved for "no transport at all".
 *
 * The lane comes from `laneForTemplate(message.templateKey)` and nothing else. A message object
 * carrying a stray `lane` property (a spread request body, say) is ignored on purpose.
 */

/** One row for `mail_queue`, as the queue writer receives it. */
export interface MailQueueEntry {
  readonly id: string;
  readonly organizationId: string | null;
  readonly lane: MailLane;
  readonly mailbox: Mailbox;
  readonly toHash: string;
  readonly templateKey: string;
  readonly payloadJson: string;
  readonly availableAt: Date;
  readonly deadlineAt: Date | null;
  readonly createdAt: Date;
}

/** Where queued rows go: the API's repository or the worker's store. */
export interface MailQueueWriter {
  enqueue(entry: MailQueueEntry): Promise<void>;
}

export interface QueueMailerOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** SHA-256 (hex, 64 chars) of the normalised address — `mail_queue.to_hash`. */
export function recipientHash(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase(), 'utf8').digest('hex');
}

/** The stored body of a queued message: the message itself, without its template key. */
interface QueuedPayload {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly replyTo?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export function encodeQueuedMessage(message: MailMessage): string {
  const payload: QueuedPayload = {
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html === undefined ? {} : { html: message.html }),
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    ...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
  };
  return JSON.stringify(payload);
}

/** The message back from `payload_json`, or `null` for a stripped or malformed row. */
export function decodeQueuedMessage(json: string, templateKey: string): MailMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  const { to, subject, text, html, replyTo, headers } = value;
  if (typeof to !== 'string' || typeof subject !== 'string' || typeof text !== 'string') {
    return null;
  }
  const headerMap =
    headers !== null && typeof headers === 'object'
      ? Object.fromEntries(
          Object.entries(headers as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined;
  return {
    to,
    subject,
    text,
    templateKey,
    ...(typeof html === 'string' ? { html } : {}),
    ...(typeof replyTo === 'string' ? { replyTo } : {}),
    ...(headerMap === undefined ? {} : { headers: headerMap }),
  };
}

export class QueueMailer implements Mailer {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly writer: MailQueueWriter,
    options: QueueMailerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
  }

  async send(message: MailMessage): Promise<MailDelivery> {
    const templateKey = (message.templateKey ?? 'transactional').slice(0, 64);
    const lane = laneForTemplate(message.templateKey);
    const at = this.now();
    const ttl = lane === 'auth' ? authDeadlineMs(message.templateKey) : null;
    await this.writer.enqueue({
      id: this.newId(),
      organizationId: null,
      lane,
      // The intended mailbox; the drainer falls back to noreply@ when security@ is absent.
      mailbox: mailboxForLane(lane, true),
      toHash: recipientHash(message.to),
      templateKey,
      payloadJson: encodeQueuedMessage(message),
      availableAt: at,
      deadlineAt: ttl === null ? null : new Date(at.getTime() + ttl),
      createdAt: at,
    });
    return 'sent';
  }
}

/** A mailer that stamps `templateKey` on every message lacking one — wiring, not producers. */
export function withTemplateKey(mailer: Mailer, templateKey: string): Mailer {
  return {
    send: (message) =>
      mailer.send(message.templateKey === undefined ? { ...message, templateKey } : message),
  };
}
