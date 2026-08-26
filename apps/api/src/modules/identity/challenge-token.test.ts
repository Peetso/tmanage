import { describe, expect, it } from 'vitest';
import { loadEnv } from '@tmanage/config';
import {
  CHALLENGE_TTL_SECONDS,
  signChallengeToken,
  verifyChallengeToken,
} from './challenge-token.js';
import { ARGON2_PARAMETERS } from './password.js';

const SECRET = 'a secret long enough to be plausible in a test';
const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);

function token(overrides: Partial<{ userId: string; expiresAt: Date }> = {}): string {
  return signChallengeToken(
    {
      userId: overrides.userId ?? '0198f0aa-0000-7000-8000-000000000001',
      expiresAt: overrides.expiresAt ?? new Date(NOW + 60_000),
    },
    SECRET,
  );
}

describe('signing', () => {
  it('round-trips the claims', () => {
    const result = verifyChallengeToken(token(), SECRET, NOW);
    expect(result).toEqual({
      ok: true,
      claims: {
        userId: '0198f0aa-0000-7000-8000-000000000001',
        expiresAt: new Date(NOW + 60_000),
      },
    });
  });

  it('is deterministic for the same claims and secret', () => {
    expect(token()).toBe(token());
  });

  /**
   * The format is dot-delimited, so a user id containing a dot could be re-split into
   * different claims carrying the same signature. UUIDs never contain one; the guard refuses
   * rather than assuming they never will.
   */
  it('refuses a user id containing a dot rather than producing an ambiguous token', () => {
    expect(() => signChallengeToken({ userId: 'a.b', expiresAt: new Date(NOW) }, SECRET)).toThrow(
      TypeError,
    );
  });
});

describe('verification', () => {
  it('reports a missing token separately from a malformed one', () => {
    expect(verifyChallengeToken(undefined, SECRET, NOW)).toEqual({
      ok: false,
      rejection: 'missing',
    });
    expect(verifyChallengeToken('', SECRET, NOW)).toEqual({ ok: false, rejection: 'missing' });
  });

  it.each([
    ['too few parts', 'c1.mfa.user.123'],
    ['too many parts', 'c1.mfa.user.123.sig.extra'],
    ['a wrong version', 'c9.mfa.user.123.sig'],
    ['a wrong purpose', 'c1.session.user.123.sig'],
    ['a non-numeric expiry', 'c1.mfa.user.soon.sig'],
    ['an empty user id', 'c1.mfa..123.sig'],
  ])('rejects %s as malformed', (_name, value) => {
    expect(verifyChallengeToken(value, SECRET, NOW)).toEqual({
      ok: false,
      rejection: 'malformed',
    });
  });

  it('refuses a token signed with another secret', () => {
    expect(verifyChallengeToken(token(), 'a different secret', NOW)).toEqual({
      ok: false,
      rejection: 'bad_signature',
    });
  });

  it('refuses a tampered user id', () => {
    const parts = token().split('.');
    parts[2] = '0198f0aa-0000-7000-8000-00000000ffff';
    expect(verifyChallengeToken(parts.join('.'), SECRET, NOW).ok).toBe(false);
  });

  it('refuses an extended expiry', () => {
    const parts = token().split('.');
    parts[3] = String(NOW + 86_400_000);
    expect(verifyChallengeToken(parts.join('.'), SECRET, NOW)).toEqual({
      ok: false,
      rejection: 'bad_signature',
    });
  });

  it('refuses an expired token', () => {
    const stale = token({ expiresAt: new Date(NOW - 1) });
    expect(verifyChallengeToken(stale, SECRET, NOW)).toEqual({
      ok: false,
      rejection: 'expired',
    });
  });

  it('treats the expiry instant itself as expired', () => {
    const edge = token({ expiresAt: new Date(NOW) });
    expect(verifyChallengeToken(edge, SECRET, NOW)).toEqual({ ok: false, rejection: 'expired' });
  });

  /**
   * The signature is checked before the expiry. Reporting `expired` for a value whose
   * signature does not verify would tell an attacker their forgery was structurally correct.
   */
  it('reports a bad signature rather than expiry for a forged expired token', () => {
    const forged = signChallengeToken(
      { userId: 'u', expiresAt: new Date(NOW - 1) },
      'a different secret',
    );
    expect(verifyChallengeToken(forged, SECRET, NOW)).toEqual({
      ok: false,
      rejection: 'bad_signature',
    });
  });

  it('is short-lived by construction', () => {
    // Five minutes. Long enough to find a phone; short enough that a token captured from a
    // log is usually already dead.
    expect(CHALLENGE_TTL_SECONDS).toBe(300);
    expect(CHALLENGE_TTL_SECONDS).toBeLessThanOrEqual(600);
  });
});

/**
 * `password.ts` is pure and reads no environment, so its Argon2 parameters are constants. But
 * `packages/config` has carried `PASSWORD_ARGON2_*` since before ID-002 was written, and two
 * numbers free to disagree eventually will. This asserts they do not.
 *
 * The direction matters: the constants are the floor. Config raising the cost is a change
 * this codebase should adopt, and this test failing is how it gets noticed.
 */
describe('the Argon2 parameters agree with packages/config', () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'mysql://tmanage_app:pw@127.0.0.1:3306/tmanage',
    REDIS_URL: 'redis://127.0.0.1:6379',
    API_PUBLIC_URL: 'http://localhost:4000',
    WEB_PUBLIC_URL: 'http://localhost:3000',
    SESSION_SECRET: 'local_dev_only_session_secret_change_me_00000000000',
    CSRF_SECRET: 'local_dev_only_csrf_secret_change_me_0000000000',
    STORAGE_BUCKET: 'tmanage-local',
    STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
    STORAGE_ACCESS_KEY_ID: 'local',
    STORAGE_SECRET_ACCESS_KEY: 'local_secret',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
    DATABASE_MIGRATION_URL: 'mysql://tmanage_migrator:pw@127.0.0.1:3306/tmanage',
    EMAIL_FROM_ADDRESS: 'no-reply@tmanage.example',
  });

  it('uses the same memory cost', () => {
    expect(ARGON2_PARAMETERS.memoryCost).toBe(env.PASSWORD_ARGON2_MEMORY_KIB);
  });

  it('uses the same time cost', () => {
    expect(ARGON2_PARAMETERS.timeCost).toBe(env.PASSWORD_ARGON2_TIME_COST);
  });

  it('uses the same parallelism', () => {
    expect(ARGON2_PARAMETERS.parallelism).toBe(env.PASSWORD_ARGON2_PARALLELISM);
  });
});
