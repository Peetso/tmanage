import { timingSafeEqual } from 'node:crypto';

/**
 * 52-19 (web half) — the public "Verify this approval record" check, as pure functions.
 *
 * Anyone holding a certificate can paste its record ID and record fingerprint (the record hash)
 * and learn one of three things: `genuine`, `not_found` or `altered`. The answer must not tell a
 * stranger which record IDs exist, so a missing ID and a wrong fingerprint are the same
 * `not_found`, reached through the same steps: one lookup by ID, then one constant-time comparison
 * against the stored hash (or a fixed dummy when there is none). Only a caller who already holds
 * the right fingerprint learns anything more, and then only the verdict, the decision date and
 * the workspace name.
 */

export type RecordVerdict = 'genuine' | 'not_found' | 'altered';

/** The decision a sealed record holds; `signed` is a 52-26 signature record in the same chain. */
export type VerifiedDecision = 'approved' | 'changes_requested' | 'signed';

/** The whole public answer. Nothing else about the record or the workspace ever leaves. */
export interface PublicRecordVerdictView {
  readonly verdict: RecordVerdict;
  /** ISO instant of the decision; `genuine` only (an altered record's own date is not trusted). */
  readonly decidedAt: string | null;
  /** What was decided; `genuine` only, so "approved on" is never said of a request for changes. */
  readonly decision: VerifiedDecision | null;
  /** The workspace that issued the record; `genuine` and `altered`. */
  readonly workspaceName: string | null;
}

export const NOT_FOUND_VERDICT: PublicRecordVerdictView = Object.freeze({
  verdict: 'not_found',
  decidedAt: null,
  decision: null,
  workspaceName: null,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** The longest pasted value read at all; anything longer is not an ID or a fingerprint. */
const MAX_INPUT = 200;
/** Compared against when there is no stored hash, so that path costs what a real one does. */
const DUMMY_HASH = Buffer.alloc(32);

/** A record ID as printed (a UUID), trimmed and lower-cased; `null` when it cannot be one. */
export function normalizeRecordId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_INPUT) return null;
  const id = value.trim().toLowerCase();
  return UUID.test(id) ? id : null;
}

/**
 * A fingerprint as pasted: the certificate prints it in groups, and some tools prefix `sha256:`,
 * so spaces and the prefix are dropped and the hex lower-cased. `null` when it is not 64 hex.
 */
export function normalizeFingerprint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_INPUT) return null;
  const hex = value
    .replace(/\s+/g, '')
    .replace(/^sha-?256:/i, '')
    .toLowerCase();
  return SHA256_HEX.test(hex) ? hex : null;
}

/**
 * Whether the presented fingerprint is the stored record hash, in constant time. Always exactly one
 * `timingSafeEqual` over 32 bytes, whether or not a record was found and whether or not the
 * presented value was well formed, so the time taken says nothing about which one failed.
 */
export function fingerprintMatches(presented: string | null, stored: string | null): boolean {
  const storedOk = stored !== null && SHA256_HEX.test(stored);
  const a = presented === null ? DUMMY_HASH : Buffer.from(presented, 'hex');
  const b = storedOk ? Buffer.from(stored, 'hex') : DUMMY_HASH;
  const equal = timingSafeEqual(a, b);
  return equal && presented !== null && storedOk;
}

/** The request body: `{ recordId, fingerprint }`; anything else reads as two missing values. */
export function verifyInput(body: unknown): {
  readonly recordId: string | null;
  readonly fingerprint: string | null;
} {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return {
    recordId: normalizeRecordId(record['recordId']),
    fingerprint: normalizeFingerprint(record['fingerprint']),
  };
}

export function isVerifiedDecision(value: string): value is VerifiedDecision {
  return value === 'approved' || value === 'changes_requested' || value === 'signed';
}
