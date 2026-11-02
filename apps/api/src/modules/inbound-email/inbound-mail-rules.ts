import { createHash } from 'node:crypto';
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
  process.env['INBOUND_EMAIL_DOMAIN'] ?? 'tmanage.peetrix.com'
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

/** 54-12a states this slice can produce. `clean` needs a scanner and bytes: never set here. */
export type AttachmentState = 'waiting_trust' | 'too_large' | 'blocked_type' | 'scanning';
export const ATTACHMENT_STATES: readonly string[] = [
  'waiting_trust',
  'too_large',
  'blocked_type',
  'scanning',
  'clean',
  'infected',
  'imported',
];

export type HeldReason =
  'dmarc_failed' | 'unknown_sender' | 'no_default_project' | 'project_not_shared';
export const HELD_REASONS: readonly HeldReason[] = [
  'dmarc_failed',
  'unknown_sender',
  'no_default_project',
  'project_not_shared',
];

export type InboundOutcome =
  | { readonly outcome: 'client_request' }
  | { readonly outcome: 'held'; readonly reason: HeldReason };

export interface ParsedInboundAttachment {
  readonly name: string;
  readonly sizeBytes: number;
  readonly declaredType: string | null;
  /** The first bytes when the fetcher has them; `null` until bytes exist (this slice). */
  readonly head: Buffer | null;
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

/** 54-12: a client request only for a DMARC-passing known client on a shared default project. */
export function decideOutcome(input: {
  readonly authResult: AuthResult;
  readonly senderClient: SenderClient | null;
  readonly defaultProjectId: string | null;
  readonly projectShared: boolean;
}): InboundOutcome {
  if (input.authResult !== 'pass') return { outcome: 'held', reason: 'dmarc_failed' };
  if (input.senderClient === null) return { outcome: 'held', reason: 'unknown_sender' };
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
