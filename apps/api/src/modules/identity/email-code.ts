import { createHash, createHmac, randomInt } from 'node:crypto';
import { createTwoPhaseFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import { constantTimeEquals } from './session-token.js';

/**
 * MFAOPTIONS. The e-mail code second step: the code, its stored form, what it is bound to, and the
 * send budget. No I/O here — `email-codes.repository.ts` stores rows, `AuthenticationService`
 * decides when, and `MfaCodeMailer` sends.
 *
 * - The code is six digits from the CSPRNG (`crypto.randomInt`, uniform, no modulo bias).
 * - Only {@link hashEmailCode} is stored: an HMAC-SHA256 under the session secret, salted with
 *   the binding. A bare SHA-256 — what the codebase uses for 256-bit link tokens — would not do
 *   for a code: a dump could be reversed by hashing all million candidates.
 * - A code is bound ({@link emailCodeBinding}) to the signed sign-in challenge it was sent for,
 *   or to the session and factor being enrolled, so it finishes nothing else.
 */

/** How long a mailed code works. */
export const EMAIL_CODE_TTL_SECONDS = 600;
/** Wrong guesses a code survives; the fifth spends it and kills its binding. */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** The pause between two sends to one person. */
export const EMAIL_CODE_RESEND_GAP_MS = 30_000;
/** Sends per hour, per person and per source address. */
export const EMAIL_CODE_SENDS_PER_HOUR = 5;

export type EmailCodePurpose = 'sign_in' | 'enrol';

const CODE_SHAPE = /^\d{6}$/u;

/** Six digits, leading zeros kept. */
export function generateEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * What a code is bound to, as the SHA-256 the row stores: the signed challenge token for a
 * sign-in, or the session and the factor for an enrolment. Never the token itself.
 */
export function emailCodeBinding(purpose: EmailCodePurpose, subject: string): string {
  return createHash('sha256').update(`mfa-email.${purpose}.${subject}`).digest('hex');
}

/** The stored form of a code: HMAC-SHA256 (hex) under the session secret, salted by binding. */
export function hashEmailCode(code: string, bindingHash: string, secret: string): string {
  return createHmac('sha256', secret).update(`mfa-email.${bindingHash}.${code}`).digest('hex');
}

/** Constant-time check of a typed code against a stored hash. A malformed code never matches. */
export function emailCodeMatches(
  storedHash: string,
  candidate: string,
  bindingHash: string,
  secret: string,
): boolean {
  const code = candidate.replace(/\s+/gu, '');
  if (!CODE_SHAPE.test(code)) return false;
  return constantTimeEquals(hashEmailCode(code, bindingHash, secret), storedHash);
}

/** `peter@example.com` → `p•••@example.com`: enough to recognise, not enough to harvest. */
export function maskEmailAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${address.slice(0, 1)}•••${address.slice(at)}`;
}

export type EmailCodeSendVerdict = 'admitted' | 'too_soon' | 'over_budget';

export interface EmailCodeSendBudget {
  /** Charge one send to this person and source, or say why not. Nothing is charged on a no. */
  admit(input: {
    readonly userId: string;
    readonly ip: string | null | undefined;
  }): EmailCodeSendVerdict;
}

/**
 * The send limits, on the existing fixed-window limiter: 30 s between sends to one person, and
 * {@link EMAIL_CODE_SENDS_PER_HOUR} per hour per person and per source address. All three are
 * tested before any is charged, so a refused send costs nothing. In process, like every other
 * auth budget here (one API process; a restart forgets the windows).
 */
export function createEmailCodeSendBudget(now: () => number = Date.now): EmailCodeSendBudget {
  const gap = createTwoPhaseFixedWindowLimiter({ windowMs: EMAIL_CODE_RESEND_GAP_MS, max: 1, now });
  const hourly = { windowMs: 60 * 60 * 1000, max: EMAIL_CODE_SENDS_PER_HOUR, now };
  const perUser = createTwoPhaseFixedWindowLimiter(hourly);
  const perSource = createTwoPhaseFixedWindowLimiter(hourly);
  return {
    admit({ userId, ip }) {
      const at = now();
      const source = `ip:${ip ?? 'unknown'}`;
      if (!gap.test(userId, at)) return 'too_soon';
      if (!perUser.test(userId, at) || !perSource.test(source, at)) return 'over_budget';
      gap.commit(userId, at);
      perUser.commit(userId, at);
      perSource.commit(source, at);
      return 'admitted';
    },
  };
}
