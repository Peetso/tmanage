import { describe, expect, it, vi } from 'vitest';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';
import type { UserMfaFactorRow, UserPasswordRow } from '../../common/database/schema.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { AuthenticationController } from './authentication.controller.js';
import { AuthenticationRejectedError, AuthenticationService } from './authentication.service.js';
import type { CredentialsRepository } from './credentials.repository.js';
import { NON_CREDENTIAL_FAILURE_REASONS } from './credentials.repository.js';
import { signChallengeToken } from './challenge-token.js';
import { hashInvitationToken } from './invitation-token.js';
import { hashPassword } from './password.js';
import { PasswordResetController } from './password-reset.controller.js';
import type { PasswordResetRepository, ResetTarget } from './password-reset.repository.js';
import { PasswordResetService } from './password-reset.service.js';
import {
  newResetSignInGrant,
  openResetSignInGrant,
  RESET_SIGN_IN_GRANT_COOKIE,
  sealResetSignInGrant,
} from './reset-sign-in-grant.js';
import type { SessionService } from './session.service.js';
import type { SessionsRepository } from './sessions.repository.js';
import { createSignInAbuseControl } from './sign-in-abuse-control.js';
import { base32Decode, hotpCode, totpCounterAt } from './totp.js';

/**
 * N01 (security run 3, wave 11, lane Q2) - the lockout a guesser re-arms right after a reset.
 *
 * Exploit: the holder resets the password by email; a guesser rotating source addresses posts
 * five wrong passwords within seconds, the durable window is full again, and F20 refuses the
 * holder's correct new password. Fix: the reset hands the browser that completed it a sealed,
 * single-use grant in an `HttpOnly` cookie; the correct password with that grant passes a full
 * window once. Every case below replays one step of the exploit or one way to abuse the grant
 * against an in-memory `authentication_events` table that follows the repository's own rules.
 */

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_wave11_q2_test';
// The reset controller stamps the grant with the real clock, so the test clock starts there.
const T0 = Date.now();
const NEW_PASSWORD = 'violet-harbour-lantern-41';
const OLD_PASSWORD = 'amber-quarry-whistle-17';
const MAX_FAILURES = 5;
const WINDOW_SECONDS = 900;

const ALICE: ResetTarget = {
  userId: '0198f0cc-0000-7000-8000-00000000a11c',
  email: 'alice@example.test',
  displayName: 'Alice',
  locale: 'en',
};
const BOB: ResetTarget = {
  userId: '0198f0cc-0000-7000-8000-000000000b0b',
  email: 'bob@example.test',
  displayName: 'Bob',
  locale: 'en',
};

interface EventRow {
  readonly userId: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly at: number;
}

const SIGN_IN_ACTIONS = ['password_sign_in', 'mfa_challenge', 'recovery_code', 'google_sign_in'];

