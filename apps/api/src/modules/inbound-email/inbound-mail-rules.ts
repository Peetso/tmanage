import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { uploadObjectKey } from '@tmanage/storage';
import {
  EXECUTABLE_EXTENSIONS,
  isExecutableHead,
  normalizeFileName,
  zipHeadNamesMacros,
} from '../files/file-safety.js';

/**
 * R21-f — the pure rules of 54-12 (inbound e-mail core) and 54-12a (the attachment rule).
 *
 * Nothing here touches a database, a clock or the network. The ingest service applies these to an
 * already-parsed message ({@link ParsedInboundMessage}), so the later IMAP poller or a JSON inbound
 * webhook feeds the same function unchanged.
 */

/** The receiving domain. `requests+<slug>-<6>@<INBOUND_DOMAIN>`. */
export const INBOUND_DOMAIN: string = (
  process.env['INBOUND_EMAIL_DOMAIN'] ?? 'tmanageapp.com'
).toLowerCase();

/** 54-12 Security: at most five attachments are recorded; the rest are counted and dropped. */
export const MAX_ATTACHMENTS = 5;
/** 54-12 Security: 10 MB per message; 54-12a: an attachment over this is `too_large`. */
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
/** 54-12 Security: per-address 100 messages an hour. */
export const PER_ADDRESS_PER_HOUR = 100;

const LOCAL_PREFIX = 'requests+';
const SUFFIX_PATTERN = /^[a-z0-9]{6}$/u;
/** `requests+` (9) + slug + `-` + 6 must fit `local_part VARCHAR(64)`. */
const MAX_SLUG_IN_LOCAL = 48;

export type AuthResult = 'pass' | 'fail' | 'none' | 'unknown';

/** R22-c — 54-12a rule (6): per-organization attachment bytes a day; past it a row is `too_large`. */
export const MAX_DAILY_ATTACHMENT_BYTES = 200 * 1024 * 1024;
/** R22-c — the largest webhook body read (the 10 MB message cap; base64 inflation counts). */
export const MAX_WEBHOOK_BODY_BYTES = 10 * 1024 * 1024;
/** R22-c — the head `attachmentState` sniffs. */
export const HEAD_BYTES = 4096;
/** R22-c — `x-inbound-timestamp` must be within this many seconds of the server clock. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * The full 54-12a vocabulary. Ingest writes `waiting_trust`, `too_large`, `blocked_type`,
 * `scanning` and (R22-c) `unavailable`; `clean` / `blocked_threat` are written by the scan pass
 * (slice d) only. `unavailable`: the bytes are not held — a trusted mail's attachments (a push has
 * no mailbox to re-fetch from; "ask the sender to re-send") or a passing mail that carried none.
 */
export type AttachmentState =
  'waiting_trust' | 'too_large' | 'blocked_type' | 'scanning' | 'unavailable';
export const ATTACHMENT_STATES: readonly string[] = [
  'waiting_trust',
  'too_large',
  'blocked_type',
  'scanning',
  'clean',
  'blocked_threat',
  'unavailable',
  'infected',
  'imported',
];

export type HeldReason =
  | 'dmarc_failed'
  | 'unknown_sender'
  | 'no_default_project'
  | 'project_not_shared'
  | 'member_hold_policy'
  | 'work_item_refused';
export const HELD_REASONS: readonly HeldReason[] = [
  'dmarc_failed',
  'unknown_sender',
  'no_default_project',
  'project_not_shared',
  'member_hold_policy',
  'work_item_refused',
];

export type InboundOutcome =
  | { readonly outcome: 'client_request' }
  | { readonly outcome: 'work_item' }
  | { readonly outcome: 'held'; readonly reason: HeldReason };

export interface ParsedInboundAttachment {
  readonly name: string;
  readonly sizeBytes: number;
  readonly declaredType: string | null;
  /** The first bytes when the fetcher has them; derived from {@link bytes} when absent. */
  readonly head: Buffer | null;
  /**
   * R22-c: the decoded bytes (the webhook decodes base64 once, after the body-size check).
   * `null`/absent when the fetcher has none. Dropped unwritten for a mail whose DMARC did not pass.
   */
  readonly bytes?: Buffer | null;
}

/**
 * R22-c — where a parked attachment's bytes live in the quarantine zone. Derived, never stored.
 * The inbound ADDRESS id stands in the `project` slot of `uploadObjectKey`: the key stays under
 * `tenant/{org}/` (so the erasure and usage walks see it) without a per-mail project (a held mail
 * has none). Slice d (scan, preview, download) imports this same function.
 */
