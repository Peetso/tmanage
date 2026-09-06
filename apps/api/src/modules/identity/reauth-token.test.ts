import { describe, expect, it } from 'vitest';
import { signChallengeToken } from './challenge-token.js';
import { REAUTH_TTL_SECONDS, signReauthToken, verifyReauthToken } from './reauth-token.js';

const SECRET = 'a secret long enough to be plausible in a test';
const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const USER = '0198f0aa-0000-7000-8000-000000000001';
const SESSION = '0198f0aa-0000-7000-8000-00000000aaaa';

function token(overrides: Partial<{ userId: string; sessionId: string; expiresAt: Date }> = {}) {
  return signReauthToken(
    {
      userId: overrides.userId ?? USER,
      sessionId: overrides.sessionId ?? SESSION,
      expiresAt: overrides.expiresAt ?? new Date(NOW + 60_000),
    },
    SECRET,
  );
}

describe('signing', () => {
  it('round-trips the claims, session id included', () => {
    expect(verifyReauthToken(token(), SECRET, NOW)).toEqual({
      ok: true,
      claims: { userId: USER, sessionId: SESSION, expiresAt: new Date(NOW + 60_000) },
    });
  });

  it('is deterministic for the same claims and secret', () => {
    expect(token()).toBe(token());
  });

  it('refuses a user id or session id containing a dot', () => {
    expect(() => token({ userId: 'a.b' })).toThrow(TypeError);
    expect(() => token({ sessionId: 'a.b' })).toThrow(TypeError);
  });
});

describe('verification', () => {
  it('reports a missing token separately from a malformed one', () => {
    expect(verifyReauthToken(undefined, SECRET, NOW)).toEqual({ ok: false, rejection: 'missing' });
    expect(verifyReauthToken('', SECRET, NOW)).toEqual({ ok: false, rejection: 'missing' });
  });

  it.each([
    ['too few parts', 'r1.reauth.user.session.123'],
    ['too many parts', 'r1.reauth.user.session.123.sig.extra'],
    ['a wrong version', 'r9.reauth.user.session.123.sig'],
    ['a wrong purpose', 'r1.mfa.user.session.123.sig'],
    ['a non-numeric expiry', 'r1.reauth.user.session.soon.sig'],
    ['an empty user id', 'r1.reauth..session.123.sig'],
    ['an empty session id', 'r1.reauth.user..123.sig'],
  ])('rejects %s as malformed', (_name, value) => {
    expect(verifyReauthToken(value, SECRET, NOW)).toEqual({ ok: false, rejection: 'malformed' });
  });

  /**
   * The point of the purpose string. A challenge token is minted after the password alone;
   * if it verified here, a password would stand in for password-plus-code on the three
   * routes this token guards. It is refused before any signature is compared.
   */
  it('refuses a challenge token signed with the same secret', () => {
    const challenge = signChallengeToken(
      { userId: USER, expiresAt: new Date(NOW + 60_000) },
      SECRET,
    );
    expect(verifyReauthToken(challenge, SECRET, NOW)).toEqual({
      ok: false,
      rejection: 'malformed',
    });
  });

  it('refuses a token signed with another secret', () => {
    expect(verifyReauthToken(token(), 'a different secret', NOW)).toEqual({
      ok: false,
      rejection: 'bad_signature',
    });
  });

  it('refuses a tampered session id', () => {
    const parts = token().split('.');
    parts[3] = '0198f0aa-0000-7000-8000-00000000ffff';
    expect(verifyReauthToken(parts.join('.'), SECRET, NOW)).toEqual({
      ok: false,
      rejection: 'bad_signature',
    });
  });

  it('refuses an extended expiry', () => {
    const parts = token().split('.');
    parts[4] = String(NOW + 86_400_000);
    expect(verifyReauthToken(parts.join('.'), SECRET, NOW)).toEqual({
      ok: false,
      rejection: 'bad_signature',
    });
  });

  it('refuses an expired token, and treats the expiry instant as expired', () => {
    expect(verifyReauthToken(token({ expiresAt: new Date(NOW - 1) }), SECRET, NOW)).toEqual({
      ok: false,
      rejection: 'expired',
    });
    expect(verifyReauthToken(token({ expiresAt: new Date(NOW) }), SECRET, NOW)).toEqual({
      ok: false,
      rejection: 'expired',
    });
  });

  it('reports a bad signature rather than expiry for a forged expired token', () => {
    const forged = signReauthToken(
      { userId: USER, sessionId: SESSION, expiresAt: new Date(NOW - 1) },
      'a different secret',
    );
    expect(verifyReauthToken(forged, SECRET, NOW)).toEqual({
      ok: false,
      rejection: 'bad_signature',
    });
  });

  it('is short-lived by construction', () => {
    expect(REAUTH_TTL_SECONDS).toBe(300);
  });
});