/** The `authentication_events` rules the repository's SQL encodes, over an array. */
function world() {
  let clock = T0;
  const events: EventRow[] = [];
  const passwords = new Map<string, UserPasswordRow>();
  const factors = new Map<string, UserMfaFactorRow[]>();
  const accounts = [ALICE, BOB];

  const credentials = {
    findUserIdByEmail: (_r: IdentityQueryRunner, email: string) => {
      const account = accounts.find((a) => a.email === email.trim().toLowerCase());
      return Promise.resolve(
        account ? { id: account.userId, displayName: account.displayName } : null,
      );
    },
    findPassword: (_r: IdentityQueryRunner, userId: string) =>
      Promise.resolve(passwords.get(userId) ?? null),
    setPassword: (_r: IdentityQueryRunner, userId: string, passwordHash: string) => {
      passwords.set(userId, {
        userId,
        passwordHash,
        setAt: new Date(clock),
        updatedAt: new Date(clock),
      });
      return Promise.resolve();
    },
    rehashPassword: () => Promise.resolve(true),
    listActiveFactors: (_r: IdentityQueryRunner, userId: string) =>
      Promise.resolve(factors.get(userId) ?? []),
    recordAuthenticationEvent: (
      _r: IdentityQueryRunner,
      input: {
        userId?: string | null;
        action: string;
        outcome: string;
        reason?: string | null;
        ip?: string | null;
      },
    ) => {
      events.push({
        userId: input.userId ?? null,
        action: input.action,
        outcome: input.outcome,
        reason: input.reason ?? null,
        ip: input.ip ?? null,
        at: clock,
      });
      return Promise.resolve();
    },
    recordCredentialChange: (
      _r: IdentityQueryRunner,
      input: { userId: string; action: string },
    ) => {
      events.push({
        userId: input.userId,
        action: input.action,
        outcome: 'succeeded',
        reason: null,
        ip: null,
        at: clock,
      });
      return Promise.resolve();
    },
    findLatestPasswordSetAt: (_r: IdentityQueryRunner, userId: string) => {
      const stamps = events
        .filter(
          (e) => e.userId === userId && e.action === 'password_set' && e.outcome === 'succeeded',
        )
        .map((e) => e.at);
      return Promise.resolve(stamps.length === 0 ? null : new Date(Math.max(...stamps)));
    },
    hasSucceededSignInSince: (_r: IdentityQueryRunner, userId: string, at: Date) =>
      Promise.resolve(
        events.some(
          (e) =>
            e.userId === userId &&
            e.outcome === 'succeeded' &&
            SIGN_IN_ACTIONS.includes(e.action) &&
            e.at >= at.getTime(),
        ),
      ),
    recordFactorUse: () => Promise.resolve(true),
    countSecondFactorAttemptsSince: (_r: IdentityQueryRunner, userId: string, at: Date) => {
      const rows = events.filter(
        (e) =>
          e.userId === userId &&
          (e.action === 'mfa_challenge' || e.action === 'recovery_code') &&
          e.at >= at.getTime(),
      );
      return Promise.resolve({
        succeeded: rows.filter((e) => e.outcome === 'succeeded').length,
        failed: rows.filter(
          (e) =>
            e.outcome === 'failed' &&
            (e.reason === null ||
              !(NON_CREDENTIAL_FAILURE_REASONS as readonly string[]).includes(e.reason)),
        ).length,
      });
    },
    countRecentFailures: async (r: IdentityQueryRunner, userId: string, windowSeconds: number) => {
      const windowStart = clock - windowSeconds * 1000;
      const latest = await credentials.findLatestPasswordSetAt(r, userId);
      const bound = Math.max(windowStart, latest?.getTime() ?? windowStart);
      return events.filter(
        (e) =>
          e.userId === userId &&
          e.outcome === 'failed' &&
          (e.reason === null ||
            !(NON_CREDENTIAL_FAILURE_REASONS as readonly string[]).includes(e.reason)) &&
          e.at >= bound,
      ).length;
    },
  };

  const runner = {} as IdentityQueryRunner;
  const database = {
    identityRead: <T>(_o: unknown, work: (db: IdentityQueryRunner) => Promise<T>) => work(runner),
    identityTransaction: <T>(_o: unknown, work: (tx: IdentityQueryRunner) => Promise<T>) =>
      work(runner),
  } as unknown as TenantDatabase;

  const auth = new AuthenticationService(
    database,
    {
      sessionSecret: SESSION_SECRET,
      maxFailuresInWindow: MAX_FAILURES,
      failureWindowSeconds: WINDOW_SECONDS,
      totpIssuer: 'TManage',
      abuseControl: createSignInAbuseControl({
        windowMs: 300_000,
        maxPerSource: 1000,
        maxPerSourceAccount: 1000,
        maxGlobal: 10_000,
        now: () => clock,
      }),
    },
    credentials as unknown as CredentialsRepository,
    () => clock,
    { revokeAllForUser: () => Promise.resolve(0) } as unknown as SessionsRepository,
    { revokeAllForUser: () => Promise.resolve({ personalAccessTokens: 0, grants: 0 }) },
  );

  const tokens = new Map<string, ResetTarget>();
  const resets = new PasswordResetService(
    database,
    null,
    {
      findLive: (_r: unknown, hash: string) => Promise.resolve(tokens.get(hash) ?? null),
      spend: (_r: unknown, hash: string) => Promise.resolve(tokens.delete(hash)),
    } as unknown as PasswordResetRepository,
    credentials as unknown as CredentialsRepository,
    { revokeAllForUser: () => Promise.resolve(0) } as unknown as SessionsRepository,
    { revokeAllForUser: () => Promise.resolve({ personalAccessTokens: 0, grants: 0 }) },
  );
  const resetController = new PasswordResetController(resets, () => true, {
    sessionSecret: SESSION_SECRET,
  });

  return {
    auth,
    events,
    factors,
    credentials,
    tick(ms = 1000) {
      clock += ms;
    },
    now: () => clock,
    async seed(account: ResetTarget) {
      passwords.set(account.userId, {
        userId: account.userId,
        passwordHash: await hashPassword(OLD_PASSWORD),
        setAt: new Date(T0 - 86_400_000),
        updatedAt: new Date(T0 - 86_400_000),
      });
    },
    /** Completes a reset through the real controller; returns the grant cookie's value. */
    async reset(account: ResetTarget): Promise<{ grant: string; setCookie: string }> {
      const token = `${account.userId.slice(-4)}${'R'.repeat(39)}`;
      tokens.set(hashInvitationToken(token), account);
      const headers: string[] = [];
      const request = { headers: {}, ip: '198.51.100.1' };
      requireRequestState(request);
      await resetController.complete(
        request,
        { token, password: NEW_PASSWORD },
        { header: (_n: string, v: string | readonly string[]) => headers.push(String(v)) },
      );
      const setCookie = headers.find((h) => h.startsWith(`${RESET_SIGN_IN_GRANT_COOKIE}=`)) ?? '';
      const grant = setCookie.split(';')[0]!.slice(RESET_SIGN_IN_GRANT_COOKIE.length + 1);
      return { grant, setCookie };
    },
    /** One guess from its own source address, as the rotating attacker sends it. */
    async guessWrong(account: ResetTarget, n: number) {
      for (let i = 0; i < n; i += 1) {
        tick1();
        await auth
          .signInWithPassword({
            email: account.email,
            password: `wrong-guess-${i}`,
            context: { correlationId: `c-${i}`, ip: `203.0.113.${10 + i}` },
          })
          .catch(() => undefined);
      }
    },
    signIn(account: ResetTarget, password: string, resetGrant?: string) {
      tick1();
      return auth.signInWithPassword({
        email: account.email,
        password,
        context: { correlationId: 'c-holder', ip: '198.51.100.1' },
        resetGrant,
      });
    },
  };

  function tick1() {
    clock += 1000;
  }
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(AuthenticationRejectedError);
      const refused = error as AuthenticationRejectedError;
      return { rejection: refused.rejection, reason: refused.reason };
    },
  );

