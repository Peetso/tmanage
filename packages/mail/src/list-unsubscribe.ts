import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 51-11 — the signed one-click unsubscribe token (RFC 8058) and the two headers that carry it.
 *
 * Gmail and Yahoo require `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
 * on bulk and notification mail. The URL in the header is POSTed by the mail client with no
 * cookie and no CSRF token, so the URL itself is the authority: it carries a token the API can
 * verify without a session.
 *
 * ## What the token holds — no address in the URL
 *
 * `v1.<sha256(address)>.<hmac>`: the SHA-256 of the lower-cased, trimmed recipient address and an
 * HMAC-SHA256 of that over a key derived from the server secret. The raw address never appears
 * in the URL (no personal data in query strings), and the suppression list stores the same hash,
 * so the worker checks a recipient by hashing it — the list itself holds no address either.
 *
 * No expiry, on purpose: an unsubscribe link in a two-year-old mail must still work (RFC 8058
 * §3 asks for long validity), and the only thing a token can do is stop mail to its own address.
 */

const VERSION = 'v1';
const KEY_LABEL = 'tmanage/list-unsubscribe/v1';
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** The suppression-list key for one address: base64url SHA-256 of its normalised form. */
export function emailAddressHash(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase(), 'utf8').digest('base64url');
}

/**
 * The HMAC key, derived from a server secret under a fixed label — domain separation, so the
 * session secret is never used directly and a token minted here verifies nowhere else.
 */
export function deriveUnsubscribeKey(serverSecret: string): Buffer {
  return createHmac('sha256', serverSecret).update(KEY_LABEL, 'utf8').digest();
}

function mac(key: Buffer, hash: string): Buffer {
  return createHmac('sha256', key).update(`${VERSION}.${hash}`, 'utf8').digest();
}

export function signUnsubscribeToken(key: Buffer, address: string): string {
  const hash = emailAddressHash(address);
  return `${VERSION}.${hash}.${mac(key, hash).toString('base64url')}`;
}

/** The address hash a valid token names, or `null` for anything forged, truncated or foreign. */
export function verifyUnsubscribeToken(key: Buffer, token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const [version, hash, signature, extra] = token.split('.');
  if (version !== VERSION || extra !== undefined || hash === undefined || signature === undefined)
    return null;
  if (!HASH_PATTERN.test(hash)) return null;
  const given = Buffer.from(signature, 'base64url');
  const expected = mac(key, hash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return hash;
}

/** The two RFC 8058 headers for one recipient, pointing at the API's one-click route. */
export function listUnsubscribeHeaders(
  unsubscribeUrl: string,
  key: Buffer,
  address: string,
): Readonly<Record<string, string>> {
  const url = new URL(unsubscribeUrl);
  url.searchParams.set('t', signUnsubscribeToken(key, address));
  return {
    'List-Unsubscribe': `<${url.toString()}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
