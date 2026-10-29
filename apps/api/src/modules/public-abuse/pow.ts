import { createHash, createHmac } from 'node:crypto';

/**
 * 52-21 — proof-of-work, the challenge a page can solve without asking the person anything.
 *
 * The server hands out `salt` (an HMAC of the challenge id, so it is not stored) and a difficulty
 * in bits; the browser searches for a `solution` such that `SHA-256(salt + ':' + solution)` starts
 * with that many zero bits (a partial collision). The default is {@link POW_DEFAULT_BITS} — about
 * 260 000 hashes, well under a second on a phone. Verifying is one hash.
 *
 * Difficulty is adaptive: under load (more challenges issued per minute than expected) it rises by
 * one bit per doubling, capped at {@link POW_MAX_BITS} so a person on a slow phone is never locked
 * out by an attacker's volume; it never drops below {@link POW_MIN_BITS}.
 */

export const POW_DEFAULT_BITS = 18;
export const POW_MIN_BITS = 16;
export const POW_MAX_BITS = 22;
/** Challenges issued per minute that the default difficulty is sized for. */
export const POW_EXPECTED_PER_MINUTE = 30;
const SOLUTION = /^[A-Za-z0-9_-]{1,64}$/u;

export function powSalt(secret: string, challengeId: string): string {
  return createHmac('sha256', secret).update(`pow:${challengeId}`).digest('base64url');
}

/** Leading zero bits of a digest. */
export function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export function powDigest(salt: string, solution: string): Buffer {
  return createHash('sha256').update(`${salt}:${solution}`, 'utf8').digest();
}

/** Server-side verify: one hash. A malformed solution is simply wrong. */
export function verifyPow(salt: string, solution: unknown, bits: number): boolean {
  if (typeof solution !== 'string' || !SOLUTION.test(solution)) return false;
  return leadingZeroBits(powDigest(salt, solution)) >= bits;
}

/** The difficulty for the current issue rate, between the floor and the cap. */
export function adaptiveDifficulty(issuedLastMinute: number): number {
  if (issuedLastMinute <= POW_EXPECTED_PER_MINUTE) return POW_DEFAULT_BITS;
  const extra = Math.floor(Math.log2(issuedLastMinute / POW_EXPECTED_PER_MINUTE));
  return Math.min(POW_MAX_BITS, Math.max(POW_MIN_BITS, POW_DEFAULT_BITS + extra));
}

/** A reference solver (tests and tooling); the browser runs the same loop. */
export function solvePow(salt: string, bits: number, limit = 50_000_000): string | null {
  for (let counter = 0; counter < limit; counter += 1) {
    const candidate = counter.toString(36);
    if (leadingZeroBits(powDigest(salt, candidate)) >= bits) return candidate;
  }
  return null;
}
