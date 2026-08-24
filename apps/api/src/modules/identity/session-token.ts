import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The cookie and token primitives behind ID-001 — pure, so they are testable without a
 * server, a request, or an HTTP framework.
 *
 * `04-SECURITY-PRIVACY.md` §3 asks for two things that are easy to conflate:
 *
 *   "Short-lived access session plus rotating refresh token; refresh reuse detection and
 *    device/session list."
 *   "Secure, HttpOnly, SameSite cookies for browser."
 *
 * They are two different credentials with two different lifetimes, and this file keeps them
 * apart deliberately.
 *
 * ## The access token is signed; the refresh token is opaque
 *
 * That asymmetry is the design, not an inconsistency.
 *
 * The **access token** carries a session id and an expiry, signed with `SESSION_SECRET`. The
 * signature is not what authorises the request — {@link SessionService} still reads the
 * session row on every call, because 04 §3 also requires "immediate server-side revocation on
 * offboarding", and a token that is trusted on its signature alone stays valid until it
 * expires no matter what the server decides in the meantime. What the signature buys is
 * narrower and still worth having: a forged or tampered cookie is rejected before it costs a
 * database round trip, and a client cannot nominate a session id of its own choosing, which
 * is what session fixation is.
 *
 * The **refresh token** is 256 bits of randomness and nothing else. It is never signed and
 * never parsed, because it is only ever *looked up*: its whole job is to be a value the
 * server can recognise, rotate away, and then recognise again as a replay. Signing it would
 * add a check that cannot fail independently of the lookup, and structure an attacker could
 * read. Only its SHA-256 is stored, so a database disclosure hands the reader a hash rather
 * than a usable credential.
 *
 * ## What is deliberately not here
 *
 * No CSRF token. `04-SECURITY-PRIVACY` §3 requires CSRF protection for state-changing
 * requests and `CSRF_SECRET` is already configured, but a double-submit token needs a request
 * to attach to and a header to compare against — it belongs with the HTTP surface, not with
 * the storage-and-policy half. Recorded as an open gap in `docs/implementation-status.md`
 * rather than half-built here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Refresh tokens
// ─────────────────────────────────────────────────────────────────────────────

/** 256 bits. The same strength as the SHA-256 that stores it, so neither half is the weak one. */
const REFRESH_TOKEN_BYTES = 32;

export interface IssuedRefreshToken {
  /** Sent to the browser, once, in a cookie. Never stored, never logged. */
  readonly token: string;
  /** SHA-256 hex — what the database holds. */
  readonly hash: string;
}

export function issueRefreshToken(): IssuedRefreshToken {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/**
 * Plain SHA-256, not a password hash, and the difference is deliberate.
 *
 * Argon2id exists to make *guessing* expensive, which matters for a value a human chose. A
 * refresh token is 256 uniform random bits: there is nothing to guess, and a slow hash on the
 * lookup path would only make every refresh — and every reuse check — expensive for the
 * server. What the hash is for here is that a stolen database dump contains no usable tokens.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Access tokens
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `v1.<sessionId>.<expiresAtEpochMs>.<signature>`.
 *
 * The version prefix is signed along with the rest, so a future format cannot be produced by
 * trimming or re-labelling a current one.
 *
 * Note what the payload does *not* contain: the user id. It is available on the session row,
 * and a copy in the cookie could only ever disagree with it — a session transferred, a user
 * merged, or simply a stale cookie would then present two answers to "who is this", with the
 * attacker-controlled one arriving first.
 */
const ACCESS_TOKEN_VERSION = 'v1';

export interface AccessTokenClaims {
  readonly sessionId: string;
  readonly expiresAt: Date;
}

export type AccessTokenRejection =
  'malformed' | 'unsupported_version' | 'bad_signature' | 'expired';

export type AccessTokenVerification =
  | { readonly ok: true; readonly claims: AccessTokenClaims }
  | { readonly ok: false; readonly reason: AccessTokenRejection };

function accessTokenSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

export function signAccessToken(claims: AccessTokenClaims, secret: string): string {
  if (claims.sessionId.includes('.')) {
    // The format is dot-delimited, so a session id containing a dot would let the payload be
    // re-split into different claims that carry the same signature. UUIDs never contain one;
    // this refuses rather than assuming.
    throw new TypeError('sessionId must not contain "."');
  }
  const payload = `${ACCESS_TOKEN_VERSION}.${claims.sessionId}.${claims.expiresAt.getTime()}`;
  return `${payload}.${accessTokenSignature(payload, secret)}`;
}

/**
 * Verify signature first, expiry second.
 *
 * The order matters: reporting `expired` for a value whose signature never checked out would
 * tell an attacker that their forgery was structurally accepted and only missed on time.
 */
export function verifyAccessToken(
  value: string,
  secret: string,
  now: Date = new Date(),
): AccessTokenVerification {
  const parts = value.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };

  const [version, sessionId, expiresAtRaw, signature] = parts as [string, string, string, string];
  if (version !== ACCESS_TOKEN_VERSION) return { ok: false, reason: 'unsupported_version' };

  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0 || !/^\d+$/.test(expiresAtRaw)) {
    // `Number('0x10')`, `Number(' 1 ')` and `Number('1e3')` all parse; none of them is what
    // this field is, and each would verify against a signature over different text.
    return { ok: false, reason: 'malformed' };
  }

  const expected = accessTokenSignature(`${version}.${sessionId}.${expiresAtRaw}`, secret);
  if (!constantTimeEquals(signature, expected)) return { ok: false, reason: 'bad_signature' };

  if (expiresAtMs <= now.getTime()) return { ok: false, reason: 'expired' };

  return { ok: true, claims: { sessionId, expiresAt: new Date(expiresAtMs) } };
}

