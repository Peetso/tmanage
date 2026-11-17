import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { emailAddressHash } from './list-unsubscribe.js';

/**
 * 56-26 — the signed `Message-ID` TManage puts on company mail, so a bounce can be tied back to
 * the message it is about without trusting anything else the bounce says.
 *
 * `<tmb1.<organizationId>.<addressHash>.<nonce>.<mac>@<sending domain>>`:
 *
 * - `organizationId` — the company that sent the message (a UUID);
 * - `addressHash` — `emailAddressHash(to)`, base64url SHA-256 of the normalised recipient: the
 *   raw address is never in the id, and the suppression record stores the same hash;
 * - `nonce` — 12 random bytes, base64url: one id per message, so a bounce counts once;
 * - `mac` — HMAC-SHA256 over the four fields above under a key derived from the server secret,
 *   cut to 16 bytes (base64url, 22 characters).
 *
 * A delivery report quotes the original headers (RFC 3464 `text/rfc822-headers` or
 * `message/rfc822`), so the id comes back. Only an id that verifies decides which company and
 * which address a bounce is about: an address in the report body, a forged `Final-Recipient` or an
 * id naming another company is worth nothing without the key.
 */

const VERSION = 'tmb1';
const KEY_LABEL = 'tmanage/mail-bounce/v1';
const MAC_BYTES = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HASH = /^[A-Za-z0-9_-]{43}$/u;
const NONCE = /^[A-Za-z0-9_-]{16}$/u;
const MAC = /^[A-Za-z0-9_-]{22}$/u;
/** The longest local part this module writes is 125 characters; anything longer is not ours. */
const MAX_LOCAL = 140;

/** The bounce key, derived from the server secret under its own label (domain separation). */
export function deriveBounceKey(serverSecret: string): Buffer {
  return createHmac('sha256', serverSecret).update(KEY_LABEL, 'utf8').digest();
}

function mac(key: Buffer, organizationId: string, addressHash: string, nonce: string): Buffer {
  return createHmac('sha256', key)
    .update(`${VERSION}.${organizationId}.${addressHash}.${nonce}`, 'utf8')
    .digest()
    .subarray(0, MAC_BYTES);
}

export interface BounceMessageIdInput {
  readonly organizationId: string;
  readonly to: string;
  /** The sending domain (the part after `@` of the From address). */
  readonly domain: string;
  /** Tests only; 12 random bytes otherwise. */
  readonly nonce?: string;
}

/** The `Message-ID` value (angle brackets included), or `null` when the input is not usable. */
export function bounceMessageId(key: Buffer, input: BounceMessageIdInput): string | null {
  const organizationId = input.organizationId.toLowerCase();
  const domain = input.domain.trim().toLowerCase();
  if (!UUID.test(organizationId) || !/^[a-z0-9.-]{1,253}$/u.test(domain)) return null;
  const nonce = input.nonce ?? randomBytes(12).toString('base64url');
  if (!NONCE.test(nonce)) return null;
  const hash = emailAddressHash(input.to);
  const signature = mac(key, organizationId, hash, nonce).toString('base64url');
  return `<${VERSION}.${organizationId}.${hash}.${nonce}.${signature}@${domain}>`;
}

/** What a verified id names. `reference` is the nonce: one per message sent. */
export interface BounceReference {
  readonly organizationId: string;
  readonly addressHash: string;
  readonly reference: string;
}

/**
 * The company, address hash and message reference a candidate id names — or `null` for anything
 * that is not an id this key signed. Linear checks only: split on fixed separators, anchored
 * patterns without nested quantifiers.
 */
export function readBounceMessageId(key: Buffer, candidate: string): BounceReference | null {
  const trimmed = candidate.trim();
  const inner = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  const at = inner.indexOf('@');
  if (at <= 0 || at > MAX_LOCAL) return null;
  const parts = inner.slice(0, at).split('.');
  if (parts.length !== 5) return null;
  const [version, organizationId, addressHash, nonce, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (
    version !== VERSION ||
    !UUID.test(organizationId) ||
    !HASH.test(addressHash) ||
    !NONCE.test(nonce) ||
    !MAC.test(signature)
  ) {
    return null;
  }
  const given = Buffer.from(signature, 'base64url');
  const expected = mac(key, organizationId, addressHash, nonce);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { organizationId, addressHash, reference: nonce };
}
