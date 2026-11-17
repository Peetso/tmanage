/**
 * 56-26 — reading a delivery status notification (RFC 3464 `multipart/report;
 * report-type=delivery-status`) from the raw bytes of a bounce.
 *
 * Defensive by construction, because the bytes come from outside:
 *
 * - at most {@link MAX_BOUNCE_BYTES}, at most {@link MAX_DEPTH} levels of MIME nesting and
 *   {@link MAX_PARTS} parts in all, at most {@link MAX_HEADER_LINES} header lines per entity;
 * - the bytes are read as latin1 (one character per byte, never a decode error); only
 *   `indexOf` / `split` on fixed strings and anchored patterns without nested quantifiers, so no
 *   input can make a pattern backtrack;
 * - nothing is rendered: the report yields a kind, a status code and the `Message-ID`s it quotes.
 *   Which message (and so which company and address) it is about is decided later, by the signed
 *   id alone (`bounce-id.ts`) — never by `Final-Recipient` or any other address in the report.
 *
 * ## Hard or soft
 *
 * Per recipient: `Action: failed` with a 5.1.x status (bad mailbox, bad domain, no such address) or
 * 5.2.1 (mailbox disabled) is **hard** — the address will not take mail. Any other `failed`
 * (policy, content, mailbox full 5.2.2, a 4.x.x the reporter gave up on) and every `Action: delayed`
 * is **soft**. `delivered`, `relayed` and `expanded` are not bounces. The worst recipient decides.
 */

export type BounceKind = 'hard' | 'soft';

export interface DeliveryReport {
  readonly kind: BounceKind;
  /** The RFC 3463 status of the worst recipient, e.g. `5.1.1`. */
  readonly status: string;
  /** The `Message-ID`s of the original message the report quotes (at most 8). */
  readonly messageIds: readonly string[];
}

export const MAX_BOUNCE_BYTES = 1024 * 1024;
const MAX_DEPTH = 4;
const MAX_PARTS = 32;
const MAX_HEADER_LINES = 300;
const MAX_HEADER_VALUE = 4096;
const MAX_CANDIDATES = 8;
const MAX_MESSAGE_ID = 300;
const STATUS = /^([245])\.(\d{1,3})\.(\d{1,3})$/u;
const BOUNDARY = /^[0-9A-Za-z'()+_,./:=? -]{1,70}$/u;

type Headers = ReadonlyMap<string, string>;

interface Walk {
  parts: number;
  sawReport: boolean;
  worst: { kind: BounceKind; status: string } | null;
  readonly messageIds: string[];
}

/** Header fields of one entity (first value of each name), unfolded, names lower-cased. */
function parseHeaders(text: string): Headers {
  const out = new Map<string, string>();
  let name: string | null = null;
  let value = '';
  const flush = () => {
    if (name !== null && !out.has(name)) out.set(name, value.trim().slice(0, MAX_HEADER_VALUE));
  };
  const lines = text.split('\n');
  for (const line of lines.slice(0, MAX_HEADER_LINES)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && name !== null) {
      if (value.length < MAX_HEADER_VALUE) value += ` ${line.trim()}`;
      continue;
    }
    flush();
    const colon = line.indexOf(':');
    if (colon <= 0) {
      name = null;
      continue;
    }
    name = line.slice(0, colon).trim().toLowerCase();
    value = line.slice(colon + 1);
  }
  flush();
  return out;
}

function splitEntity(text: string): { readonly head: string; readonly body: string } {
  const end = text.indexOf('\n\n');
  return end === -1
    ? { head: text, body: '' }
    : { head: text.slice(0, end), body: text.slice(end + 2) };
}

interface ContentType {
  readonly type: string;
  readonly params: ReadonlyMap<string, string>;
}

function contentType(value: string | undefined): ContentType {
  const [first = '', ...rest] = (value ?? 'text/plain').split(';');
  const params = new Map<string, string>();
  for (const piece of rest.slice(0, 20)) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    let paramValue = piece.slice(eq + 1).trim();
    if (paramValue.length >= 2 && paramValue.startsWith('"') && paramValue.endsWith('"')) {
      paramValue = paramValue.slice(1, -1);
    }
    params.set(piece.slice(0, eq).trim().toLowerCase(), paramValue);
  }
  return { type: first.trim().toLowerCase(), params };
}

function decodeBody(body: string, encoding: string | undefined): string {
  const cte = (encoding ?? '').trim().toLowerCase();
  if (cte === 'base64') {
    return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/gu, ''), 'base64').toString('latin1');
  }
  if (cte === 'quoted-printable') {
    return body
      .replace(/=\n/gu, '')
      .replace(/=([0-9A-Fa-f]{2})/gu, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
  }
  return body;
}