/**
 * Compare without leaking where the two diverge.
 *
 * `timingSafeEqual` throws on unequal lengths, which would itself be a length oracle, so the
 * lengths are compared first and the buffers are only handed over when they match. A length
 * mismatch on a fixed-width base64url HMAC tells an attacker nothing they did not already
 * know from the format.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cookies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every cookie this application sets is `HttpOnly`, and that is not configurable.
 *
 * `15-AI-EXECUTION-HANDBOOK` §8 already bans browser storage as authoritative state, and the
 * lint rule enforces it. A session credential readable by JavaScript is the same mistake with
 * a different name: any XSS anywhere on the origin becomes a full session theft.
 */
export interface CookieAttributes {
  readonly path: string;
  readonly maxAgeSeconds: number;
  readonly sameSite: 'Lax' | 'Strict' | 'None';
  /**
   * Off only for plain-HTTP local development. `packages/config` refuses production boots on
   * dev substitutes for the same reason this must never default to `false` silently.
   */
  readonly secure: boolean;
}

/** `; ` and newlines in a cookie name or value are header injection, not a formatting problem. */
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9!#$%&'()*+\-./:<=>?@[\]^_`{|}~]*$/;

export function serializeCookie(name: string, value: string, attributes: CookieAttributes): string {
  if (!COOKIE_NAME_PATTERN.test(name)) throw new TypeError(`unsafe cookie name: ${name}`);
  if (!COOKIE_VALUE_PATTERN.test(value)) throw new TypeError('unsafe cookie value');
  if (attributes.sameSite === 'None' && !attributes.secure) {
    // Browsers reject the combination outright, so producing it would silently drop the
    // cookie and present as "the user is never signed in".
    throw new TypeError('SameSite=None requires Secure');
  }

  const parts = [
    `${name}=${value}`,
    `Path=${attributes.path}`,
    `Max-Age=${Math.max(0, Math.trunc(attributes.maxAgeSeconds))}`,
    `SameSite=${attributes.sameSite}`,
    'HttpOnly',
  ];
  if (attributes.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * The one cookie in this application that JavaScript may read.
 *
 * `serializeCookie` above hard-codes `HttpOnly` and is not parameterised, because a session
 * credential readable by script turns any XSS anywhere on the origin into a full session
 * theft. That rule stands. This is a separate function rather than a flag on the first one so
 * that reading a cookie becomes a deliberate, greppable choice rather than an argument someone
 * passes by accident.
 *
 * The exception is the CSRF token, and it is safe for a specific reason rather than by
 * exemption: the token authorises nothing on its own. It is `HMAC(CSRF_SECRET, sessionId)`,
 * it is only meaningful when presented **alongside** the `HttpOnly` session cookie, and the
 * client is required to echo it in a header — which is the whole mechanism. A value that must
 * be read by same-origin script in order to work is precisely the value a cross-origin
 * attacker cannot obtain.
 *
 * Note what this does not weaken: an XSS that can read this token can already issue
 * same-origin requests carrying the session cookie, so CSRF protection was never the control
 * standing between an XSS and a mutation. Its job is the cross-origin case.
 */
export function serializeReadableCookie(
  name: string,
  value: string,
  attributes: CookieAttributes,
): string {
  const withHttpOnly = serializeCookie(name, value, attributes);
  // Built by removing the flag from the checked output rather than by assembling a second
  // cookie string, so this cookie can never drift from the validation, the injection refusal,
  // or the `SameSite=None` rule the other one enforces.
  return withHttpOnly
    .split('; ')
    .filter((part) => part !== 'HttpOnly')
    .join('; ');
}

/**
 * The `Set-Cookie` that removes a cookie.
 *
 * `Path` and `SameSite` must match the cookie being cleared or the browser treats it as a
 * different cookie and leaves the original in place — which, for a refresh cookie scoped to
 * one path, is how a "sign out" leaves a working credential behind.
 */
export function expireCookie(
  name: string,
  attributes: Omit<CookieAttributes, 'maxAgeSeconds'>,
): string {
  return serializeCookie(name, '', { ...attributes, maxAgeSeconds: 0 });
}

/**
 * Read one cookie out of a `Cookie` request header.
 *
 * Returns the **first** occurrence. A request carrying the same name twice is ambiguous — it
 * is what a subdomain or path shadowing attack produces — and taking the last would let the
 * attacker's copy win.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return undefined;
}
