/**
 * 56-26 — the bounded MIME reading shared by the report parsers that read mail from outside: the
 * delivery report (`bounce-report.ts`, RFC 3464) and the feedback report (`feedback-report.ts`,
 * RFC 5965 ARF).
 *
 * Defensive by construction: the text is latin1 (one character per byte, never a decode error),
 * line endings already `\n`; at most {@link MAX_DEPTH} levels of nesting, {@link MAX_PARTS} parts
 * in all, {@link MAX_HEADER_LINES} header lines per entity, {@link MAX_HEADER_VALUE} characters per
 * value. Only `indexOf` / `split` on fixed strings and anchored patterns without nested
 * quantifiers, so no input can make a pattern backtrack.
 */

export const MAX_REPORT_BYTES = 1024 * 1024;
export const MAX_DEPTH = 4;
export const MAX_PARTS = 32;
const MAX_HEADER_LINES = 300;
const MAX_HEADER_VALUE = 4096;
const MAX_CANDIDATES = 8;
const MAX_MESSAGE_ID = 300;
const BOUNDARY = /^[0-9A-Za-z'()+_,./:=? -]{1,70}$/u;

export type Headers = ReadonlyMap<string, string>;

/** The parts already taken from every multipart body of one message. */
export interface PartBudget {
  parts: number;
}

/** The raw bytes as `\n`-ended latin1 text, or `null` when empty or over the size limit. */
export function reportText(raw: Uint8Array): string | null {
  if (raw.length === 0 || raw.length > MAX_REPORT_BYTES) return null;
  return Buffer.from(raw).toString('latin1').replace(/\r\n/gu, '\n');
}

/** Header fields of one entity (first value of each name), unfolded, names lower-cased. */
export function parseHeaders(text: string): Headers {
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

export function splitEntity(text: string): { readonly head: string; readonly body: string } {
  const end = text.indexOf('\n\n');
  return end === -1
    ? { head: text, body: '' }
    : { head: text.slice(0, end), body: text.slice(end + 2) };
}

export interface ContentType {
  readonly type: string;
  readonly params: ReadonlyMap<string, string>;
}

export function contentType(value: string | undefined): ContentType {
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

/** Whether this is `multipart/report` with the given `report-type`. */
export function isReport(type: ContentType, reportType: string): boolean {
  return (
    type.type === 'multipart/report' &&
    (type.params.get('report-type') ?? '').toLowerCase() === reportType
  );
}

export function decodeBody(body: string, encoding: string | undefined): string {
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

/**
 * The parts of a multipart body, at most what the budget still allows; empty when the nesting is
 * too deep or the boundary is missing or not a valid one.
 */
export function multipartParts(
  body: string,
  type: ContentType,
  depth: number,
  budget: PartBudget,
): string[] {
  const boundary = type.params.get('boundary');
  if (depth >= MAX_DEPTH || boundary === undefined || !BOUNDARY.test(boundary)) return [];
  const delimiter = `\n--${boundary}`;
  const text = `\n${body}`;
  const parts: string[] = [];
  let at = text.indexOf(delimiter);
  while (at !== -1 && budget.parts < MAX_PARTS) {
    const after = at + delimiter.length;
    if (text.startsWith('--', after)) break; // the close delimiter
    const lineEnd = text.indexOf('\n', after);
    if (lineEnd === -1) break;
    const next = text.indexOf(delimiter, lineEnd);
    parts.push(text.slice(lineEnd + 1, next === -1 ? text.length : next));
    budget.parts += 1;
    at = next;
  }
  return parts;
}

/** Adds the entity's `Message-ID` to the candidates (at most 8, each at most 300 characters). */
export function collectMessageId(headers: Headers, into: string[]): void {
  const id = headers.get('message-id');
  if (id === undefined || id.length === 0 || id.length > MAX_MESSAGE_ID) return;
  if (into.length < MAX_CANDIDATES && !into.includes(id)) into.push(id);
}
