import { createHmac } from 'node:crypto';
import { constantTimeEquals } from './session-token.js';

/**
 * The token that carries a half-finished sign-in from the password step to the second-factor
 * step — `22-SCREEN-BY-SCREEN` §3's `ID-01` to `ID-02`.
 *
 * ## Why a signed token and not a row
 *
 * The obvious alternative is a `pending_authentications` table: insert on a correct password,
 * delete on a correct code. It buys one real property — single use — and costs an insert and
 * a delete on the hottest unauthenticated path in the system, plus a sweeper for the rows
 * nobody comes back for.
 *
 * The property is worth less here than it looks. This token is not a credential on its own:
 * presenting it gets you the *right to be asked for a code*, and the code is the second
 * factor. An attacker holding a stolen challenge token and no authenticator is exactly where
 * an attacker holding a stolen password and no authenticator already was. Making it
 * single-use would stop the same token being used for two simultaneous attempts, and both of
 * those attempts still need a valid, unreplayed TOTP code — which `user_mfa_factors.
 * last_accepted_counter` already refuses.
 *
 * So: stateless, signed, and **short**. Five minutes, which is long enough to find a phone
 * and short enough that a token captured from a log is usually already dead. The residual —
 * that a challenge token is replayable within its window, unlike a session — is recorded in
 * `docs/implementation-status.md` rather than left for a reader to notice.
 *
 * ## Signed with its own secret and its own purpose string
 *
 * `CHALLENGE_TOKEN_PURPOSE` is inside the signed payload. Without it, a value signed by this
 * secret for one meaning could be presented where a different meaning was expected — the
 * generic form of the confused-deputy problem, and the reason `session-token.ts` versions its
 * own format. It is signed with `SESSION_SECRET`, which is acceptable because the purpose
 * string makes the two token families disjoint; `CSRF_SECRET` stays separate because a CSRF
 * token protects a credential rather than being one.
 */

const CHALLENGE_TOKEN_VERSION = 'c1';
const CHALLENGE_TOKEN_PURPOSE = 'mfa';

/** Five minutes. Long enough to find a phone, short enough that a logged token is usually dead. */
export const CHALLENGE_TTL_SECONDS = 300;

export interface ChallengeClaims {
  readonly userId: string;
  readonly expiresAt: Date;
}

export type ChallengeRejection = 'missing' | 'malformed' | 'bad_signature' | 'expired';

export type ChallengeVerification =
  | { readonly ok: true; readonly claims: ChallengeClaims }
  | { readonly ok: false; readonly rejection: ChallengeRejection };

export function signChallengeToken(claims: ChallengeClaims, secret: string): string {
  if (claims.userId.includes('.')) {
    // The format is dot-delimited. A user id containing a dot would let the payload be
    // re-split into different claims carrying the same signature. UUIDs never contain one;
    // this refuses rather than assuming.
    throw new TypeError('userId must not contain "."');
  }
  const payload = `${CHALLENGE_TOKEN_VERSION}.${CHALLENGE_TOKEN_PURPOSE}.${claims.userId}.${claims.expiresAt.getTime()}`;
  return `${payload}.${signature(payload, secret)}`;
}

/**
 * Verify a challenge token.
 *
 * The signature is checked **before** the expiry, and that order is deliberate: reporting
 * `expired` for a value whose signature does not verify would tell an attacker that their
 * forgery was structurally correct, which is a free hint they do not otherwise get.
 */
export function verifyChallengeToken(
  token: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): ChallengeVerification {
  if (!token) return { ok: false, rejection: 'missing' };

  const parts = token.split('.');
  if (parts.length !== 5) return { ok: false, rejection: 'malformed' };

  const [version, purpose, userId, expiresAtRaw, presented] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (version !== CHALLENGE_TOKEN_VERSION || purpose !== CHALLENGE_TOKEN_PURPOSE) {
    return { ok: false, rejection: 'malformed' };
  }

  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAtMs) || userId === '') {
    return { ok: false, rejection: 'malformed' };
  }

  const payload = `${version}.${purpose}.${userId}.${expiresAtRaw}`;
  if (!constantTimeEquals(signature(payload, secret), presented)) {
    return { ok: false, rejection: 'bad_signature' };
  }

  if (expiresAtMs <= nowMs) return { ok: false, rejection: 'expired' };

  return { ok: true, claims: { userId, expiresAt: new Date(expiresAtMs) } };
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}
