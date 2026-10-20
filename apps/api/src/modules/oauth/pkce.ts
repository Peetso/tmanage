import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * PKCE (RFC 7636), **S256 only** — MCP-CONNECTOR-ARCHITECTURE §4.1 and threat model row B1
 * ("Code interception, PKCE downgrade"): `plain` or a missing challenge is refused at authorize
 * time, and the verifier is checked at token time. Offering `plain` would let a network attacker
 * who intercepts the code also mint the token, which is the whole attack PKCE exists to stop.
 */

/** The only code-challenge method TManage advertises or accepts. */
export const CODE_CHALLENGE_METHOD_S256 = 'S256';

/** base64url without padding, as RFC 7636 §4.2 requires for the challenge and §4.1 for the verifier. */
function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The S256 challenge for a verifier: base64url(SHA-256(verifier)). */
export function codeChallengeS256(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier, 'ascii').digest());
}

/**
 * A syntactically acceptable code challenge: base64url, 43–128 characters (RFC 7636 §4.2 — a
 * SHA-256 digest is 43 base64url characters; the upper bound matches the verifier's own range).
 * The method itself must be `S256`; `plain` and any other value are rejected by the caller.
 */
export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(challenge);
}

/** A syntactically acceptable verifier: unreserved characters, 43–128 long (RFC 7636 §4.1). */
export function isValidCodeVerifier(verifier: unknown): verifier is string {
  return typeof verifier === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

/**
 * Does `verifier` satisfy `challenge` under S256? A constant-time comparison of the recomputed
 * challenge against the stored one, so a token request cannot probe the challenge byte by byte.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) return false;
  const computed = Buffer.from(codeChallengeS256(verifier), 'ascii');
  const expected = Buffer.from(challenge, 'ascii');
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}
