import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  expireCookie,
  hashRefreshToken,
  issueRefreshToken,
  readCookie,
  serializeCookie,
  signAccessToken,
  verifyAccessToken,
} from './session-token.js';

/**
 * The cookie and token primitives, without a server.
 *
 * These are the parts of ID-001 that are pure functions, so they are tested as pure
 * functions. What the database suite cannot show — that a one-bit change to a signature is
 * rejected, that an expiry field with a leading space is refused, that a cookie value
 * carrying a newline throws instead of being written into a header — is all here.
 */

const SECRET = 'local_dev_only_session_secret_value_for_tests';
const SESSION_ID = '018f4b1e-6e4a-7c3d-9f21-2b7c5d8e9a01';

const inOneHour = () => new Date(Date.now() + 3_600_000);

describe('refresh tokens', () => {
  it('issues 256 bits of randomness, never the same value twice', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(issueRefreshToken().token);
    expect(seen.size).toBe(200);
    // base64url of 32 bytes, unpadded.
    for (const token of seen) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('stores a hash, not the token', () => {
    const issued = issueRefreshToken();
    expect(issued.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.hash).not.toContain(issued.token);
    expect(issued.hash).toBe(hashRefreshToken(issued.token));
  });

  it('hashes deterministically, so a lookup can find a token it never stored', () => {
    // The whole reuse detector rests on this: the server recognises a presented token only
    // by re-deriving the same hash.
    expect(hashRefreshToken('a')).toBe(hashRefreshToken('a'));
    expect(hashRefreshToken('a')).not.toBe(hashRefreshToken('b'));
  });
});

describe('access tokens', () => {
  it('round-trips the session id and the expiry', () => {
    const expiresAt = inOneHour();
    const verified = verifyAccessToken(
      signAccessToken({ sessionId: SESSION_ID, expiresAt }, SECRET),
      SECRET,
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims.sessionId).toBe(SESSION_ID);
    // DATETIME(3) precision throughout, so the round trip is exact rather than close.
    expect(verified.claims.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it('carries no user id', () => {
    // Deliberate: the user id lives on the session row, and a second copy in an
    // attacker-held cookie could only ever disagree with it.
    const token = signAccessToken({ sessionId: SESSION_ID, expiresAt: inOneHour() }, SECRET);
    expect(token.split('.')).toHaveLength(4);
    expect(token.startsWith(`v1.${SESSION_ID}.`)).toBe(true);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signAccessToken({ sessionId: SESSION_ID, expiresAt: inOneHour() }, SECRET);
    expect(verifyAccessToken(token, `${SECRET}x`)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered session id, even with the original signature', () => {
    const token = signAccessToken({ sessionId: SESSION_ID, expiresAt: inOneHour() }, SECRET);
    const [version, , expiry, signature] = token.split('.') as [string, string, string, string];
    const forged = `${version}.018f4b1e-6e4a-7c3d-9f21-2b7c5d8e9a02.${expiry}.${signature}`;
    expect(verifyAccessToken(forged, SECRET)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an extended expiry', () => {
    // The attack the signature exists for: take a valid short-lived token and push its
    // deadline out.
    const token = signAccessToken({ sessionId: SESSION_ID, expiresAt: inOneHour() }, SECRET);
    const [version, sessionId, expiry, signature] = token.split('.') as [
      string,
      string,
      string,
      string,
    ];
    const extended = `${version}.${sessionId}.${Number(expiry) + 86_400_000}.${signature}`;
    expect(verifyAccessToken(extended, SECRET)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an expired token whose signature is genuine', () => {
    const token = signAccessToken(
      { sessionId: SESSION_ID, expiresAt: new Date(Date.now() - 1_000) },
      SECRET,
    );
    expect(verifyAccessToken(token, SECRET)).toEqual({ ok: false, reason: 'expired' });
  });

  it('checks the signature before the expiry', () => {
    // Reporting `expired` for a forgery would tell an attacker their structure was accepted
    // and only the clock defeated them.
    const token = signAccessToken(
      { sessionId: SESSION_ID, expiresAt: new Date(Date.now() - 1_000) },
      SECRET,
    );
    expect(verifyAccessToken(token, 'a different secret entirely')).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a token with the wrong number of segments', () => {
    expect(verifyAccessToken('v1.a.b', SECRET).ok).toBe(false);
    expect(verifyAccessToken('v1.a.b.c.d', SECRET).ok).toBe(false);
    expect(verifyAccessToken('', SECRET)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an unknown version before doing anything else', () => {
    const token = signAccessToken({ sessionId: SESSION_ID, expiresAt: inOneHour() }, SECRET);
    expect(verifyAccessToken(token.replace(/^v1\./, 'v2.'), SECRET)).toEqual({
      ok: false,
      reason: 'unsupported_version',
    });
  });

  it('refuses expiry fields that Number() would accept but the signature covered as text', () => {
    // `Number(' 1e13 ')` parses. A verifier that trusted it would compare a signature over
    // one string while acting on a different value.
    for (const expiry of [' 1', '1e13', '0x10', '+1', '1.0', '-1', '', 'NaN']) {
      expect(verifyAccessToken(`v1.${SESSION_ID}.${expiry}.sig`, SECRET).ok).toBe(false);
    }
  });

  it('refuses to sign a session id that would break the format', () => {
    expect(() => signAccessToken({ sessionId: 'a.b', expiresAt: inOneHour() }, SECRET)).toThrow(
      TypeError,
    );
  });
});

describe('constantTimeEquals', () => {
  it('compares equal and unequal values of the same length', () => {
    expect(constantTimeEquals('abcdef', 'abcdef')).toBe(true);
    expect(constantTimeEquals('abcdef', 'abcdeg')).toBe(false);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    // `timingSafeEqual` throws on unequal lengths, which would itself be an oracle — and an
    // uncaught exception on the authentication path.
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', 'a')).toBe(false);
  });
});

describe('cookies', () => {
  const attributes = {
    path: '/',
    maxAgeSeconds: 900,
    sameSite: 'Lax',
    secure: true,
  } as const;

  it('is always HttpOnly', () => {
    // Not configurable, and asserted so it cannot become configurable by accident: a session
    // credential readable by JavaScript turns any XSS on the origin into session theft.
    expect(serializeCookie('tmanage_session', 'value', attributes)).toContain('HttpOnly');
    expect(serializeCookie('tmanage_session', 'value', { ...attributes, secure: false })).toContain(
      'HttpOnly',
    );
  });

  it('emits the attributes in a form a browser accepts', () => {
    expect(serializeCookie('tmanage_session', 'abc', attributes)).toBe(
      'tmanage_session=abc; Path=/; Max-Age=900; SameSite=Lax; HttpOnly; Secure',
    );
  });

  it('omits Secure only when explicitly asked', () => {
    expect(serializeCookie('tmanage_session', 'abc', { ...attributes, secure: false })).not.toMatch(
      /; Secure/,
    );
  });

  it('refuses a value or name that would inject a header', () => {
    for (const value of ['a\r\nSet-Cookie: evil=1', 'a; Domain=evil.example', 'a\nb', 'a b']) {
      expect(() => serializeCookie('tmanage_session', value, attributes)).toThrow(TypeError);
    }
    expect(() => serializeCookie('tmanage session', 'abc', attributes)).toThrow(TypeError);
  });

  it('refuses SameSite=None without Secure, which browsers drop silently', () => {
    expect(() =>
      serializeCookie('tmanage_session', 'abc', {
        ...attributes,
        sameSite: 'None',
        secure: false,
      }),
    ).toThrow(TypeError);
  });

  it('clears a cookie with the same Path and SameSite it was set with', () => {
    // A differently-scoped clear is a different cookie to the browser, and leaves the
    // original in place — a sign-out that looks like it worked.
    const cleared = expireCookie('tmanage_session_refresh', {
      path: '/api/auth/refresh',
      sameSite: 'Strict',
      secure: true,
    });
    expect(cleared).toBe(
      'tmanage_session_refresh=; Path=/api/auth/refresh; Max-Age=0; SameSite=Strict; HttpOnly; Secure',
    );
  });

  it('never emits a negative Max-Age', () => {
    expect(serializeCookie('a', 'b', { ...attributes, maxAgeSeconds: -5 })).toContain('Max-Age=0');
  });
});

describe('readCookie', () => {
  it('finds a cookie among others', () => {
    expect(readCookie('theme=dark; tmanage_session=abc; locale=en', 'tmanage_session')).toBe('abc');
  });

  it('returns undefined for a missing cookie or a missing header', () => {
    expect(readCookie('theme=dark', 'tmanage_session')).toBeUndefined();
    expect(readCookie(undefined, 'tmanage_session')).toBeUndefined();
    expect(readCookie('', 'tmanage_session')).toBeUndefined();
  });

  it('takes the first occurrence when a name appears twice', () => {
    // Duplicate names are what a path- or subdomain-shadowing attack produces. Taking the
    // last would let the attacker's copy win.
    expect(readCookie('tmanage_session=first; tmanage_session=second', 'tmanage_session')).toBe(
      'first',
    );
  });

  it('does not match a name by prefix', () => {
    expect(readCookie('tmanage_session_refresh=r', 'tmanage_session')).toBeUndefined();
  });
});
