import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * 56-07 — the secrets of a public link, and nothing else: pure functions over a pepper.
 *
 * - **Token** = `tmanage_lnk_` + 32 random bytes in base64url (256 bits). Shown once to the
 *   creator, never stored: the row keeps `HMAC-SHA-256(pepper, "lnk:" + token)` and the last six
 *   characters as a hint for the list. A database dump alone cannot open any link.
 * - **E-mail code** = 6 digits from the CSPRNG, stored as `HMAC(pepper, "code:" + linkId + code)`
 *   so one code is bound to one link, and compared in constant time.
 * - **IP** is evidence, not an identifier the org may read back: only `HMAC(pepper, "ip:" + ip)`.
 *
 * Every hash is domain-separated by its prefix, so a value of one kind can never be replayed as
 * another. The pepper is `PUBLIC_LINK_PEPPER` (56-02), the same secret the 56-05 limiter uses.
 */

export const TOKEN_PREFIX = 'tmanage_lnk_';
const TOKEN_SHAPE = /^tmanage_lnk_[A-Za-z0-9_-]{43}$/u;
export const CODE_DIGITS = 6;

export class PublicLinkSecrets {
  private readonly pepper: Buffer;

  constructor(pepper: string) {
    if (pepper === '') throw new Error('the public-link pepper is empty');
    this.pepper = Buffer.from(pepper, 'utf8');
  }

  /** A fresh token, its stored hash and its list hint. */
  issueToken(): { readonly token: string; readonly hash: string; readonly hint: string } {
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    return { token, hash: this.tokenHash(token), hint: token.slice(-6) };
  }

  /** The stored hash of a well-formed token, or `null` for anything else (a flat 404 upstream). */
  hashPresented(raw: unknown): string | null {
    return typeof raw === 'string' && TOKEN_SHAPE.test(raw) ? this.tokenHash(raw) : null;
  }

  issueCode(linkId: string): { readonly code: string; readonly hash: string } {
    const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
    return { code, hash: this.codeHash(linkId, code) };
  }

  /** Constant-time: the comparison costs the same whether the first or the last digit is wrong. */
  codeMatches(linkId: string, presented: unknown, storedHash: string): boolean {
    if (typeof presented !== 'string' || !/^\d{6}$/u.test(presented)) return false;
    const a = Buffer.from(this.codeHash(linkId, presented), 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  ipHash(ip: string | undefined): string | null {
    return ip === undefined || ip === '' ? null : this.hmac(`ip:${ip}`);
  }

  private tokenHash(token: string): string {
    return this.hmac(`lnk:${token}`);
  }

  private codeHash(linkId: string, code: string): string {
    return this.hmac(`code:${linkId}:${code}`);
  }

  private hmac(message: string): string {
    return createHmac('sha256', this.pepper).update(message, 'utf8').digest('hex');
  }
}
