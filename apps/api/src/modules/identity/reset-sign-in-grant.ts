import { createHmac, randomBytes } from 'node:crypto';
import { constantTimeEquals } from './session-token.js';

/**
 * N01 (security run 3, wave 11). The holder's way out of a re-armed lockout.
 *
 * F20 made a full lockout window refuse a right guess as firmly as a wrong one, and N01 (wave 10)
 * made a completed password reset restart the count. What was left: a guesser rotating source
 * addresses can post five wrong passwords within seconds of the reset and fill the window again
 * before the holder has typed the new password. This grant is what the guesser cannot get.
 *
 * A completed reset - proof of the mailbox - hands the browser that completed it a sealed grant in
 * an `HttpOnly` cookie scoped to the password sign-in route. Presented with the **correct**
 * password, it admits one sign-in through a full window; it never admits a wrong password, never
 * skips a second factor, and is spent by the first succeeded sign-in after the reset. It is never
 * in a response body or a URL, so a guesser who never held the reset link never holds it.
 *
 * The seal is the drive flow's (`google-drive.google.ts`): HMAC-SHA256 under `SESSION_SECRET`
 * with its own purpose string, so no other sealed value signed with that secret opens here.
 *
 * The payload binds the grant to one account and one reset:
 *
 *  - `userId` - the account it may sign in to; any other account ignores it;
 *  - `passwordSetAt` - the ms timestamp of the succeeded `password_set` row the reset wrote. A
 *    later reset or password change moves that row, so an older grant goes stale;
 *  - `nonce` - 128 random bits, so two grants are never the same string;
 *  - `expiresAt` - epoch seconds, {@link RESET_SIGN_IN_GRANT_TTL_SECONDS} after the reset.
 */

export const RESET_SIGN_IN_GRANT_COOKIE = 'tm_reset_grant';
/** The password sign-in route (`AuthenticationController.signInWithPassword`). Nowhere else. */
export const RESET_SIGN_IN_GRANT_PATH = '/v1/auth/password';
export const RESET_SIGN_IN_GRANT_TTL_SECONDS = 900;

const GRANT_PURPOSE = 'reset-sign-in-grant.v1';
/** A sealed grant is well under 400 characters; anything far longer is not one. */
const MAX_SEALED_LENGTH = 1024;

export interface ResetSignInGrant {
  readonly userId: string;
  /** Epoch ms of the succeeded `password_set` row the reset wrote. */
  readonly passwordSetAt: number;
  readonly nonce: string;
  /** Epoch seconds. */
  readonly expiresAt: number;
}

export function newResetSignInGrant(
  input: { readonly userId: string; readonly passwordSetAt: Date },
  nowMs: number = Date.now(),
): ResetSignInGrant {
  return {
    userId: input.userId,
    passwordSetAt: input.passwordSetAt.getTime(),
    nonce: randomBytes(16).toString('base64url'),
    expiresAt: Math.floor(nowMs / 1000) + RESET_SIGN_IN_GRANT_TTL_SECONDS,
  };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${GRANT_PURPOSE}.${payload}`).digest('base64url');
}

export function sealResetSignInGrant(grant: ResetSignInGrant, secret: string): string {
  const payload = Buffer.from(JSON.stringify(grant), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** The grant, or `undefined` for a missing, forged, tampered, malformed or expired one. */
export function openResetSignInGrant(
  raw: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): ResetSignInGrant | undefined {
  if (!raw || raw.length > MAX_SEALED_LENGTH) return undefined;
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return undefined;
  if (!constantTimeEquals(signature, sign(payload, secret))) return undefined;
  try {
    const grant = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Partial<ResetSignInGrant> | null;
    if (
      grant === null ||
      typeof grant !== 'object' ||
      typeof grant.userId !== 'string' ||
      grant.userId.length === 0 ||
      typeof grant.nonce !== 'string' ||
      typeof grant.passwordSetAt !== 'number' ||
      !Number.isSafeInteger(grant.passwordSetAt) ||
      typeof grant.expiresAt !== 'number' ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt < Math.floor(nowMs / 1000)
    ) {
      return undefined;
    }
    return {
      userId: grant.userId,
      passwordSetAt: grant.passwordSetAt,
      nonce: grant.nonce,
      expiresAt: grant.expiresAt,
    };
  } catch {
    return undefined;
  }
}
