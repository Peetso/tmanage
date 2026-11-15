import { createHash } from 'node:crypto';
import { ApiError } from '../../common/http/errors.js';
import type {
  SignatureRequestRow,
  SignatureRequestSignerRow,
} from '../../common/database/schema.js';

/**
 * 52-26 — simple electronic signature, as pure rules and views. No I/O.
 *
 * A request pins one deliverable version's SHA-256; named client contacts sign it in the portal with
 * a typed name or a drawn mark, an explicit consent sentence and a one-time e-mail code. The code is
 * an HMAC (the public-link pepper, `PublicLinkSecrets`), lives 10 minutes, allows 5 wrong tries, and
 * new codes are limited to one a minute and 5 an hour. The signature is sealed as a 52-19
 * `approval_records` row (`decision = 'signed'`).
 */

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_RESEND_MS = 60_000;
export const CODES_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;

/** Default and largest request lifetime. */
export const DEFAULT_EXPIRY_DAYS = 7;
export const MAX_EXPIRY_DAYS = 30;
export const MAX_SIGNERS = 10;
export const MAX_TYPED_NAME = 120;
const MAX_TITLE = 200;

/** A drawn mark: a PNG of at most 200 KB and 2000 × 1000 pixels. */
export const MARK_MAX_BYTES = 200 * 1024;
const MARK_MAX_WIDTH = 2000;
const MARK_MAX_HEIGHT = 1000;

/** The consent sentence the signer ticks, sealed into the record with its version. */
export const CONSENT_TEXT_VERSION = 'esign-consent-v1';
export const CONSENT_TEXT = 'I agree to sign this document electronically.';

export type SignatureState = 'pending' | 'signed' | 'expired' | 'cancelled';
export type SignatureMethod = 'typed' | 'drawn';

/** The portal's view of one request addressed to the caller. */
export interface PortalSignatureView {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly deliverableVersionId: string;
  readonly fileVersionId: string | null;
  readonly organizationName: string;
  readonly state: SignatureState;
  readonly signedAt: string | null;
  readonly expiresAt: string;
  /** The signer's e-mail, masked (`l•••@example.com`). */
  readonly emailHint: string;
  /** A code was sent and is still live. */
  readonly codeLive: boolean;
  readonly signerName: string;
  readonly consentText: string;
  readonly consentTextVersion: string;
}

export interface PortalSignatureListView {
  readonly requests: readonly PortalSignatureView[];
}

export interface SignatureCodeSentView {
  readonly emailHint: string;
  readonly expiresInSeconds: number;
  readonly resendAfterSeconds: number;
}

/** The sealed record of one signer, as the team sees it. */
export interface SignatureRecordSummary {
  readonly recordNo: number;
  readonly recordHash: string;
  /** Hash, chain link and signature all hold. */
  readonly intact: boolean;
  readonly email: string;
  readonly method: SignatureMethod;
  readonly typedName: string | null;
  readonly codeVerifiedAt: string;
  readonly signedAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly contentHash: string;
  readonly consentTextVersion: string;
}

export interface SignatureSignerView {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly clientOrganizationName: string;
  readonly status: 'pending' | 'signed';
  readonly viewedAt: string | null;
  readonly signedAt: string | null;
  readonly record: SignatureRecordSummary | null;
}

export interface SignatureRequestView {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly deliverableId: string;
  readonly deliverableVersionId: string;
  readonly contentHash: string;
  /** The version still hashes to what the request pinned. */
  readonly documentUnchanged: boolean;
  readonly state: 'pending' | 'completed' | 'cancelled' | 'expired';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly signedCount: number;
  readonly signers: readonly SignatureSignerView[];
}

export interface SignatureRequestListView {
  readonly requests: readonly SignatureRequestView[];
}

export function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'Check the signature and try again.', [
    { field, message },
  ]);
}

export function conflict(reason: string): ApiError {
  return new ApiError(409, 'conflict', 'This signature request cannot be signed now.', [
    { field: 'request', message: reason },
  ]);
}

/** The request as a whole: cancelled and completed win over the clock. */
export function requestState(
  row: SignatureRequestRow,
  at: Date,
): 'pending' | 'completed' | 'cancelled' | 'expired' {
  if (row.status !== 'pending') return row.status;
  return row.expiresAt.getTime() <= at.getTime() ? 'expired' : 'pending';
}

/** One signer's state: their own signature first, then the request's. */
export function signerState(
  request: SignatureRequestRow,
  signer: SignatureRequestSignerRow,
  at: Date,
): SignatureState {
  if (signer.status === 'signed') return 'signed';
  const state = requestState(request, at);
  return state === 'completed' ? 'signed' : state;
}