export function attachmentObjectKey(
  organizationId: string,
  addressId: string,
  attachmentId: string,
): string {
  return uploadObjectKey({ organizationId, projectId: addressId, uploadId: attachmentId });
}

/**
 * R22-c — the webhook signature: `x-inbound-signature: v1=<hex HMAC-SHA256(secret,
 * timestamp + '.' + rawBody)>` and `x-inbound-timestamp` (unix seconds) within ±300 s. Any miss is
 * the one `invalid` — the answer never says which part failed. Constant-time comparison.
 */
export function verifyWebhookSignature(input: {
  readonly rawBody: Buffer | undefined;
  readonly signature: string | undefined;
  readonly timestamp: string | undefined;
  readonly secret: string;
  readonly now: Date;
}): 'valid' | 'invalid' {
  const { rawBody, signature, timestamp, secret } = input;
  if (rawBody === undefined || signature === undefined || timestamp === undefined) {
    return 'invalid';
  }
  if (!/^\d{1,12}$/u.test(timestamp)) return 'invalid';
  const skew = Math.abs(Math.floor(input.now.getTime() / 1000) - Number(timestamp));
  if (skew > WEBHOOK_TOLERANCE_SECONDS) return 'invalid';
  const match = /^v1=([0-9a-f]{64})$/u.exec(signature.trim());
  if (!match) return 'invalid';
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(rawBody)
    .digest();
  const given = Buffer.from(match[1] as string, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? 'valid' : 'invalid';
}

export interface FieldProblem {
  readonly field: string;
  readonly message: string;
}

const MAX_ADDRESS_FIELD = 1000;
const MAX_TEXT_PART = 1024 * 1024;
const MAX_HEADER_KEYS = 50;
const MAX_HEADER_VALUE = 8192;
const MAX_HEADER_VALUES = 20;
const MAX_DECLARED_ATTACHMENTS = 20;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * R22-c — the webhook's JSON body -> {@link ParsedInboundMessage}, or the list of problems (422).
 * Strings are bounded (subject 500, text/html 1 MiB each, header values 8 KiB, ≤ 50 header keys,
 * ≤ 20 declared attachments `{ name, contentType, size, contentBase64 }`). Only the first
 * {@link MAX_ATTACHMENTS} attachments are decoded; the rest are counted and dropped by ingest. A
 * decoded attachment's size is its byte count, never the declared `size`.
 */
export function parseWebhookBody(
  json: unknown,
  correlationId: string,
):
  | { readonly ok: true; readonly message: ParsedInboundMessage }
  | { readonly ok: false; readonly details: readonly FieldProblem[] } {
  const details: FieldProblem[] = [];
  if (!isRecord(json)) {
    return { ok: false, details: [{ field: 'body', message: 'must be a JSON object' }] };
  }
  const requiredString = (field: string, max: number): string => {
    const value = json[field];
    if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
      details.push({ field, message: `must be a non-empty string of at most ${String(max)}` });
      return '';
    }
    return value;
  };
  const optionalString = (field: string, max: number): string | null => {
    const value = json[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > max) {
      details.push({ field, message: `must be a string of at most ${String(max)} or null` });
      return null;
    }
    return value;
  };
  const to = requiredString('to', MAX_ADDRESS_FIELD);
  const from = requiredString('from', MAX_ADDRESS_FIELD);
  const messageId = optionalString('messageId', MAX_ADDRESS_FIELD);
  const date = optionalString('date', 200);
  const subject = optionalString('subject', 500);
  const text = optionalString('text', MAX_TEXT_PART);
  const html = optionalString('html', MAX_TEXT_PART);

  // No prototype: a `__proto__` header name stays a plain key.
  const headers = Object.create(null) as Record<string, string | readonly string[]>;
  const rawHeaders = json['headers'];
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (!isRecord(rawHeaders) || Object.keys(rawHeaders).length > MAX_HEADER_KEYS) {
      details.push({
        field: 'headers',
        message: `must be an object of at most ${String(MAX_HEADER_KEYS)} keys`,
      });
    } else {
      for (const [key, value] of Object.entries(rawHeaders)) {
        const okValue = (v: unknown): v is string =>
          typeof v === 'string' && v.length <= MAX_HEADER_VALUE;
        if (key.length > 200) {
          details.push({ field: 'headers', message: 'a header name is too long' });
        } else if (okValue(value)) {
          headers[key] = value;
        } else if (
          Array.isArray(value) &&
          value.length <= MAX_HEADER_VALUES &&
          value.every(okValue)
        ) {
          headers[key] = [...value];
        } else {
          details.push({ field: `headers.${key}`, message: 'must be a bounded string or list' });
        }
      }
    }
  }

  const attachments: ParsedInboundAttachment[] = [];
  const rawAttachments = json['attachments'];
  if (rawAttachments !== undefined && rawAttachments !== null) {
    if (!Array.isArray(rawAttachments) || rawAttachments.length > MAX_DECLARED_ATTACHMENTS) {
      details.push({
        field: 'attachments',
        message: `must be a list of at most ${String(MAX_DECLARED_ATTACHMENTS)}`,
      });
    } else {
      rawAttachments.forEach((entry: unknown, index) => {
        const field = `attachments[${String(index)}]`;
        if (!isRecord(entry)) {
          details.push({ field, message: 'must be an object' });
          return;
        }
        const name = entry['name'];
        const contentType = entry['contentType'];
        const size = entry['size'];
        const content = entry['contentBase64'];
        if (typeof name !== 'string' || name.trim() === '' || name.length > 255) {
          details.push({
            field: `${field}.name`,
            message: 'must be a non-empty string of at most 255',
          });
          return;
        }
        if (
          contentType !== undefined &&
          contentType !== null &&
          (typeof contentType !== 'string' || contentType.length > 127)
        ) {
          details.push({
            field: `${field}.contentType`,
            message: 'must be a string of at most 127 or null',
          });
          return;
        }
        if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > 0xffffffff) {
          details.push({ field: `${field}.size`, message: 'must be a non-negative integer' });
          return;
        }
        let bytes: Buffer | null = null;
        if (content !== undefined && content !== null) {
          const compact = typeof content === 'string' ? content.replace(/\s+/gu, '') : null;
          if (compact === null || compact.length % 4 !== 0 || !BASE64.test(compact)) {
            details.push({ field: `${field}.contentBase64`, message: 'must be base64 or null' });
            return;
          }
          // Decoded once, and only for the attachments ingest keeps.
          if (index < MAX_ATTACHMENTS) bytes = Buffer.from(compact, 'base64');
        }
        attachments.push({
          name,
          sizeBytes: bytes !== null ? bytes.length : size,
          declaredType: typeof contentType === 'string' ? contentType : null,
          head: bytes !== null ? bytes.subarray(0, HEAD_BYTES) : null,
          bytes,
        });
      });
    }
  }

  if (details.length > 0) return { ok: false, details };
  return {
    ok: true,
    message: {
      to,
      from,
      messageId,
      date,
      subject,
      text,
      html,
      headers,
      attachments,
      correlationId,
    },
  };
}