const LOCKED = { rejection: 'rate_limited', reason: 'locked_out' };

describe('N01 (wave 11): the reset sign-in grant', () => {
  it('(i) reset, five failures from five sources, then the correct password with the grant: admitted once', async () => {
    const w = world();
    await w.seed(ALICE);
    const { grant, setCookie } = await w.reset(ALICE);
    expect(grant.length).toBeGreaterThan(0);
    // httpOnly, Secure, SameSite=Lax, scoped to the password sign-in route, 900 s.
    expect(setCookie).toContain('Path=/v1/auth/password');
    expect(setCookie).toContain('Max-Age=900');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');

    await w.guessWrong(ALICE, 5);
    const sources = new Set(w.events.filter((e) => e.reason === 'bad_password').map((e) => e.ip));
    expect(sources.size).toBe(5);

    await expect(w.signIn(ALICE, NEW_PASSWORD, grant)).resolves.toEqual({
      status: 'authenticated',
      userId: ALICE.userId,
    });
    const success = w.events.filter(
      (e) => e.action === 'password_sign_in' && e.outcome === 'succeeded',
    );
    expect(success).toHaveLength(1);
    expect(success[0]!.reason).toBe('reset_grant');
  });

  it('(ii) the same grant again after that success: locked_out', async () => {
    const w = world();
    await w.seed(ALICE);
    const { grant } = await w.reset(ALICE);
    await w.guessWrong(ALICE, 5);
    await w.signIn(ALICE, NEW_PASSWORD, grant);
    await w.guessWrong(ALICE, 1);
    expect(await rejection(w.signIn(ALICE, NEW_PASSWORD, grant))).toEqual(LOCKED);
  });

  it('(iii) no grant and a full window with the correct password: locked_out (F20 kept)', async () => {
    const w = world();
    await w.seed(ALICE);
    await w.reset(ALICE);
    await w.guessWrong(ALICE, 5);
    expect(await rejection(w.signIn(ALICE, NEW_PASSWORD))).toEqual(LOCKED);
    // The same with a cookie value that is not a grant at all.
    expect(await rejection(w.signIn(ALICE, NEW_PASSWORD, 'garbage'))).toEqual(LOCKED);
  });

  it('(iv) user A’s grant presented for user B has no effect', async () => {
    const w = world();
    await w.seed(ALICE);
    await w.seed(BOB);
    const alice = await w.reset(ALICE);
    await w.reset(BOB);
    await w.guessWrong(BOB, 5);
    expect(await rejection(w.signIn(BOB, NEW_PASSWORD, alice.grant))).toEqual(LOCKED);
  });

  it('(iv) a forged, tampered or expired grant has no effect', async () => {
    const w = world();
    await w.seed(ALICE);
    const { grant } = await w.reset(ALICE);
    await w.guessWrong(ALICE, 5);
    const passwordSetAt = (await w.credentials.findLatestPasswordSetAt(
      {} as IdentityQueryRunner,
      ALICE.userId,
    ))!;

    // Forged: the right payload sealed with a key the server does not hold.
    const forged = sealResetSignInGrant(
      newResetSignInGrant({ userId: ALICE.userId, passwordSetAt }, w.now()),
      'not_the_session_secret_at_all_but_long_enough',
    );
    // Tampered: a genuine grant's signature over a payload naming another reset time.
    const [, signature] = grant.split('.');
    const altered = Buffer.from(
      JSON.stringify({
        ...openResetSignInGrant(grant, SESSION_SECRET, w.now())!,
        passwordSetAt: 1,
      }),
      'utf8',
    ).toString('base64url');
    const tampered = `${altered}.${signature}`;
    // Expired: correctly sealed, but issued 901 s ago.
    const expired = sealResetSignInGrant(
      newResetSignInGrant({ userId: ALICE.userId, passwordSetAt }, w.now() - 901_000),
      SESSION_SECRET,
    );

    for (const bad of [forged, tampered, expired, `${grant}x`, `${grant}.extra`]) {
      expect(await rejection(w.signIn(ALICE, NEW_PASSWORD, bad))).toEqual(LOCKED);
    }
    // And the genuine one still works - none of the above spent it.
    await expect(w.signIn(ALICE, NEW_PASSWORD, grant)).resolves.toMatchObject({
      status: 'authenticated',
    });
  });

  it('(iv) a stale grant - an older passwordSetAt after a second reset - has no effect', async () => {
    const w = world();
    await w.seed(ALICE);
    const first = await w.reset(ALICE);
    w.tick(5000);
    const second = await w.reset(ALICE);
    await w.guessWrong(ALICE, 5);
    expect(await rejection(w.signIn(ALICE, NEW_PASSWORD, first.grant))).toEqual(LOCKED);
    await expect(w.signIn(ALICE, NEW_PASSWORD, second.grant)).resolves.toMatchObject({
      status: 'authenticated',
    });
  });

  it('(v) a wrong password with a valid grant is rejected and counts', async () => {
    const w = world();
    await w.seed(ALICE);
    const { grant } = await w.reset(ALICE);
    const runner = {} as IdentityQueryRunner;

    // Below the bound: an ordinary failure, recorded as bad_password and counted.
    expect(await rejection(w.signIn(ALICE, 'not-the-password', grant))).toEqual({
      rejection: 'invalid_credentials',
      reason: 'bad_password',
    });
    expect(await w.credentials.countRecentFailures(runner, ALICE.userId, WINDOW_SECONDS)).toBe(1);

    // In a full window: locked_out, and the refusal is recorded against the account.
    await w.guessWrong(ALICE, 4);
    expect(await rejection(w.signIn(ALICE, 'still-not-it', grant))).toEqual(LOCKED);
    const last = w.events[w.events.length - 1]!;
    expect(last).toMatchObject({ userId: ALICE.userId, outcome: 'failed', reason: 'locked_out' });
    // No failure spent the grant: there is still no succeeded sign-in since the reset.
    expect(w.events.some((e) => e.outcome === 'succeeded' && e.action === 'password_sign_in')).toBe(
      false,
    );
  });

  it('(vi) an account with MFA plus a grant still gets the second-factor challenge', async () => {
    const w = world();
    await w.seed(ALICE);
    w.factors.set(ALICE.userId, [
      {
        id: '0198f0cc-0000-7000-8000-0000000000f1',
        userId: ALICE.userId,
        kind: 'totp',
        label: 'Phone',
        secret: 'JBSWY3DPEHPK3PXP',
        confirmedAt: new Date(T0 - 86_400_000),
        lastAcceptedCounter: null,
        lastUsedAt: null,
        createdAt: new Date(T0 - 86_400_000),
        disabledAt: null,
      },
    ]);
    const { grant } = await w.reset(ALICE);
    await w.guessWrong(ALICE, 5);
    const outcome = await w.signIn(ALICE, NEW_PASSWORD, grant);
    expect(outcome.status).toBe('mfa_required');
    expect(outcome).not.toHaveProperty('userId');
    // The password step's succeeded row spends the grant: it does not open a second time.
    expect(await rejection(w.signIn(ALICE, NEW_PASSWORD, grant))).toEqual(LOCKED);
  });
});

