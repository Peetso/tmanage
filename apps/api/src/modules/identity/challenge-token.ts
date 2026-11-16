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
/**
 * N01 (wave 12). The format of a challenge minted when a reset sign-in grant carried the password
 * step through a full lockout window: the `c1` fields plus the grant's `passwordSetAt`, all under
 * the one signature. A challenge minted without the grant keeps the `c1` format byte for byte.
 */
const CHALLENGE_TOKEN_VERSION_VIA_RESET_GRANT = 'c2';
const CHALLENGE_TOKEN_PURPOSE = 'mfa';

/**
 * Ten minutes. Long enough to find a phone or to wait for the mailed code (MFAOPTIONS: an e-mail
 * code works for ten minutes, and the challenge it finishes must last as long), short enough that
 * a logged token is usually dead. Raised from five minutes for the e-mail method.
 */
export const CHALLENGE_TTL_SECONDS = 600;

export interface ChallengeClaims {
  readonly userId: string;
  readonly expiresAt: Date;
  /**
   * N01 (wave 12). Present only when a reset sign-in grant admitted the password step through a
   * full lockout window: the epoch milliseconds of the `password_set` row that grant belongs to.
   * The second-factor step may then pass the full window once, while that row is still the latest
   * and no second factor has succeeded since it (`AuthenticationService`).
   */
  readonly resetGrantPasswordSetAt?: number;
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
  const grantAt = claims.resetGrantPasswordSetAt;
  if (grantAt !== undefined && !Number.isSafeInteger(grantAt)) {
    throw new TypeError('resetGrantPasswordSetAt must be an integer');
  }
  const payload =
    grantAt === undefined
      ? `${CHALLENGE_TOKEN_VERSION}.${CHALLENGE_TOKEN_PURPOSE}.${claims.userId}.${claims.expiresAt.getTime()}`
      : `${CHALLENGE_TOKEN_VERSION_VIA_RESET_GRANT}.${CHALLENGE_TOKEN_PURPOSE}.${claims.userId}.${claims.expiresAt.getTime()}.${grantAt}`;
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
  const viaResetGrant = parts[0] === CHALLENGE_TOKEN_VERSION_VIA_RESET_GRANT;
  if (parts.length !== (viaResetGrant ? 6 : 5)) return { ok: false, rejection: 'malformed' };

  const [version, purpose, userId, expiresAtRaw] = parts as [string, string, string, string];
  const grantAtRaw = viaResetGrant ? parts[4]! : undefined;
  const presented = parts[parts.length - 1]!;

  if (
    (version !== CHALLENGE_TOKEN_VERSION && !viaResetGrant) ||
    purpose !== CHALLENGE_TOKEN_PURPOSE
  ) {
    return { ok: false, rejection: 'malformed' };
  }

  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAtMs) || userId === '') {
    return { ok: false, rejection: 'malformed' };
  }
  const grantAtMs = grantAtRaw === undefined ? undefined : Number(grantAtRaw);
  if (grantAtMs !== undefined && (grantAtRaw === '' || !Number.isSafeInteger(grantAtMs))) {
    return { ok: false, rejection: 'malformed' };
  }

  const payload = parts.slice(0, -1).join('.');
  if (!constantTimeEquals(signature(payload, secret), presented)) {
    return { ok: false, rejection: 'bad_signature' };
  }

  if (expiresAtMs <= nowMs) return { ok: false, rejection: 'expired' };

  return {
    ok: true,
    claims:
      grantAtMs === undefined
        ? { userId, expiresAt: new Date(expiresAtMs) }
        : { userId, expiresAt: new Date(expiresAtMs), resetGrantPasswordSetAt: grantAtMs },
  };
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}
