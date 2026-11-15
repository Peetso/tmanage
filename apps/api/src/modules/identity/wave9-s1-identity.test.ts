import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import { ApiError } from '../../common/http/errors.js';
import { CsrfGuard } from '../../common/http/guards/csrf.guard.js';
import { requireRequestState } from '../../common/http/request-state.js';
import type { RequestState } from '../../common/http/request-state.js';
import type { UserMfaFactorRow, UserPasswordRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  IdentityQueryRunner,
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { PasswordResetMailer } from '../../common/email/password-reset-email.js';
import { OAuthTokenController } from '../oauth/token.controller.js';
import { GrantsRepository } from '../oauth/grants.repository.js';
import { OauthTokensRepository } from '../oauth/oauth-tokens.repository.js';
import { PersonalAccessTokensRepository } from '../personal-access-tokens/personal-access-tokens.repository.js';
import { PublicSignupController } from '../signup/public-signup.controller.js';
import { AuthenticationController, CredentialsController } from './authentication.controller.js';
import {
  AuthenticationRejectedError,
  AuthenticationService,
  FreshSignInRequiredError,
  ReauthenticationRequiredError,
} from './authentication.service.js';
import {
  BEARER_CUTOFF_BOOTSTRAP_REASON,
  BearerCredentialsRevoker,
  type BearerCredentialCutoff,
} from './bearer-credentials.js';
import { signChallengeToken } from './challenge-token.js';
import { CredentialsRepository } from './credentials.repository.js';
import { hashPassword } from './password.js';
import type { PasswordResetRepository, ResetTarget } from './password-reset.repository.js';
import { createPasswordResetMailBudget, PasswordResetService } from './password-reset.service.js';
import { REAUTH_TTL_SECONDS, signReauthToken } from './reauth-token.js';
import { createSeedCipher } from './seed-cipher.js';
import { SessionController } from './session.controller.js';
import { SessionsRepository } from './sessions.repository.js';
import type { AccountStanding } from './sessions.repository.js';
import type { SignInAbuseControl } from './sign-in-abuse-control.js';
import { base32Decode, generateTotpSecret, hotpCode, totpCounterAt } from './totp.js';

/**
 * Wave 9, lane S1 — one regression per security-audit finding (run 1): F01, F19, F20, F32, F43
 * and lead NV11. Each case replays the audit's exploit step against fakes and shows it now fails,
 * beside the legitimate case that must keep working.
 */

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_wave9_s1_test';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_wave9_s1_test';
const USER = '0198f0cc-0000-7000-8000-000000000001';
const SESSION = '0198f0cc-0000-7000-8000-0000000000a1';
const ORG_A = '0198f0cc-0000-7000-8000-0000000000d1';
const ORG_B = '0198f0cc-0000-7000-8000-0000000000d2';
const NOW = 1_757_000_000_000;
const CONTEXT = { correlationId: '0198f0cc-0000-7000-8000-0000000000c1', ip: '203.0.113.9' };
const STRONG = 'violet-harbour-lantern-41';
const WEB = 'https://tmanage.example.test';

/** Obviously fake: a byte repeated thirty-two times. Nothing here is a real key. */
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x22).toString('base64url')}`));
const SECRET = generateTotpSecret();
const codeAt = (atMs: number): string =>
  hotpCode(base32Decode(SECRET)!, totpCounterAt(atMs, 30), { digits: 6, algorithm: 'SHA1' });
/** A code from an hour ago: well formed, never accepted now. */
const WRONG_CODE = codeAt(NOW - 3_600_000);

const FACTOR: UserMfaFactorRow = {
  id: '0198f0cc-0000-7000-8000-0000000000f1',
  userId: USER,
  kind: 'totp',
  label: 'Phone',
  secret: SECRET,
  confirmedAt: new Date(NOW - 86_400_000),
  lastAcceptedCounter: null,
  lastUsedAt: null,
  createdAt: new Date(NOW - 86_400_000),
  disabledAt: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

class FakeCredentials extends CredentialsRepository {
  password: UserPasswordRow | null = null;
  factors: readonly UserMfaFactorRow[] = [];
  /** Answers to successive `countRecentFailures` calls; the last one repeats. */
  failures: number[] = [0];
  readonly calls: string[] = [];
  readonly events: { action: string; outcome: string; reason: string | null }[] = [];

  constructor() {
    super(CIPHER);
  }

  override async findUserIdByEmail(): Promise<{ id: string; displayName: string } | null> {
    return { id: USER, displayName: 'Sara' };
  }
  override async findPassword(): Promise<UserPasswordRow | null> {
    return this.password;
  }
  override async findPasswordIdentifiers(): Promise<{ email: string; displayName: string }> {
    return { email: 'sara.harbour@example.test', displayName: 'Sara Harbour' };
  }
  override async countRecentFailures(): Promise<number> {
    this.calls.push('countRecentFailures');
    return this.failures.length > 1 ? this.failures.shift()! : this.failures[0]!;
  }
  override async listActiveFactors(): Promise<readonly UserMfaFactorRow[]> {
    this.calls.push('listActiveFactors');
    return this.factors;
  }
  override async recordFactorUse(): Promise<boolean> {
    this.calls.push('recordFactorUse');
    return true;
  }
  override async setPassword(): Promise<void> {
    this.calls.push('setPassword');
  }
  override async recordCredentialChange(): Promise<void> {
    this.calls.push('recordCredentialChange');
  }
  override async recordAuthenticationEvent(
    _runner: IdentityQueryRunner,
    input: { action: string; outcome: string; reason?: string | null },
  ): Promise<void> {
    this.events.push({
      action: input.action,
      outcome: input.outcome,
      reason: input.reason ?? null,
    });
  }
}

class FakeSessions extends SessionsRepository {
  fresh = new Set<string>();
  readonly freshAsked: string[] = [];
  // ---- platform-admin v2 · PA-06 ---- An enabled account (0247): sign-in reads its standing.
  override async findStanding(): Promise<AccountStanding> {
    return { disabledAt: null, twoStepRequiredAt: null };
  }
  override async isEstablishedWithin(
    _runner: IdentityQueryRunner,
    input: { sessionId: string; userId: string; maxAgeSeconds: number },
  ): Promise<boolean> {
    this.freshAsked.push(`${input.sessionId}:${input.maxAgeSeconds}`);
    return this.fresh.has(input.sessionId);
  }
  override async revokeOthersForUser(): Promise<number> {
    return 1;
  }
}

class RecordingCutoff implements BearerCredentialCutoff {
  readonly calls: string[] = [];
  failWith: Error | null = null;
  revokeAllForUser(
    _database: unknown,
    input: { readonly userId: string },
  ): Promise<{ personalAccessTokens: number; grants: number }> {
    this.calls.push(input.userId);
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve({ personalAccessTokens: 1, grants: 1 });
  }
}

const RUNNER = {} as IdentityQueryRunner;
const identityDatabase = {
  identityRead: <T>(_o: unknown, work: (db: IdentityQueryRunner) => Promise<T>) => work(RUNNER),
  identityTransaction: <T>(_o: unknown, work: (tx: IdentityQueryRunner) => Promise<T>) =>
    work(RUNNER),
} as unknown as TenantDatabase;

function admitAll(): SignInAbuseControl & { admit: ReturnType<typeof vi.fn> } {
  return { admit: vi.fn(() => ({ admitted: true as const })) };
}

function service(abuse: SignInAbuseControl = admitAll()) {
  const credentials = new FakeCredentials();
  const sessions = new FakeSessions();
  const cutoff = new RecordingCutoff();
  const auth = new AuthenticationService(
    identityDatabase,
    {
      sessionSecret: SESSION_SECRET,
      maxFailuresInWindow: 5,
      failureWindowSeconds: 900,
      totpIssuer: 'TManage',
      abuseControl: abuse,
    },
    credentials,
    () => NOW,
    sessions,
    cutoff,
  );
  return { auth, credentials, sessions, cutoff };
}

const proof = (): string =>
  signReauthToken(
    { userId: USER, sessionId: SESSION, expiresAt: new Date(NOW + REAUTH_TTL_SECONDS * 1000) },
    SESSION_SECRET,
  );

function requestWith(
  scheme: RequestState['authScheme'],
  headers: Record<string, string> = {},
  method = 'POST',
) {
  const request = { method, headers, ip: '203.0.113.9' };
  const state = requireRequestState(request);
  if (scheme !== undefined) {
    state.authScheme = scheme;
    state.session =
      scheme === 'cookie'
        ? { sessionId: SESSION, userId: USER }
        : { sessionId: 'pat:t1', userId: USER };
  }
  return request;
}

function contextOf(request: object, controller: object, handler: unknown): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const guard = new CsrfGuard(
  new Reflector(),
  { csrfSecret: CSRF_SECRET, webPublicUrl: WEB, apiPublicUrl: WEB } as never,
  { recordGuardRefusal: vi.fn() } as never,
);

// ─────────────────────────────────────────────────────────────────────────────
// F01 — bound tokens on the credential and session routes; first password needs fresh proof
// ─────────────────────────────────────────────────────────────────────────────

describe('F01: a bound token never reaches the credential or session routes', () => {
  const credentialRoutes = [
    'reauthenticate',
    'setPassword',
    'beginTotpEnrolment',
    'confirmTotpEnrolment',
    'listFactors',
    'listCredentialChanges',
    'disableFactor',
    'regenerateRecoveryCodes',
  ] as const;
  const sessionRoutes = ['signOut', 'devices', 'revokeOthers', 'revokeOne'] as const;

  it.each(credentialRoutes)(
    'CsrfGuard refuses a PAT on CredentialsController.%s with 403',
    (name) => {
      const request = requestWith('personal_access_token');
      const handler = CredentialsController.prototype[name];
      expect(() => guard.canActivate(contextOf(request, CredentialsController, handler))).toThrow(
        expect.objectContaining({ status: 403, auditCode: 'session_required_for_credentials' }),
      );
    },
  );

  it.each(sessionRoutes)(
    'CsrfGuard refuses an AI grant on SessionController.%s with 403',
    (name) => {
      const request = requestWith('ai_grant', {}, name === 'devices' ? 'GET' : 'DELETE');
      const handler = SessionController.prototype[name];
      expect(() => guard.canActivate(contextOf(request, SessionController, handler))).toThrow(
        expect.objectContaining({ status: 403, auditCode: 'session_required_for_credentials' }),
      );
    },
  );

  it('the controller itself refuses a PAT on POST /v1/auth/password/set, and nothing is set', async () => {
    const setPassword = vi.fn();
    const controller = new CredentialsController({ setPassword } as never);
    const request = requestWith('personal_access_token');
    await expect(
      controller.setPassword(
        { sessionId: 'pat:t1', userId: USER } as never,
        { password: STRONG },
        request,
      ),
    ).rejects.toMatchObject({ status: 403, auditCode: 'session_required_for_credentials' });
    expect(setPassword).not.toHaveBeenCalled();
  });

  it('the controller refuses an AI grant on reauth too', async () => {
    const confirmReauthentication = vi.fn();
    const controller = new CredentialsController({ confirmReauthentication } as never);
    await expect(
      controller.reauthenticate(
        { sessionId: 'grant:g1', userId: USER } as never,
        { password: STRONG },
        requestWith('ai_grant'),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(confirmReauthentication).not.toHaveBeenCalled();
  });

  it('a cookie session still reaches the route, and a stale one gets 401 reauthentication_required', async () => {
    const setPassword = vi.fn(() => Promise.reject(new FreshSignInRequiredError()));
    const controller = new CredentialsController({ setPassword } as never);
    await expect(
      controller.setPassword(
        { sessionId: SESSION, userId: USER } as never,
        { password: STRONG },
        requestWith('cookie'),
      ),
    ).rejects.toMatchObject({ status: 401, code: 'reauthentication_required' });
    expect(setPassword).toHaveBeenCalledTimes(1);
  });

  it('a passwordless account cannot get a first password from a session older than 10 minutes', async () => {
    const { auth, credentials, sessions } = service();
    await expect(
      auth.setPassword({ userId: USER, sessionId: SESSION, password: STRONG, context: CONTEXT }),
    ).rejects.toBeInstanceOf(FreshSignInRequiredError);
    expect(sessions.freshAsked).toEqual([`${SESSION}:600`]);
    expect(credentials.calls).not.toContain('setPassword');
    expect(credentials.events).toEqual([
      { action: 'password_set', outcome: 'failed', reason: 'reauth_required' },
    ]);
  });

  it('a PAT principal (synthetic session id) is never a fresh sign-in', async () => {
    const { auth, credentials } = service();
    await expect(
      auth.setPassword({ userId: USER, sessionId: 'pat:t1', password: STRONG, context: CONTEXT }),
    ).rejects.toBeInstanceOf(FreshSignInRequiredError);
    expect(credentials.calls).not.toContain('setPassword');
  });

  it('a fresh Google sign-in sets the first password', async () => {
    const { auth, credentials, sessions, cutoff } = service();
    sessions.fresh.add(SESSION);
    await auth.setPassword({
      userId: USER,
      sessionId: SESSION,
      password: STRONG,
      context: CONTEXT,
    });
    expect(credentials.calls).toContain('setPassword');
    // A first password ends nothing: no bearer credential was opened against a stale password.
    expect(cutoff.calls).toEqual([]);
  });

  it('ACCOUNT item 4: a changed password meets the sign-up rules, the own name included', async () => {
    const { auth, credentials } = service();
    credentials.password = {
      userId: USER,
      passwordHash: 'x',
      setAt: new Date(),
      updatedAt: new Date(),
    };
    await expect(
      auth.setPassword({
        userId: USER,
        sessionId: SESSION,
        password: 'harbour-sara.harbour-2026',
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).rejects.toMatchObject({ rejections: expect.arrayContaining(['contains_identifier']) });
    expect(credentials.calls).not.toContain('setPassword');
  });

  it('an account with a password still needs the reauth token, fresh session or not', async () => {
    const { auth, credentials, sessions } = service();
    credentials.password = {
      userId: USER,
      passwordHash: 'x',
      setAt: new Date(),
      updatedAt: new Date(),
    };
    sessions.fresh.add(SESSION);
    await expect(
      auth.setPassword({ userId: USER, sessionId: SESSION, password: STRONG, context: CONTEXT }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
    expect(sessions.freshAsked).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F19 — recovery ends personal access tokens and AI grants too
// ─────────────────────────────────────────────────────────────────────────────

describe('F19: recovery ends every bearer credential', () => {
  it('a password change runs the bearer cutoff before and after the session cutoff', async () => {
    const { auth, credentials, cutoff } = service();
    credentials.password = {
      userId: USER,
      passwordHash: 'x',
      setAt: new Date(),
      updatedAt: new Date(),
    };
    await auth.setPassword({
      userId: USER,
      sessionId: SESSION,
      password: STRONG,
      reauthToken: proof(),
      context: CONTEXT,
    });
    expect(cutoff.calls).toEqual([USER, USER]);
  });

  it('a password change is refused whole when the cutoff fails', async () => {
    const { auth, credentials, cutoff } = service();
    credentials.password = {
      userId: USER,
      passwordHash: 'x',
      setAt: new Date(),
      updatedAt: new Date(),
    };
    cutoff.failWith = new Error('database unavailable');
    await expect(
      auth.setPassword({
        userId: USER,
        sessionId: SESSION,
        password: STRONG,
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).rejects.toThrow('database unavailable');
    expect(credentials.calls).not.toContain('setPassword');
  });

  it('"sign out other sessions" runs the bearer cutoff too', async () => {
    const { auth, cutoff } = service();
    await expect(
      auth.revokeOtherSessions({
        userId: USER,
        sessionId: SESSION,
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).resolves.toBe(1);
    expect(cutoff.calls).toEqual([USER, USER]);
  });

  it('the revoker ends tokens and grants in every organization, and the grants’ tokens', async () => {
    const tokens = new (class extends PersonalAccessTokensRepository {
      override async listOrganizationsWithLiveTokens(): Promise<readonly string[]> {
        return [ORG_A];
      }
      override async revokeAllForUser(
        _r: TenantQueryRunner,
        context: TenantContext,
        userId: string,
      ): Promise<number> {
        expect(userId).toBe(USER);
        return context.organizationId === ORG_A ? 2 : 0;
      }
    })();
    const grants = new (class extends GrantsRepository {
      override async listOrganizationsWithLiveGrants(): Promise<readonly string[]> {
        return [ORG_A, ORG_B];
      }
      override async revokeAllForUser(
        _r: TenantQueryRunner,
        context: TenantContext,
      ): Promise<readonly string[]> {
        return context.organizationId === ORG_A ? ['g1'] : ['g2', 'g3'];
      }
    })();
    const revokedFamilies: string[] = [];
    const oauthTokens = new (class extends OauthTokensRepository {
      override async revokeTokensByGrant(_r: IdentityQueryRunner, grantId: string): Promise<void> {
        revokedFamilies.push(grantId);
      }
    })();
    const bootstrap: { reason: string; tables: readonly string[] }[] = [];
    const transactions: string[] = [];
    const database = {
      bootstrapRead: <T>(
        options: { reason: string; tables: readonly string[] },
        work: (db: BootstrapQueryRunner) => Promise<T>,
      ) => {
        bootstrap.push(options);
        return work({} as BootstrapQueryRunner);
      },
      transaction: <T>(context: TenantContext, work: (tx: TenantQueryRunner) => Promise<T>) => {
        transactions.push(context.organizationId);
        return work({} as TenantQueryRunner);
      },
    } as unknown as TenantDatabase;

    const result = await new BearerCredentialsRevoker(tokens, grants, oauthTokens).revokeAllForUser(
      database,
      { userId: USER, correlationId: CONTEXT.correlationId },
    );

    expect(bootstrap).toEqual([
      {
        correlationId: CONTEXT.correlationId,
        reason: BEARER_CUTOFF_BOOTSTRAP_REASON,
        tables: ['personal_access_tokens', 'oauth_grants'],
      },
    ]);
    expect(transactions).toEqual([ORG_A, ORG_B]);
    expect(revokedFamilies).toEqual(['g1', 'g2', 'g3']);
    expect(result).toEqual({ personalAccessTokens: 2, grants: 3 });
  });

  function resetHarness(cutoff: RecordingCutoff, budget = createPasswordResetMailBudget()) {
    const target: ResetTarget = {
      userId: USER,
      email: 'sara@example.com',
      displayName: 'Sara Nabil',
      locale: 'en',
    };
    const resets = {
      findAccount: vi.fn((_tx: unknown, email: string) =>
        Promise.resolve(email.startsWith('nobody') ? null : { ...target, email }),
      ),
      retireOpen: vi.fn(() => Promise.resolve()),
      create: vi.fn(() => Promise.resolve()),
      findLive: vi.fn(() => Promise.resolve(target)),
      spend: vi.fn(() => Promise.resolve(true)),
    };
    const deliver = vi.fn(() => Promise.resolve('sent' as const));
    const reset = new PasswordResetService(
      identityDatabase,
      { deliver } as unknown as PasswordResetMailer,
      resets as unknown as PasswordResetRepository,
      { setPassword: vi.fn(), recordCredentialChange: vi.fn() } as unknown as CredentialsRepository,
      { revokeAllForUser: vi.fn(() => Promise.resolve(1)) } as unknown as SessionsRepository,
      cutoff,
      budget,
    );
    return { reset, resets, deliver };
  }

  it('a completed reset ends the person’s tokens and grants, before and after the session cutoff', async () => {
    const cutoff = new RecordingCutoff();
    const { reset, resets } = resetHarness(cutoff);
    await reset.complete('a'.repeat(43), STRONG, { correlationId: CONTEXT.correlationId });
    expect(resets.spend).toHaveBeenCalledTimes(1);
    expect(cutoff.calls).toEqual([USER, USER]);
  });

  it('a reset whose cutoff fails leaves the link unspent, so the person can retry', async () => {
    const cutoff = new RecordingCutoff();
    cutoff.failWith = new Error('database unavailable');
    const { reset, resets } = resetHarness(cutoff);
    await expect(
      reset.complete('a'.repeat(43), STRONG, { correlationId: CONTEXT.correlationId }),
    ).rejects.toThrow('database unavailable');
    expect(resets.spend).not.toHaveBeenCalled();
  });

  // NV11 rides on the same harness.
  it('NV11: the fourth reset request for one address in an hour sends no mail and answers the same', async () => {
    const { reset, deliver } = resetHarness(new RecordingCutoff());
    const answers: unknown[] = [];
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) {
      const { delivery } = await reset.request('Sara@Example.com', {
        correlationId: CONTEXT.correlationId,
        ip,
      });
      answers.push(typeof delivery);
      await delivery;
    }
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(new Set(answers).size).toBe(1);
  });

  it('NV11: the global bound caps mails across addresses, and unknown addresses do not spend it', async () => {
    const { reset, deliver } = resetHarness(
      new RecordingCutoff(),
      createPasswordResetMailBudget({ maxDeliveries: 2 }),
    );
    for (const email of [
      'nobody1@example.com',
      'a@example.com',
      'nobody2@example.com',
      'b@example.com',
      'c@example.com',
    ]) {
      const { delivery } = await reset.request(email, { correlationId: CONTEXT.correlationId });
      await delivery;
    }
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F20 — a full window refuses a correct guess too
// ─────────────────────────────────────────────────────────────────────────────

describe('F20: the durable lockout bounds right guesses as well as wrong ones', () => {
  const RIGHT = 'correct-horse-battery-41';

  it('five failures in the window: the correct password is refused with rate_limited', async () => {
    const { auth, credentials } = service();
    credentials.password = {
      userId: USER,
      passwordHash: await hashPassword(RIGHT),
      setAt: new Date(),
      updatedAt: new Date(),
    };
    credentials.failures = [5];
    await expect(
      auth.signInWithPassword({ email: 'sara@example.com', password: RIGHT, context: CONTEXT }),
    ).rejects.toMatchObject({ rejection: 'rate_limited', reason: 'locked_out' });
  });

  it('under the bound the correct password still signs in', async () => {
    const { auth, credentials } = service();
    credentials.password = {
      userId: USER,
      passwordHash: await hashPassword(RIGHT),
      setAt: new Date(),
      updatedAt: new Date(),
    };
    credentials.failures = [4];
    await expect(
      auth.signInWithPassword({ email: 'sara@example.com', password: RIGHT, context: CONTEXT }),
    ).resolves.toEqual({ status: 'authenticated', userId: USER });
  });

  const challenge = () =>
    signChallengeToken({ userId: USER, expiresAt: new Date(NOW + 60_000) }, SESSION_SECRET);

  it('five failures in the window: the correct TOTP code is refused before it is spent', async () => {
    const { auth, credentials } = service();
    credentials.factors = [FACTOR];
    credentials.failures = [5];
    await expect(
      auth.completeMfaChallenge({
        challengeToken: challenge(),
        code: codeAt(NOW),
        context: CONTEXT,
      }),
    ).rejects.toMatchObject({ rejection: 'rate_limited', reason: 'locked_out' });
    // The window is read first and the code is never evaluated or spent.
    expect(credentials.calls).toEqual(['countRecentFailures']);
  });

  it('under the bound the correct TOTP code completes the sign-in', async () => {
    const { auth, credentials } = service();
    credentials.factors = [FACTOR];
    credentials.failures = [4];
    await expect(
      auth.completeMfaChallenge({
        challengeToken: challenge(),
        code: codeAt(NOW),
        context: CONTEXT,
      }),
    ).resolves.toEqual({ status: 'authenticated', userId: USER });
  });

  it('the MFA step is keyed on the account the challenge names', async () => {
    const abuse = admitAll();
    const { auth, credentials } = service(abuse);
    credentials.factors = [FACTOR];
    await auth.completeMfaChallenge({
      challengeToken: challenge(),
      code: codeAt(NOW),
      context: CONTEXT,
    });
    expect(abuse.admit).toHaveBeenCalledWith({ ip: CONTEXT.ip, account: USER });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F32 — the reauth code step has the durable lockout
// ─────────────────────────────────────────────────────────────────────────────

describe('F32: re-authentication’s code step is locked out like sign-in', () => {
  const RIGHT = 'correct-horse-battery-41';

  async function withFactor(failures: number[]) {
    const built = service();
    built.credentials.password = {
      userId: USER,
      passwordHash: await hashPassword(RIGHT),
      setAt: new Date(),
      updatedAt: new Date(),
    };
    built.credentials.factors = [FACTOR];
    built.credentials.failures = failures;
    return built;
  }

  it('with five failures counted at the code step, a wrong code is rate_limited, not invalid', async () => {
    const { auth } = await withFactor([4, 5]);
    await expect(
      auth.confirmReauthentication({
        userId: USER,
        sessionId: SESSION,
        password: RIGHT,
        code: WRONG_CODE,
        context: CONTEXT,
      }),
    ).rejects.toMatchObject({ rejection: 'rate_limited', reason: 'locked_out' });
  });

  it('while the window is full the correct code is refused too, and never spent', async () => {
    const { auth, credentials } = await withFactor([4, 5]);
    await expect(
      auth.confirmReauthentication({
        userId: USER,
        sessionId: SESSION,
        password: RIGHT,
        code: codeAt(NOW),
        context: CONTEXT,
      }),
    ).rejects.toBeInstanceOf(AuthenticationRejectedError);
    expect(credentials.calls).not.toContain('recordFactorUse');
  });

  it('under the bound the correct code still mints a reauth token', async () => {
    const { auth } = await withFactor([4, 4]);
    const minted = await auth.confirmReauthentication({
      userId: USER,
      sessionId: SESSION,
      password: RIGHT,
      code: codeAt(NOW),
      context: CONTEXT,
    });
    expect(typeof minted.reauthToken).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F43 — login CSRF
// ─────────────────────────────────────────────────────────────────────────────

describe('F43: a session-establishing public POST must be same-origin', () => {
  const signIn = AuthenticationController.prototype.signInWithPassword;
  const at = (headers: Record<string, string>) =>
    contextOf(requestWith(undefined, headers), AuthenticationController, signIn);

  it('refuses JSON sign-in with a foreign Origin (403)', () => {
    expect(() => guard.canActivate(at({ origin: 'https://evil.example' }))).toThrow(ApiError);
    expect(() => guard.canActivate(at({ origin: 'https://evil.example' }))).toThrow(
      expect.objectContaining({ status: 403, auditCode: 'cross_site_sign_in' }),
    );
  });

  it('refuses an opaque Origin and a cross-site fetch with no Origin', () => {
    expect(() => guard.canActivate(at({ origin: 'null' }))).toThrow(ApiError);
    expect(() => guard.canActivate(at({ 'sec-fetch-site': 'cross-site' }))).toThrow(ApiError);
  });

  it('refuses a sibling subdomain (same-site, foreign origin)', () => {
    expect(() =>
      guard.canActivate(at({ origin: 'https://evil.example.test', 'sec-fetch-site': 'same-site' })),
    ).toThrow(ApiError);
  });

  it('admits the app’s own origin, a same-origin fetch, and a non-browser client', () => {
    expect(guard.canActivate(at({ origin: WEB, 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(guard.canActivate(at({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(guard.canActivate(at({}))).toBe(true);
  });

  it('applies to public sign-up as well', () => {
    const request = requestWith(undefined, { origin: 'https://evil.example' });
    expect(() =>
      guard.canActivate(
        contextOf(request, PublicSignupController, PublicSignupController.prototype.signUp),
      ),
    ).toThrow(ApiError);
  });

  it('leaves the OAuth token endpoint open to any origin (machine clients)', () => {
    const request = requestWith(undefined, { origin: 'https://claude.ai' });
    expect(
      guard.canActivate(
        contextOf(request, OAuthTokenController, OAuthTokenController.prototype.token),
      ),
    ).toBe(true);
  });
});