/** One message, already parsed by whatever fetched it. Header names are matched case-insensitively. */
export interface ParsedInboundMessage {
  readonly to: string;
  readonly from: string;
  readonly messageId: string | null;
  readonly date: string | null;
  /** Raw subject; RFC 2047 encoded-words are decoded here. */
  readonly subject: string | null;
  readonly text: string | null;
  readonly html: string | null;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly attachments: readonly ParsedInboundAttachment[];
  readonly correlationId: string;
}

/** `requests+<slug>-<6 lower alnum>`; the slug is lower-cased and cut to fit 64 characters. */
export function localPartFor(slug: string, random6: string): string {
  const suffix = random6.toLowerCase();
  if (!SUFFIX_PATTERN.test(suffix)) throw new Error('inbound address suffix must be 6 lower alnum');
  const cleanSlug = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, '')
    .slice(0, MAX_SLUG_IN_LOCAL);
  return `${LOCAL_PREFIX}${cleanSlug}-${suffix}`;
}

/** Six random lower-case alphanumerics from the given bytes (crypto random in production). */
export function suffixFrom(bytes: Buffer): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  return out;
}

/**
 * The local part of a recipient this server accepts, or `null`. Exactly one `@`, the domain equal to
 * {@link INBOUND_DOMAIN} (case-folded), and the local part `requests+<slug>-<6>`; a bare `requests@`
 * or another domain is refused. `Name <addr>` is unwrapped.
 */
export function parseRecipient(address: string, domain: string = INBOUND_DOMAIN): string | null {
  const angle = /<([^<>]*)>\s*$/u.exec(address);
  const bare = (angle?.[1] ?? address).trim().toLowerCase();
  const parts = bare.split('@');
  if (parts.length !== 2) return null;
  const [local, host] = parts as [string, string];
  if (host !== domain.toLowerCase() || local.length > 64) return null;
  if (!local.startsWith(LOCAL_PREFIX)) return null;
  const rest = local.slice(LOCAL_PREFIX.length);
  const dash = rest.lastIndexOf('-');
  if (dash <= 0) return null;
  const slug = rest.slice(0, dash);
  const suffix = rest.slice(dash + 1);
  if (!/^[a-z0-9-]+$/u.test(slug) || !SUFFIX_PATTERN.test(suffix)) return null;
  return local;
}