describe('N01 (wave 12): the grant carries on to the second-factor step', () => {
  const SECRET_B32 = 'JBSWY3DPEHPK3PXP';
  const codeAt = (ms: number) => hotpCode(base32Decode(SECRET_B32)!, totpCounterAt(ms));
  function withFactor(w: ReturnType<typeof world>) {
    w.factors.set(ALICE.userId, [
      {
        id: '0198f0cc-0000-7000-8000-0000000000f1',
        userId: ALICE.userId,
        kind: 'totp',
        label: 'Phone',
        secret: SECRET_B32,
        confirmedAt: new Date(T0 - 86_400_000),
        lastAcceptedCounter: null,
        lastUsedAt: null,
        createdAt: new Date(T0 - 86_400_000),
        disabledAt: null,
      },
    ]);
  }
  const challengeOf = (
    outcome: Awaited<ReturnType<AuthenticationService['signInWithPassword']>>,
  ) => {
    if (outcome.status !== 'mfa_required') throw new Error('expected an MFA challenge');
    return outcome.challengeToken;
  };

  it('(vii) a challenge minted through the grant passes a full window once, then locks again', async () => {
    const w = world();
    await w.seed(ALICE);
    withFactor(w);
    const { grant } = await w.reset(ALICE);
    await w.guessWrong(ALICE, 5);
    const challengeToken = challengeOf(await w.signIn(ALICE, NEW_PASSWORD, grant));
    const context = { correlationId: 'c-holder', ip: '198.51.100.1' };

    await expect(
      w.auth.completeMfaChallenge({ challengeToken, code: codeAt(w.now()), context }),
    ).resolves.toEqual({ status: 'authenticated', userId: ALICE.userId });

    // Single-use: the same challenge, a fresh code, the window still full - refused.
    w.tick(30_000);
    expect(
      await rejection(
        w.auth.completeMfaChallenge({ challengeToken, code: codeAt(w.now()), context }),
      ),
    ).toEqual(LOCKED);
    expect(
      await rejection(w.auth.completeWithRecoveryCode({ challengeToken, code: 'x', context })),
    ).toEqual(LOCKED);
  });

  it('(vii) a challenge minted without the grant still refuses a full window', async () => {
    const w = world();
    await w.seed(ALICE);
    withFactor(w);
    await w.reset(ALICE);
    await w.guessWrong(ALICE, 5);
    const challengeToken = signChallengeToken(
      { userId: ALICE.userId, expiresAt: new Date(w.now() + 60_000) },
      SESSION_SECRET,
    );
    const context = { correlationId: 'c-holder', ip: '198.51.100.1' };
    expect(
      await rejection(
        w.auth.completeMfaChallenge({ challengeToken, code: codeAt(w.now()), context }),
      ),
    ).toEqual(LOCKED);
    expect(
      await rejection(w.auth.completeWithRecoveryCode({ challengeToken, code: 'x', context })),
    ).toEqual(LOCKED);
  });
});

