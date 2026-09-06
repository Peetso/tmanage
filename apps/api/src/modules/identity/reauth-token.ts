import { createHmac } from 'node:crypto';
import { constantTimeEquals } from './session-token.js';

/**
 * The token that proves a signed-in person re-presented their credentials *just now* — the
 * fresh proof `D05` requires before a password is replaced, a second factor removed, or the
 * recovery codes reissued.
 *
 * ## Why a session is not enough for these three actions
 *
 * A session proves that *someone* authenticated at some point in the last fortnight. Each of
 * these three actions changes what authenticating means from now on, and each is the exact
 * move a person holding a stolen or left-open session would make to keep the account after
 * the owner notices. Asking for the password (and the code, when a factor exists) again is
 * what turns "has the session" back into "is the person".
 *
 * ## Same shape as `challenge-token.ts`, and deliberately not the same token
 *
 * Stateless, HMAC-signed with `SESSION_SECRET`, five minutes. The reasoning in
 * `challenge-token.ts` for a signed value over a table row carries over unchanged. Two
 * differences are load-bearing:
 *
 * - **A purpose string of its own** (`REAUTH_TOKEN_PURPOSE`) inside the signed payload. A
 *   challenge token is minted *before* the second factor is checked and is therefore weaker
 *   than this one; a verifier that accepted either where this one is expected would let a
 *   password alone stand in for password-plus-code. The purpose strings make the two
 *   families disjoint at the byte level, and `verifyReauthToken` refuses the other family
 *   as `malformed` before it ever compares a signature.
 * - **Bound to the session, not only the user.** The claims carry the `sessionId` the
 *   proof was made in. `AuthenticationService.requireReauth` checks both against the
 *   caller's, so a token minted in one session cannot be spent from another, even one
 *   belonging to the same person. That is the review's acceptance criterion, and it is
 *   what stops a token leaked from one tab authorising a change made from a hijacked one.
 */

const REAUTH_TOKEN_VERSION = 'r1';
const REAUTH_TOKEN_PURPOSE = 'reauth';

/** Five minutes — the `CHALLENGE_TTL_SECONDS` convention, so there is one number to reason about. */
export const REAUTH_TTL_SECONDS = 300;

export interface ReauthClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

export type ReauthRejection = 'missing' | 'malformed' | 'bad_signature' | 'expired';

export type ReauthVerification =
  | { readonly ok: true; readonly claims: ReauthClaims }
  | { readonly ok: false; readonly rejection: ReauthRejection };

export function signReauthToken(claims: ReauthClaims, secret: string): string {
  if (claims.userId.includes('.') || claims.sessionId.includes('.')) {
    // Dot-delimited format; an id containing one would let the payload re-split into
    // different claims carrying the same signature. UUIDs never contain one; refuse rather
    // than assume.
    throw new TypeError('userId and sessionId must not contain "."');
  }
  const payload = `${REAUTH_TOKEN_VERSION}.${REAUTH_TOKEN_PURPOSE}.${claims.userId}.${claims.sessionId}.${claims.expiresAt.getTime()}`;
  return `${payload}.${signature(payload, secret)}`;
}

/**
 * Verify a re-authentication token.
 *
 * Signature before expiry, as in `challenge-token.ts`: reporting `expired` for a forgery
 * would confirm the forgery was structurally right.
 */
export function verifyReauthToken(
  token: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): ReauthVerification {
  if (!token) return { ok: false, rejection: 'missing' };

  const parts = token.split('.');
  if (parts.length !== 6) return { ok: false, rejection: 'malformed' };

  const [version, purpose, userId, sessionId, expiresAtRaw, presented] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  if (version !== REAUTH_TOKEN_VERSION || purpose !== REAUTH_TOKEN_PURPOSE) {
    return { ok: false, rejection: 'malformed' };
  }

  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAtMs) || userId === '' || sessionId === '') {
    return { ok: false, rejection: 'malformed' };
  }

  const payload = `${version}.${purpose}.${userId}.${sessionId}.${expiresAtRaw}`;
  if (!constantTimeEquals(signature(payload, secret), presented)) {
    return { ok: false, rejection: 'bad_signature' };
  }

  if (expiresAtMs <= nowMs) return { ok: false, rejection: 'expired' };

  return { ok: true, claims: { userId, sessionId, expiresAt: new Date(expiresAtMs) } };
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}
