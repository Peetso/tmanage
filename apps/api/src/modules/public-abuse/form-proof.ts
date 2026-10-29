import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 52-21 — the invisible form proof (time-to-fill + JS nonce).
 *
 * When a public form is shown, the page asks `GET /v1/public/form-proof` for a pair:
 *
 * - `startedAt` — `<issuedMs>.<nonce>.<mac>`, HMAC-signed with a key derived from
 *   `SESSION_SECRET`, so the server can trust *when* the form was shown without storing anything;
 * - `nonce` — the same nonce, for the page script.
 *
 * Both travel back as hidden inputs, and the page script adds `proof = SHA-256(nonce + startedAt)`
 * computed in the browser (`apps/web/src/lib/form-proof.ts`). A scripted POST that never ran the
 * page carries no proof (+60); one that replays an old token is past {@link FORM_PROOF_MAX_AGE_MS}
 * (treated as no token); one sent faster than a person fills a form carries a short fill time (+60).
 */

/** A token older than this is no evidence of anything. */
export const FORM_PROOF_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
/** Clock skew tolerated between processes on the one host. */
const FUTURE_SKEW_MS = 5_000;
const NONCE = /^[A-Za-z0-9_-]{22}$/u;
const MAC = /^[A-Za-z0-9_-]{43}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

export interface FormProofIssue {
  readonly startedAt: string;
  readonly nonce: string;
}

export interface FormProofSubmission {
  readonly startedAt?: unknown;
  readonly nonce?: unknown;
  readonly proof?: unknown;
}

export interface FormProofVerdict {
  /** The `startedAt` token is authentic, unexpired and not from the future. */
  readonly tokenValid: boolean;
  /** Milliseconds the form was open; only when the token is valid. */
  readonly fillMs?: number;
  /** The browser-computed proof matches this token and nonce. */
  readonly jsProofValid: boolean;
}

/** The form-proof key: derived from the session secret, so it signs nothing else. */
export function formProofKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update('tmanage:52-21:form-proof').digest();
}

function mac(key: Buffer, issuedMs: number, nonce: string): string {
  return createHmac('sha256', key).update(`form-proof:${issuedMs}:${nonce}`).digest('base64url');
}

export function issueFormProof(key: Buffer, now: Date = new Date()): FormProofIssue {
  const nonce = randomBytes(16).toString('base64url');
  const issuedMs = now.getTime();
  return { startedAt: `${issuedMs}.${nonce}.${mac(key, issuedMs, nonce)}`, nonce };
}

/** What the page script computes: lower-case hex SHA-256 of `nonce + startedAt`. */
export function expectedJsProof(nonce: string, startedAt: string): string {
  return createHash('sha256').update(`${nonce}${startedAt}`, 'utf8').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyFormProof(
  key: Buffer,
  submission: FormProofSubmission,
  now: Date = new Date(),
): FormProofVerdict {
  const invalid: FormProofVerdict = { tokenValid: false, jsProofValid: false };
  const { startedAt, nonce, proof } = submission;
  if (typeof startedAt !== 'string' || startedAt.length > 128) return invalid;
  const [issuedText, tokenNonce, tokenMac, extra] = startedAt.split('.');
  if (extra !== undefined || issuedText === undefined || !/^\d{1,15}$/u.test(issuedText)) {
    return invalid;
  }
  if (tokenNonce === undefined || !NONCE.test(tokenNonce)) return invalid;
  if (tokenMac === undefined || !MAC.test(tokenMac)) return invalid;
  const issuedMs = Number(issuedText);
  if (!safeEqual(tokenMac, mac(key, issuedMs, tokenNonce))) return invalid;
  const age = now.getTime() - issuedMs;
  if (age < -FUTURE_SKEW_MS || age > FORM_PROOF_MAX_AGE_MS) return invalid;

  const jsProofValid =
    typeof nonce === 'string' &&
    safeEqual(nonce, tokenNonce) &&
    typeof proof === 'string' &&
    HEX64.test(proof) &&
    safeEqual(proof, expectedJsProof(tokenNonce, startedAt));
  return { tokenValid: true, fillMs: Math.max(0, age), jsProofValid };
}
