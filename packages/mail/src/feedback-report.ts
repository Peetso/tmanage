import {
  MAX_DEPTH,
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
 * 56-26 (ARF) — reading a feedback-loop spam complaint (RFC 5965 Abuse Reporting Format:
 * `multipart/report; report-type=feedback-report`, whose machine part is
 * `message/feedback-report` and whose third part returns the original message or its headers).
 *
 * The sibling of `bounce-report.ts`, on the same bounded MIME reading (`mime-report.ts`). Nothing
 * the report claims decides anything: it yields the feedback type, the `Message-ID`s of the
 * returned original and the `Original-Rcpt-To` it names (if any). Which company and address the
 * complaint is about is decided by a quoted Message-ID that verifies under the bounce key
 * (`bounce-id.ts`) alone; `Original-Rcpt-To` may only make a match fail, never make one.
 *
 * Only `abuse` (marked as spam) and `fraud` (reported as phishing) are complaints; `not-spam`,
 * `virus`, `auth-failure`, `other` and anything unknown are not.
 */

export type FeedbackType = 'abuse' | 'fraud';

export interface FeedbackReport {
  readonly feedbackType: FeedbackType;
  /** The `Message-ID`s of the returned original (at most 8). */
  readonly messageIds: readonly string[];
  /** The lower-cased `Original-Rcpt-To` address, or `null` when absent or redacted. */
  readonly originalRcptTo: string | null;
}

const MAX_ADDRESS = 320;

interface Walk extends PartBudget {
  sawReport: boolean;
  feedbackType: string | null;
  originalRcptTo: string | null;
  readonly messageIds: string[];
}

function isFeedbackType(value: string | null): value is FeedbackType {
  return value === 'abuse' || value === 'fraud';
}

/** `<a@b>` or `a@b` as `a@b`; `null` for anything that is not one plain address. */
function plainAddress(value: string | undefined): string | null {
  if (value === undefined) return null;
  let address = value.trim();
  if (address.startsWith('<') && address.endsWith('>')) address = address.slice(1, -1).trim();
  const at = address.indexOf('@');
  if (address.length > MAX_ADDRESS || at <= 0 || at !== address.lastIndexOf('@')) return null;
  if (at === address.length - 1 || /[\s<>,;"]/u.test(address)) return null;
  return address.toLowerCase();
}

function readFeedbackFields(text: string, walk: Walk): void {
  const fields = parseHeaders(text);
  const feedbackType = fields.get('feedback-type');
  if (walk.feedbackType === null && feedbackType !== undefined) {
    walk.feedbackType = feedbackType.toLowerCase();
  }
  walk.originalRcptTo ??= plainAddress(fields.get('original-rcpt-to'));
}

function walkEntity(text: string, depth: number, walk: Walk): void {
  const { head, body } = splitEntity(text);
  const headers = parseHeaders(head);
  const type = contentType(headers.get('content-type'));
  const encoding = headers.get('content-transfer-encoding');

  if (type.type.startsWith('multipart/')) {
    const parts = multipartParts(body, type, depth, walk);
    if (parts.length > 0 && isReport(type, 'feedback-report')) walk.sawReport = true;
    for (const part of parts) walkEntity(part, depth + 1, walk);
    return;
  }
  if (type.type === 'message/feedback-report') {
    readFeedbackFields(decodeBody(body, encoding).replace(/\r\n/gu, '\n'), walk);
    return;
  }
  if (type.type === 'text/rfc822-headers') {
    collectMessageId(parseHeaders(splitEntity(decodeBody(body, encoding)).head), walk.messageIds);
    return;
  }
  if (type.type === 'message/rfc822' && depth < MAX_DEPTH) {
    const inner = decodeBody(body, encoding).replace(/\r\n/gu, '\n');
    collectMessageId(parseHeaders(splitEntity(inner).head), walk.messageIds);
    // A forwarder may wrap the whole report in one more message: look inside it too.
    walkEntity(inner, depth + 1, walk);
  }
}

/**
 * The complaint in a raw feedback-loop report, or `null` when the bytes are not an ARF report,
 * the feedback type is not a complaint, or no `Message-ID` of the original is returned.
 */
export function parseFeedbackReport(raw: Uint8Array): FeedbackReport | null {
  const text = reportText(raw);
  if (text === null) return null;
  const walk: Walk = {
    parts: 0,
    sawReport: false,
    feedbackType: null,
    originalRcptTo: null,
    messageIds: [],
  };
  walkEntity(text, 0, walk);
  const feedbackType = walk.feedbackType;
  if (!walk.sawReport || !isFeedbackType(feedbackType) || walk.messageIds.length === 0) {
    return null;
  }
  return { feedbackType, messageIds: walk.messageIds, originalRcptTo: walk.originalRcptTo };
}
