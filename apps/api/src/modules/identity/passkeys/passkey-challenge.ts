import { createHmac, randomBytes } from 'node:crypto';
import { constantTimeEquals } from '../session-token.js';

/**
 * 56-22. The signed, stateless token that carries a WebAuthn challenge from the options request
 * to the verify request — `challenge-token.ts`'s shape, with its own version and purpose strings so
 * no other token family signed by `SESSION_SECRET` can stand in for it.
 *
 * - `register` tokens name the user and the session that asked, so a registration can only finish
 *   on the session that started it.
 * - `sign_in` tokens name nobody (the person is not known yet). Replay is closed per credential:
 *   the issue time is stored on the credential that answered (`user_passkeys.last_challenge_at`)
 *   and a token issued at or before it is refused.
 */

const VERSION = 'pk1';
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type PasskeyPurpose = 'register' | 'sign_in';

export interface PasskeyChallengeClaims {
  readonly purpose: PasskeyPurpose;
  readonly challenge: string;
  /** `-` for a sign-in challenge. */
  readonly userId: string;
  readonly sessionId: string;
  readonly issuedAt: number;
}

export function issuePasskeyChallenge(
  input: { purpose: PasskeyPurpose; userId?: string; sessionId?: string },
  secret: string,
  nowMs: number = Date.now(),
): { token: string; challenge: string } {
  const challenge = randomBytes(32).toString('base64url');
  const userId = input.userId ?? '-';
  const sessionId = input.sessionId ?? '-';
  if (userId.includes('.') || sessionId.includes('.'))
    throw new TypeError('ids must not contain "."');
  const payload = `${VERSION}.${input.purpose}.${userId}.${sessionId}.${challenge}.${String(nowMs)}`;
  return { token: `${payload}.${sign(payload, secret)}`, challenge };
}

/** The claims, or `null` for a missing, forged, wrong-purpose or expired token. */
export function verifyPasskeyChallenge(
  token: unknown,
  purpose: PasskeyPurpose,
  secret: string,
  nowMs: number = Date.now(),
): PasskeyChallengeClaims | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 7) return null;
  const [version, tokenPurpose, userId, sessionId, challenge, issuedRaw, presented] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const payload = parts.slice(0, 6).join('.');
  if (!constantTimeEquals(sign(payload, secret), presented)) return null;
  if (version !== VERSION || tokenPurpose !== purpose) return null;
  const issuedAt = Number(issuedRaw);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > nowMs) return null;
  if (nowMs - issuedAt > PASSKEY_CHALLENGE_TTL_MS) return null;
  return { purpose, challenge, userId, sessionId, issuedAt };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', `${secret}:passkey-challenge`)
    .update(payload, 'utf8')
    .digest('base64url');
}
