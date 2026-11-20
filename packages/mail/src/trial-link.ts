import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { emailAddressHash } from './list-unsubscribe.js';

/**
 * LANE-Q — the personal trial link of the outreach campaign: signed, expiring, single-use.
 *
 * `v1.<recipientId>.<expiresAtSeconds>.<hmac>` where the HMAC (SHA-256, key derived from the
 * server secret under its own label, the way `deriveUnsubscribeKey` derives the unsubscribe key)
 * covers the version, the recipient row id, the expiry, the SHA-256 of the recipient address and
 * the SHA-256 of the company name. So the token "carries" the company and the address without
 * putting either in the URL (no personal data in a query string or path): the server reads them
 * from the recipient row and the MAC proves they are the ones the mail was sent for. Editing the
 * row's address or company afterwards voids every token minted for it.
 *
 * Expiry is in the token (30 days, {@link TRIAL_LINK_TTL_MS}); single use is the recipient row's
 * `trial_redeemed_at`, set by a compare-and-set in the sign-up transaction. Nothing here touches
 * the database: this file is the pure signing half, shared by the worker (mint) and the API
 * (verify).
 */

const VERSION = 'v1';
const KEY_LABEL = 'tmanage/outreach-trial-link/v1';
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** How long a trial link opens sign-up: 30 days from the send. */
export const TRIAL_LINK_TTL_MS = 30 * 86_400_000;

/** The HMAC key, derived from the server secret under a fixed label (domain separation). */
export function deriveTrialLinkKey(serverSecret: string): Buffer {
  return createHmac('sha256', serverSecret).update(KEY_LABEL, 'utf8').digest();
}

/** What a trial link is bound to: the recipient row and the two values it was sent for. */
export interface TrialLinkSubject {
  readonly recipientId: string;
  readonly email: string;
  readonly company: string;
}

const companyHash = (company: string): string =>
  createHash('sha256').update(company.trim().normalize('NFC'), 'utf8').digest('base64url');

function mac(key: Buffer, recipientId: string, expires: number, subject: TrialLinkSubject) {
  return createHmac('sha256', key)
    .update(
      `${VERSION}.${recipientId}.${String(expires)}.${emailAddressHash(subject.email)}.${companyHash(subject.company)}`,
      'utf8',
    )
    .digest();
}

/** Mint a token for one recipient, valid until `now + TRIAL_LINK_TTL_MS`. */
export function signTrialLink(key: Buffer, subject: TrialLinkSubject, now: Date): string {
  if (!ID_PATTERN.test(subject.recipientId)) throw new Error('trial link needs a recipient id');
  const expires = Math.floor((now.getTime() + TRIAL_LINK_TTL_MS) / 1000);
  const signature = mac(key, subject.recipientId, expires, subject).toString('base64url');
  return `${VERSION}.${subject.recipientId}.${String(expires)}.${signature}`;
}

/** The parts of a well-formed token, before the row is read; `null` for anything malformed. */
export interface TrialLinkClaim {
  readonly recipientId: string;
  readonly expiresAt: Date;
}

export function readTrialLink(token: unknown): TrialLinkClaim | null {
  if (typeof token !== 'string' || token.length > 160) return null;
  const [version, recipientId, expires, signature, extra] = token.split('.');
  if (version !== VERSION || extra !== undefined) return null;
  if (recipientId === undefined || !ID_PATTERN.test(recipientId)) return null;
  if (expires === undefined || !/^\d{9,11}$/u.test(expires)) return null;
  if (signature === undefined || !SIGNATURE_PATTERN.test(signature)) return null;
  return { recipientId, expiresAt: new Date(Number(expires) * 1000) };
}

export type TrialLinkVerdict = 'valid' | 'invalid' | 'expired';

/**
 * Whether `token` was minted for exactly this recipient row (its current address and company) and
 * has not expired. A forged, truncated or foreign token is `invalid`; a genuine one past its expiry
 * is `expired` (the page then says so, instead of "not found").
 */
export function verifyTrialLink(
  key: Buffer,
  token: unknown,
  subject: TrialLinkSubject,
  now: Date,
): TrialLinkVerdict {
  const claim = readTrialLink(token);
  if (claim === null || claim.recipientId !== subject.recipientId) return 'invalid';
  const signature = (token as string).split('.')[3] as string;
  const given = Buffer.from(signature, 'base64url');
  const expected = mac(key, claim.recipientId, claim.expiresAt.getTime() / 1000, subject);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
  return claim.expiresAt.getTime() <= now.getTime() ? 'expired' : 'valid';
}