/** Why a code may not be sent now, or `null` (and the window to write back). */
export function codeSendRefusal(
  signer: SignatureRequestSignerRow,
  at: Date,
): { readonly refused: ApiError | null; readonly windowStart: Date; readonly inWindow: number } {
  const fresh =
    signer.codeWindowStartedAt === null ||
    at.getTime() - signer.codeWindowStartedAt.getTime() >= HOUR_MS;
  const windowStart = fresh ? at : (signer.codeWindowStartedAt as Date);
  const inWindow = fresh ? 0 : signer.codesInWindow;
  const tooSoon =
    signer.codeSentAt !== null && at.getTime() - signer.codeSentAt.getTime() < CODE_RESEND_MS;
  const refused =
    tooSoon || inWindow >= CODES_PER_HOUR
      ? new ApiError(429, 'rate_limited', 'Too many codes. Wait a moment and try again.')
      : null;
  return { refused, windowStart, inWindow: inWindow + 1 };
}

/** Why a presented code cannot be checked at all (before comparing it), or `null`. */
export function codeUnusable(signer: SignatureRequestSignerRow, at: Date): string | null {
  if (signer.codeHash === null || signer.codeExpiresAt === null) return 'code_missing';
  if (signer.codeAttempts >= CODE_MAX_ATTEMPTS) return 'code_locked';
  if (signer.codeExpiresAt.getTime() <= at.getTime()) return 'code_expired';
  return null;
}

export interface SignatureInput {
  readonly method: SignatureMethod;
  readonly typedName: string | null;
  readonly mark: Buffer | null;
  readonly code: unknown;
}

/** Validate the sign body. The consent box must be ticked; the mark is checked as a PNG. */
export function parseSignatureInput(body: Readonly<Record<string, unknown>>): SignatureInput {
  if (body['consent'] !== true) throw invalid('consent', 'must be accepted');
  const method = body['method'];
  if (method === 'typed') {
    const raw = typeof body['typedName'] === 'string' ? body['typedName'].normalize('NFC') : '';
    const typedName = raw.trim();
    if (typedName === '' || typedName.length > MAX_TYPED_NAME) {
      throw invalid('typedName', `1 to ${MAX_TYPED_NAME} characters`);
    }
    return { method, typedName, mark: null, code: body['code'] };
  }
  if (method === 'drawn') {
    return { method, typedName: null, mark: parseMarkPng(body['markPng']), code: body['code'] };
  }
  throw invalid('method', 'typed or drawn');
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A drawn mark, base64 PNG. Refused unless it is a well-formed PNG within the size and pixel
 * caps whose chunk walk ends exactly at `IEND` — trailing bytes (a polyglot) are refused too.
 */
export function parseMarkPng(value: unknown): Buffer {
  const refuse = () => invalid('markPng', `a PNG drawing up to ${MARK_MAX_BYTES / 1024} KB`);
  if (typeof value !== 'string' || value.length > Math.ceil((MARK_MAX_BYTES * 4) / 3) + 4) {
    throw refuse();
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw refuse();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MARK_MAX_BYTES || bytes.length < 45) throw refuse();
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw refuse();
  let offset = 8;
  let first = true;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) throw refuse();
    if (first) {
      if (type !== 'IHDR' || length !== 13) throw refuse();
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (width < 1 || height < 1 || width > MARK_MAX_WIDTH || height > MARK_MAX_HEIGHT) {
        throw refuse();
      }
      first = false;
    }
    if (type === 'IEND') {
      if (end !== bytes.length) throw refuse();
      return bytes;
    }
    offset = end;
  }
  throw refuse();
}

export function markSha256(mark: Buffer): string {
  return createHash('sha256').update(mark).digest('hex');
}

/** Validate the team's create body (signers are re-checked against the project's contacts). */
export function parseCreateInput(body: Readonly<Record<string, unknown>>): {
  readonly deliverableVersionId: string;
  readonly signerUserIds: readonly string[];
  readonly expiresInDays: number;
  readonly title: string | null;
} {
  const deliverableVersionId = body['deliverableVersionId'];
  if (typeof deliverableVersionId !== 'string' || deliverableVersionId === '') {
    throw invalid('deliverableVersionId', 'is required');
  }
  const raw = body['signerUserIds'];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_SIGNERS ||
    raw.some((id) => typeof id !== 'string' || id === '')
  ) {
    throw invalid('signerUserIds', `1 to ${MAX_SIGNERS} client contacts`);
  }
  const days = body['expiresInDays'] ?? DEFAULT_EXPIRY_DAYS;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
    throw invalid('expiresInDays', `1 to ${MAX_EXPIRY_DAYS}`);
  }
  const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
  if (title.length > MAX_TITLE) throw invalid('title', `up to ${MAX_TITLE} characters`);
  return {
    deliverableVersionId,
    signerUserIds: [...new Set(raw as string[])],
    expiresInDays: days,
    title: title === '' ? null : title,
  };
}