/** A plain e-mail address from `Name <addr>` or `addr`, lower-cased; `null` when malformed. */
export function senderAddress(from: string): string | null {
  const angle = /<([^<>]*)>\s*$/u.exec(from);
  const bare = (angle?.[1] ?? from).trim().toLowerCase();
  if (bare.length > 320 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(bare)) return null;
  return bare;
}

function decodeQ(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (ch === '_') bytes.push(0x20);
    else if (ch === '=' && /^[0-9A-Fa-f]{2}$/u.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/gu;

/**
 * RFC 2047: `=?charset?B?…?=` and `=?charset?Q?…?=` decoded (UTF-8 and Latin-1; another charset is
 * decoded as UTF-8). Whitespace between two adjacent encoded-words is dropped, as the RFC says.
 */
export function decodeRfc2047(subject: string): string {
  const joined = subject.replace(/(\?=)\s+(=\?)/gu, '$1$2');
  return joined.replace(ENCODED_WORD, (_m, charset: string, encoding: string, text: string) => {
    const bytes = encoding.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : decodeQ(text);
    const cs = charset.toLowerCase().split('*')[0];
    return cs === 'iso-8859-1' || cs === 'latin1'
      ? bytes.toString('latin1')
      : bytes.toString('utf8');
  });
}

/** A header's values, matched case-insensitively. */
export function headerValues(
  headers: Readonly<Record<string, string | readonly string[]>>,
  name: string,
): string[] {
  const wanted = name.toLowerCase();
  const out: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === 'string') out.push(value);
    else out.push(...value);
  }
  return out;
}

/** DMARC from `Authentication-Results` (`dmarc=pass|fail|none`); anything else is `unknown`. */
export function authResultOf(
  headers: Readonly<Record<string, string | readonly string[]>>,
): AuthResult {
  let seen: AuthResult = 'unknown';
  for (const value of headerValues(headers, 'authentication-results')) {
    const match = /\bdmarc\s*=\s*(pass|fail|none)\b/iu.exec(value);
    if (!match) continue;
    const result = (match[1] as string).toLowerCase() as AuthResult;
    // One failing verdict among several results wins: never trust the friendliest header.
    if (result === 'fail') return 'fail';
    if (result === 'none' || seen === 'unknown') seen = result;
  }
  return seen;
}

/** SHA-256 hex of the Message-ID, or of from + date + subject when there is none. */
export function messageIdHash(
  messageId: string | null,
  fallback: {
    readonly from: string;
    readonly date: string | null;
    readonly subject: string | null;
  },
): string {
  const id = messageId?.trim().replace(/^<|>$/gu, '').toLowerCase() ?? '';
  const basis =
    id !== ''
      ? `mid:${id}`
      : `fb:${fallback.from.toLowerCase()}\n${fallback.date ?? ''}\n${fallback.subject ?? ''}`;
  return createHash('sha256').update(basis, 'utf8').digest('hex');
}

const ACTIVE_HEAD = /^\s*(<\?xml[^>]*>\s*)?(<!doctype\s+html|<html|<svg|<script)/iu;
const ACTIVE_TYPES = new Set([
  'image/svg+xml',
  'text/html',
  'message/rfc822',
  'application/xhtml+xml',
]);
const ACTIVE_EXTENSIONS = new Set(['svg', 'svgz', 'html', 'htm', 'xhtml', 'eml', 'mht', 'mhtml']);
const MACRO_EXTENSIONS = new Set([
  'docm',
  'dotm',
  'xlsm',
  'xltm',
  'xlam',
  'xlsb',
  'pptm',
  'potm',
  'ppsm',
  'ppam',
  'sldm',
]);
/** RFC 822 headers at the very start: an attached message. */
const EML_HEAD = /^(received|return-path|from|message-id|mime-version|delivered-to):/iu;