/** The parts of a multipart body, at most what the walk still allows. */
function multipartParts(body: string, boundary: string, walk: Walk): string[] {
  const delimiter = `\n--${boundary}`;
  const text = `\n${body}`;
  const parts: string[] = [];
  let at = text.indexOf(delimiter);
  while (at !== -1 && walk.parts < MAX_PARTS) {
    const after = at + delimiter.length;
    if (text.startsWith('--', after)) break; // the close delimiter
    const lineEnd = text.indexOf('\n', after);
    if (lineEnd === -1) break;
    const next = text.indexOf(delimiter, lineEnd);
    parts.push(text.slice(lineEnd + 1, next === -1 ? text.length : next));
    walk.parts += 1;
    at = next;
  }
  return parts;
}

function classify(action: string, status: string): BounceKind | null {
  const match = STATUS.exec(status);
  if (action === 'delayed') return 'soft';
  if (action !== 'failed' || match === null) return null;
  const [, klass, subject, detail] = match;
  if (klass === '2') return null;
  if (klass === '5' && (subject === '1' || (subject === '2' && detail === '1'))) return 'hard';
  return 'soft';
}

function readDeliveryStatus(text: string, walk: Walk): void {
  // Groups are separated by blank lines; the per-message group carries no `Action` and is skipped.
  const groups = text.split(/\n[ \t]*\n/u).slice(0, MAX_PARTS);
  for (const group of groups) {
    const fields = parseHeaders(group);
    const action = (fields.get('action') ?? '').toLowerCase();
    const status = (fields.get('status') ?? '').split(/[ \t(]/u)[0] ?? '';
    const kind = classify(action, status);
    if (kind === null) continue;
    const code = STATUS.test(status) ? status : '4.0.0';
    if (walk.worst === null || (kind === 'hard' && walk.worst.kind === 'soft')) {
      walk.worst = { kind, status: code };
    }
  }
}

function collectMessageId(headers: Headers, walk: Walk): void {
  const id = headers.get('message-id');
  if (id === undefined || id.length === 0 || id.length > MAX_MESSAGE_ID) return;
  if (walk.messageIds.length < MAX_CANDIDATES && !walk.messageIds.includes(id)) {
    walk.messageIds.push(id);
  }
}

function walkEntity(text: string, depth: number, walk: Walk): void {
  const { head, body } = splitEntity(text);
  const headers = parseHeaders(head);
  const type = contentType(headers.get('content-type'));
  const encoding = headers.get('content-transfer-encoding');

  if (type.type.startsWith('multipart/')) {
    const boundary = type.params.get('boundary');
    if (depth >= MAX_DEPTH || boundary === undefined || !BOUNDARY.test(boundary)) return;
    if (
      type.type === 'multipart/report' &&
      (type.params.get('report-type') ?? '').toLowerCase() === 'delivery-status'
    ) {
      walk.sawReport = true;
    }
    for (const part of multipartParts(body, boundary, walk)) walkEntity(part, depth + 1, walk);
    return;
  }
  if (type.type === 'message/delivery-status') {
    readDeliveryStatus(decodeBody(body, encoding).replace(/\r\n/gu, '\n'), walk);
    return;
  }
  if (type.type === 'text/rfc822-headers') {
    collectMessageId(parseHeaders(splitEntity(decodeBody(body, encoding)).head), walk);
    return;
  }
  if (type.type === 'message/rfc822' && depth < MAX_DEPTH) {
    const inner = decodeBody(body, encoding);
    collectMessageId(parseHeaders(splitEntity(inner).head), walk);
    // A forwarder may wrap the whole bounce in one more message: look inside it too.
    walkEntity(inner, depth + 1, walk);
  }
}

/**
 * The delivery report in a raw bounce, or `null` when the bytes are not an RFC 3464 report, report
 * nothing that is a bounce, or quote no `Message-ID`.
 */
export function parseDeliveryReport(raw: Uint8Array): DeliveryReport | null {
  if (raw.length === 0 || raw.length > MAX_BOUNCE_BYTES) return null;
  const text = Buffer.from(raw).toString('latin1').replace(/\r\n/gu, '\n');
  const walk: Walk = { parts: 0, sawReport: false, worst: null, messageIds: [] };
  walkEntity(text, 0, walk);
  if (!walk.sawReport || walk.worst === null || walk.messageIds.length === 0) return null;
  return { kind: walk.worst.kind, status: walk.worst.status, messageIds: walk.messageIds };
}
