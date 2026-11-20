import { createHash, randomUUID } from 'node:crypto';
import { authDeadlineMs, laneForTemplate, mailboxForLane } from './lanes.js';
import type { MailLane, Mailbox } from './lanes.js';
import type {
  MailAttachment,
  MailDelivery,
  MailIdentity,
  Mailer,
  MailMessage,
  MailSender,
} from './mailer.js';
import { MAX_MAIL_MESSAGE_BYTES, safeAttachment } from './mailer.js';
import {
  MAX_DISPLAY_NAME,
  isMailIdentity,
  validateSenderAddress,
  validateSenderName,
} from './sender.js';

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
  readonly attachments?: readonly QueuedAttachment[];
  /** EMAILBUILD. The resolver's sender; re-validated on decode and again by the SMTP driver. */
  readonly from?: MailSender;
  /** EMAILBUILD (amendment 3). The mailbox key only, never a credential; checked on decode. */
  readonly identity?: MailIdentity;
  /** PERSONMAIL. Optional (notification) mail: the drainer's ceiling gives it the bulk share. */
  readonly optional?: true;
}

/** INVMAIL. An attachment as stored: its content base64-encoded. */
interface QueuedAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly contentBase64: string;
}

export function encodeQueuedMessage(message: MailMessage): string {
  const payload: QueuedPayload = {
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html === undefined ? {} : { html: message.html }),
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    ...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
    ...(message.from === undefined ? {} : { from: { ...message.from } }),
    ...(message.identity === undefined ? {} : { identity: message.identity }),
    ...(message.optional === true ? { optional: true as const } : {}),
    ...(message.attachments === undefined || message.attachments.length === 0
      ? {}
      : {
          attachments: message.attachments.map((attachment) => {
            const safe = safeAttachment(attachment);
            return {
              filename: safe.filename,
              contentType: safe.contentType,
              contentBase64: Buffer.from(safe.content).toString('base64'),
            };
          }),
        }),
  };
  return JSON.stringify(payload);
}

/**
 * INVMAIL. `message` with `attachment` when the whole message still fits the mailer's limit
 * (`MAX_MAIL_MESSAGE_BYTES`, measured as stored), else `message` unchanged: the caller's text
 * carries a link to the same file, so a large file is skipped, never the mail.
 */
export function attachIfFits(message: MailMessage, attachment: MailAttachment): MailMessage {
  const withFile = { ...message, attachments: [...(message.attachments ?? []), attachment] };
  return Buffer.byteLength(encodeQueuedMessage(withFile), 'utf8') <= MAX_MAIL_MESSAGE_BYTES
    ? withFile
    : message;
}

function decodeAttachments(value: unknown): MailAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: MailAttachment[] = [];
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const { filename, contentType, contentBase64 } = item as Record<string, unknown>;
    if (
      typeof filename !== 'string' ||
      typeof contentType !== 'string' ||
      typeof contentBase64 !== 'string'
    ) {
      continue;
    }
    files.push(
      safeAttachment({ filename, contentType, content: Buffer.from(contentBase64, 'base64') }),
    );
  }
  return files.length === 0 ? undefined : files;
}

/** EMAILBUILD. A stored sender, or `undefined` when it is missing or fails validation. */
function decodeSender(value: unknown): MailSender | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { name, address } = value as Record<string, unknown>;
  if (typeof name !== 'string' || !validateSenderName(name, MAX_DISPLAY_NAME)) return undefined;
  if (address === undefined) return { name };
  return typeof address === 'string' && validateSenderAddress(address)
    ? { name, address }
    : undefined;
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
  const attachments = decodeAttachments(value['attachments']);
  const from = decodeSender(value['from']);
  // A key off the closed list is refused: the row then leaves through noreply@.
  const identity = isMailIdentity(value['identity']) ? value['identity'] : undefined;
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
    ...(attachments === undefined ? {} : { attachments }),
    ...(from === undefined ? {} : { from }),
    ...(identity === undefined ? {} : { identity }),
    ...(value['optional'] === true ? { optional: true } : {}),
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
      // 56-26: the drainer hands it back to the SMTP driver, which signs the Message-ID with it.
      organizationId: message.organizationId ?? null,
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
