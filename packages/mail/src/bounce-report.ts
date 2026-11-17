import {
  MAX_DEPTH,
  MAX_PARTS,
  MAX_REPORT_BYTES,
  collectMessageId,
  contentType,
  decodeBody,
  isReport,
  multipartParts,
  parseHeaders,
  reportText,
  splitEntity,
} from './mime-report.js';
import type { PartBudget } from './mime-report.js';

/**
 * 56-26 — reading a delivery status notification (RFC 3464 `multipart/report;
 * report-type=delivery-status`) from the raw bytes of a bounce.
 *
 * Defensive by construction, because the bytes come from outside:
 *
 * - the bounded MIME reading of `mime-report.ts` (size, depth, parts, header lines, latin1, no
 *   backtracking patterns);
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

export const MAX_BOUNCE_BYTES = MAX_REPORT_BYTES;
const STATUS = /^([245])\.(\d{1,3})\.(\d{1,3})$/u;

interface Walk extends PartBudget {
  sawReport: boolean;
  worst: { kind: BounceKind; status: string } | null;
  readonly messageIds: string[];
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

function walkEntity(text: string, depth: number, walk: Walk): void {
  const { head, body } = splitEntity(text);
  const headers = parseHeaders(head);
  const type = contentType(headers.get('content-type'));
  const encoding = headers.get('content-transfer-encoding');

  if (type.type.startsWith('multipart/')) {
    const parts = multipartParts(body, type, depth, walk);
    if (parts.length > 0 && isReport(type, 'delivery-status')) walk.sawReport = true;
    for (const part of parts) walkEntity(part, depth + 1, walk);
    return;
  }
  if (type.type === 'message/delivery-status') {
    readDeliveryStatus(decodeBody(body, encoding).replace(/\r\n/gu, '\n'), walk);
    return;
  }
  if (type.type === 'text/rfc822-headers') {
    collectMessageId(parseHeaders(splitEntity(decodeBody(body, encoding)).head), walk.messageIds);
    return;
  }
  if (type.type === 'message/rfc822' && depth < MAX_DEPTH) {
    const inner = decodeBody(body, encoding);
    collectMessageId(parseHeaders(splitEntity(inner).head), walk.messageIds);
    // A forwarder may wrap the whole bounce in one more message: look inside it too.
    walkEntity(inner, depth + 1, walk);
  }
}

/**
 * The delivery report in a raw bounce, or `null` when the bytes are not an RFC 3464 report, report
 * nothing that is a bounce, or quote no `Message-ID`.
 */
export function parseDeliveryReport(raw: Uint8Array): DeliveryReport | null {
  const text = reportText(raw);
  if (text === null) return null;
  const walk: Walk = { parts: 0, sawReport: false, worst: null, messageIds: [] };
  walkEntity(text, 0, walk);
  if (!walk.sawReport || walk.worst === null || walk.messageIds.length === 0) return null;
  return { kind: walk.worst.kind, status: walk.worst.status, messageIds: walk.messageIds };
}