/** 54-12a rule: the state an attachment's metadata row starts in. Never `clean` (no scanner here). */
export function attachmentState(input: {
  readonly sizeBytes: number;
  readonly declaredType: string | null;
  readonly name: string;
  readonly head: Buffer | null;
  readonly authResult: AuthResult;
}): AttachmentState {
  if (input.authResult !== 'pass') return 'waiting_trust';
  if (input.sizeBytes > MAX_MESSAGE_BYTES) return 'too_large';
  const segments = normalizeFileName(input.name).toLowerCase().split('.');
  const extensions = segments.slice(1);
  const last = extensions[extensions.length - 1] ?? '';
  const declared = (input.declaredType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (
    extensions.some(
      (ext) => EXECUTABLE_EXTENSIONS.has(ext) && (ext !== 'bin' || extensions.length > 1),
    ) ||
    MACRO_EXTENSIONS.has(last) ||
    ACTIVE_EXTENSIONS.has(last) ||
    ACTIVE_TYPES.has(declared)
  ) {
    return 'blocked_type';
  }
  if (input.head !== null) {
    const text = input.head.subarray(0, 1024).toString('latin1');
    if (
      isExecutableHead(input.head) ||
      zipHeadNamesMacros(input.head) ||
      ACTIVE_HEAD.test(text) ||
      EML_HEAD.test(text)
    ) {
      return 'blocked_type';
    }
  }
  return 'scanning';
}

/** The one sender lookup's answer: a client user of this organization, or nobody. */
export interface SenderClient {
  readonly clientOrganizationId: string;
  readonly userId: string;
}

/** R22-c: the sender as an active internal member of this organization. */
export interface SenderMember {
  readonly userId: string;
  readonly membershipId: string;
}

/** R22-c: what a passing member's mail becomes (`policy_json.member_outcome`, default `work_item`). */
export type MemberOutcomePolicy = 'work_item' | 'hold';

/** `policy_json.member_outcome`, defaulting to `work_item` on anything else or unreadable JSON. */
export function memberOutcomeOf(policyJson: string | null): MemberOutcomePolicy {
  try {
    const parsed: unknown = JSON.parse(policyJson ?? '{}');
    return isRecord(parsed) && parsed['member_outcome'] === 'hold' ? 'hold' : 'work_item';
  } catch {
    return 'work_item';
  }
}

/**
 * 54-12: a client request only for a DMARC-passing known client on a shared default project; a
 * work item (R22-c) for a DMARC-passing internal member when the address has a default project and
 * the policy does not say `hold`. A sender who is both is treated as the client: a client contact
 * is the narrower audience.
 */
export function decideOutcome(input: {
  readonly authResult: AuthResult;
  readonly senderClient: SenderClient | null;
  readonly senderMember?: SenderMember | null;
  readonly memberOutcome?: MemberOutcomePolicy;
  readonly defaultProjectId: string | null;
  readonly projectShared: boolean;
}): InboundOutcome {
  if (input.authResult !== 'pass') return { outcome: 'held', reason: 'dmarc_failed' };
  if (input.senderClient === null) {
    const member = input.senderMember ?? null;
    if (member === null) return { outcome: 'held', reason: 'unknown_sender' };
    if ((input.memberOutcome ?? 'work_item') === 'hold') {
      return { outcome: 'held', reason: 'member_hold_policy' };
    }
    if (input.defaultProjectId === null) return { outcome: 'held', reason: 'no_default_project' };
    return { outcome: 'work_item' };
  }
  if (input.defaultProjectId === null) return { outcome: 'held', reason: 'no_default_project' };
  if (!input.projectShared) return { outcome: 'held', reason: 'project_not_shared' };
  return { outcome: 'client_request' };
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * HTML part -> plain text for the request description. `sanitizeRichText` (domain) validates a
 * rich-text document, not HTML, so the HTML part is reduced to text here: script/style/head blocks
 * are removed with their content, every tag is dropped (so no image or link is ever fetched or kept
 * live), entities are decoded, and whitespace is collapsed. The result is stored and shown as text.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style|head|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<(script|style|head|template|noscript)\b[^>]*>[\s\S]*$/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/<[^>]*$/u, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, ref: string) => {
      if (ref.startsWith('#x') || ref.startsWith('#X')) {
        const code = parseInt(ref.slice(2), 16);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      if (ref.startsWith('#')) {
        const code = parseInt(ref.slice(1), 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[ref.toLowerCase()] ?? whole;
    })
    .replace(/[<>]/gu, ' ')
    .replace(/[ \t\f\v\r]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** The body kept for the log and the request: the HTML part as text, else the text part. */
export function bodyOf(message: Pick<ParsedInboundMessage, 'html' | 'text'>, max = 20_000): string {
  const html =
    message.html !== null && message.html.trim() !== '' ? htmlToPlainText(message.html) : '';
  const text = html !== '' ? html : (message.text ?? '').replace(/\r\n?/gu, '\n').trim();
  return text.slice(0, max);
}