describe('N01 (wave 11): the grant travels only in its cookie', () => {
  function controller() {
    const signInWithPassword = vi.fn(() =>
      Promise.reject(new AuthenticationRejectedError('rate_limited', 'locked_out')),
    );
    const sessions = { start: vi.fn() } as unknown as SessionService;
    const ctrl = new AuthenticationController(
      { signInWithPassword } as unknown as AuthenticationService,
      sessions,
    );
    return { ctrl, signInWithPassword };
  }

  it('reads the grant from the cookie, ignores a body copy, and clears it even on a refusal', async () => {
    const { ctrl, signInWithPassword } = controller();
    const headers: string[] = [];
    const request = {
      headers: { cookie: `tm_session=abc; ${RESET_SIGN_IN_GRANT_COOKIE}=from-cookie` },
      ip: '198.51.100.1',
    };
    requireRequestState(request);
    await expect(
      ctrl.signInWithPassword(
        { email: 'alice@example.test', password: NEW_PASSWORD, resetGrant: 'from-body' } as never,
        request,
        { header: (_n: string, v: string | readonly string[]) => headers.push(String(v)) },
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(signInWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({ resetGrant: 'from-cookie' }),
    );
    expect(headers).toEqual([
      expect.stringMatching(/^tm_reset_grant=; Path=\/v1\/auth\/password; Max-Age=0;/u),
    ]);
  });

  it('without the cookie passes no grant and sets no cookie', async () => {
    const { ctrl, signInWithPassword } = controller();
    const headers: string[] = [];
    const request = { headers: {}, ip: '198.51.100.1' };
    requireRequestState(request);
    await ctrl
      .signInWithPassword(
        { email: 'alice@example.test', password: NEW_PASSWORD, resetGrant: 'from-body' } as never,
        request,
        { header: (_n: string, v: string | readonly string[]) => headers.push(String(v)) },
      )
      .catch(() => undefined);
    expect(signInWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({ resetGrant: undefined }),
    );
    expect(headers).toEqual([]);
  });

  it('a reset controller without the sealing key issues no grant', async () => {
    const complete = vi.fn(() =>
      Promise.resolve({ userId: ALICE.userId, passwordSetAt: new Date(T0) }),
    );
    const bare = new PasswordResetController(
      { complete } as unknown as PasswordResetService,
      () => true,
    );
    const headers: string[] = [];
    const request = { headers: {}, ip: '198.51.100.1' };
    requireRequestState(request);
    await expect(
      bare.complete(
        request,
        { token: 'x', password: 'y' },
        {
          header: (_n: string, v: string | readonly string[]) => headers.push(String(v)),
        },
      ),
    ).resolves.toBeUndefined();
    expect(headers).toEqual([]);
  });
});
