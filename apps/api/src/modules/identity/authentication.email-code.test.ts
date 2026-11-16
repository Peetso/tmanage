import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import {
  AuthenticationRejectedError,
  AuthenticationService,
  EmailFactorUnavailableError,
  ReauthenticationRequiredError,
} from './authentication.service.js';
import { CredentialsRepository } from './credentials.repository.js';
import { createSeedCipher } from './seed-cipher.js';
import { createSignInAbuseControl } from './sign-in-abuse-control.js';
import { REAUTH_TTL_SECONDS, signReauthToken } from './reauth-token.js';
import { signChallengeToken } from './challenge-token.js';
import { createEmailCodeSendBudget, EMAIL_CODE_MAX_ATTEMPTS } from './email-code.js';
import type { EmailCodePurpose } from './email-code.js';
import type { MfaCodeEmailFacts } from '../../common/email/mfa-code-email.js';
import type { UserMfaEmailCodeRow, UserMfaFactorRow } from '../../common/database/schema.js';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SessionsRepository } from './sessions.repository.js';

/**
 * MFAOPTIONS. The e-mail code method through `AuthenticationService`: the sign-in step, the
 * five-attempt death, the server deciding the methods, enrolment only for a verified address
 * behind fresh proof, the default method, and backup codes kept when they exist.
 *
 * Fakes rather than a database, as `authentication.enrolment-reauth.test.ts` does: what is under
 * test is which calls the service makes and what it answers. The code store is an in-memory
 * stand-in honouring the repository's contract (one open code per binding, single use, the
 * attempt cap); `email-codes.repository.test.ts` pins the SQL that keeps that contract.
 */

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_email_code_service_test';
const USER = '0198f0aa-0000-7000-8000-000000000001';
const SESSION = '0198f0aa-0000-7000-8000-0000000000a1';
const TOTP = '0198f0aa-0000-7000-8000-0000000000f1';
const EMAIL = '0198f0aa-0000-7000-8000-0000000000f2';
const NOW = 1_757_000_000_000;
const CONTEXT = {
  correlationId: '0198f0aa-0000-7000-8000-0000000000c1',
  ip: '198.51.100.4',
  userAgent: null,
};
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x11).toString('base64url')}`));

function factor(id: string, kind: string, confirmed = true): UserMfaFactorRow {
  return {
    id,
    userId: USER,
    kind,
    label: kind,
    secret: '',
    confirmedAt: confirmed ? new Date(NOW - 1000) : null,
    disabledAt: null,
    lastAcceptedCounter: null,
    isDefault: false,
    createdAt: new Date(NOW - 2000),
  } as unknown as UserMfaFactorRow;
}

/** The repository's contract, in memory: one open code per binding, single use, attempt cap. */
class MemoryCodes {
  rows: (UserMfaEmailCodeRow & { expired?: boolean })[] = [];

  async create(
    _runner: unknown,
    input: {
      userId: string;
      factorId: string;
      purpose: EmailCodePurpose;
      bindingHash: string;
      codeHash: string;
    },
  ): Promise<void> {
    for (const row of this.rows) {
      if (row.bindingHash === input.bindingHash && row.usedAt === null) row.usedAt = new Date(NOW);
    }
    this.rows.push({
      id: `code-${this.rows.length}`,
      ...input,
      attempts: 0,
      usedAt: null,
      createdAt: new Date(NOW),
      expiresAt: new Date(NOW + 600_000),
    } as unknown as UserMfaEmailCodeRow);
  }

  async findOpen(_runner: unknown, bindingHash: string) {
    return (
      this.rows
        .filter((row) => row.bindingHash === bindingHash && row.usedAt === null && !row.expired)
        .at(-1) ?? null
    );
  }

  async recordWrongAttempt(_runner: unknown, row: { id: string; attempts: number }) {
    const stored = this.rows.find((r) => r.id === row.id);
    if (!stored) return 'counted';
    stored.attempts = row.attempts + 1;
    if (stored.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      stored.usedAt = new Date(NOW);
      return 'dead';
    }
    return 'counted';
  }

  async spend(_runner: unknown, id: string) {
    const stored = this.rows.find((r) => r.id === id);
    if (!stored || stored.usedAt !== null || stored.expired) return false;
    stored.usedAt = new Date(NOW);
    return true;
  }

  async isExhausted(_runner: unknown, bindingHash: string) {
    return this.rows.some(
      (row) => row.bindingHash === bindingHash && row.attempts >= EMAIL_CODE_MAX_ATTEMPTS,
    );
  }
}

class FakeCredentials extends CredentialsRepository {
  factors: UserMfaFactorRow[] = [];
  verified = true;
  usableRecoveryCodes = 0;
  readonly events: { action: string; outcome: string; reason: string | null }[] = [];
  readonly changes: string[] = [];
  readonly reached: string[] = [];

  constructor() {
    super(CIPHER);
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

  override async countRecentFailures(): Promise<number> {
    return 0;
  }

  override async listActiveFactors(): Promise<readonly UserMfaFactorRow[]> {
    return this.factors.filter((row) => row.confirmedAt !== null && row.disabledAt === null);
  }

  override async findFactor(_runner: IdentityQueryRunner, id: string) {
    return this.factors.find((row) => row.id === id) ?? null;
  }

  override async findMailContact() {
    return {
      email: 'peter@example.test',
      displayName: 'Peter',
      locale: 'en',
      emailVerifiedAt: this.verified ? new Date(NOW - 10_000) : null,
    };
  }

  override async findPendingEmailFactor() {
    return this.factors.find((row) => row.kind === 'email' && row.confirmedAt === null) ?? null;
  }

  override async createEmailFactor(): Promise<string> {
    this.reached.push('createEmailFactor');
    this.factors.push(factor(EMAIL, 'email', false));
    return EMAIL;
  }

  override async confirmCodelessFactor(_runner: IdentityQueryRunner, id: string) {
    const row = this.factors.find((r) => r.id === id);
    if (!row || row.confirmedAt !== null) return false;
    (row as { confirmedAt: Date | null }).confirmedAt = new Date(NOW);
    return true;
  }

  override async recordCredentialChange(
    _runner: IdentityQueryRunner,
    input: { action: string },
  ): Promise<void> {
    this.changes.push(input.action);
  }

  override async listUsableRecoveryCodes() {
    return Array.from({ length: this.usableRecoveryCodes }, () => ({})) as never;
  }

  override async replaceRecoveryCodes(): Promise<string> {
    this.reached.push('replaceRecoveryCodes');
    return USER;
  }

  override async setDefaultFactor(_runner: IdentityQueryRunner, userId: string, id: string) {
    this.reached.push('setDefaultFactor');
    return this.factors.some((row) => row.id === id && row.userId === userId);
  }
}

const RUNNER = {} as IdentityQueryRunner;

function build(options: { mailer?: boolean } = {}) {
  const credentials = new FakeCredentials();
  const codes = new MemoryCodes();
  const mailed: MfaCodeEmailFacts[] = [];
  const clock = { t: NOW };
  const database = {
    identityRead: <T>(_o: unknown, work: (db: IdentityQueryRunner) => Promise<T>) => work(RUNNER),
    identityTransaction: <T>(_o: unknown, work: (tx: IdentityQueryRunner) => Promise<T>) =>
      work(RUNNER),
  } as unknown as TenantDatabase;
  const sessions = { findStanding: async () => null } as unknown as SessionsRepository;

  const service = new AuthenticationService(
    database,
    {
      sessionSecret: SESSION_SECRET,
      maxFailuresInWindow: 5,
      failureWindowSeconds: 900,
      totpIssuer: 'TManage',
      abuseControl: createSignInAbuseControl({
        windowMs: 300_000,
        maxPerSource: 1_000,
        maxPerSourceAccount: 1_000,
        maxGlobal: 10_000,
        now: () => clock.t,
      }),
      emailCodes: {
        mailer: {
          enabled: options.mailer ?? true,
          deliver: async (facts: MfaCodeEmailFacts) => {
            mailed.push(facts);
            return 'sent' as const;
          },
        },
        budget: createEmailCodeSendBudget(() => clock.t),
      },
    },
    credentials,
    () => clock.t,
    sessions,
    undefined,
    codes,
  );
  return { service, credentials, codes, mailed, clock };
}

const challenge = (): string =>
  signChallengeToken({ userId: USER, expiresAt: new Date(NOW + 600_000) }, SESSION_SECRET);

const proof = (): string =>
  signReauthToken(
    { userId: USER, sessionId: SESSION, expiresAt: new Date(NOW + REAUTH_TTL_SECONDS * 1000) },
    SESSION_SECRET,
  );

const reasonOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof AuthenticationRejectedError) return `${error.rejection}:${error.reason}`;
    throw error;
  }
  return 'accepted';
};

describe('signing in with an e-mail code', () => {
  it('mails a code bound to the challenge, which finishes the sign-in once', async () => {
    const { service, credentials, mailed } = build();
    credentials.factors = [factor(EMAIL, 'email')];
    const token = challenge();

    const sent = await service.sendSignInEmailCode({ challengeToken: token, context: CONTEXT });
    expect(sent).toEqual({
      sentTo: 'p•••@example.test',
      resendAfterSeconds: 30,
      expiresInSeconds: 600,
    });
    expect(mailed).toHaveLength(1);
    const code = mailed[0]!.code;
    expect(code).toMatch(/^\d{6}$/u);
    expect(mailed[0]!.purpose).toBe('sign_in');

    const done = await service.completeMfaChallenge({
      challengeToken: token,
      code,
      method: 'email',
      context: CONTEXT,
    });
    expect(done).toEqual({ status: 'authenticated', userId: USER });

    // Single use: the same code a second time is refused.
    expect(
      await reasonOf(
        service.completeMfaChallenge({
          challengeToken: token,
          code,
          method: 'email',
          context: CONTEXT,
        }),
      ),
    ).toBe('invalid_credentials:mfa_bad_code');
  });

  it('does not accept a code mailed for another challenge', async () => {
    const { service, credentials, mailed, clock } = build();
    credentials.factors = [factor(EMAIL, 'email')];
    await service.sendSignInEmailCode({ challengeToken: challenge(), context: CONTEXT });
    clock.t += 1; // A second sign-in, a different token.
    const other = signChallengeToken(
      { userId: USER, expiresAt: new Date(NOW + 599_000) },
      SESSION_SECRET,
    );
    expect(
      await reasonOf(
        service.completeMfaChallenge({
          challengeToken: other,
          code: mailed[0]!.code,
          method: 'email',
          context: CONTEXT,
        }),
      ),
    ).toBe('invalid_credentials:mfa_bad_code');
  });

  it('refuses an expired code', async () => {
    const { service, credentials, codes, mailed } = build();
    credentials.factors = [factor(EMAIL, 'email')];
    const token = challenge();
    await service.sendSignInEmailCode({ challengeToken: token, context: CONTEXT });
    codes.rows[0]!.expired = true;
    expect(
      await reasonOf(
        service.completeMfaChallenge({
          challengeToken: token,
          code: mailed[0]!.code,
          method: 'email',
          context: CONTEXT,
        }),
      ),
    ).toBe('invalid_credentials:mfa_bad_code');
  });

  it('kills the challenge after five wrong codes, for every method and for a resend', async () => {
    const { service, credentials, mailed } = build();
    credentials.factors = [factor(EMAIL, 'email')];
    const token = challenge();
    await service.sendSignInEmailCode({ challengeToken: token, context: CONTEXT });
    const right = mailed[0]!.code;
    const wrong = right === '000000' ? '111111' : '000000';

    const answers: string[] = [];
    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i += 1) {
      answers.push(
        await reasonOf(
          service.completeMfaChallenge({
            challengeToken: token,
            code: wrong,
            method: 'email',
            context: CONTEXT,
          }),
        ),
      );
    }
    expect(answers.slice(0, 4)).toEqual(Array(4).fill('invalid_credentials:mfa_bad_code'));
    expect(answers[4]).toBe('rate_limited:mfa_challenge_dead');

    expect(
      await reasonOf(
        service.completeMfaChallenge({
          challengeToken: token,
          code: right,
          method: 'email',
          context: CONTEXT,
        }),
      ),
    ).toBe('rate_limited:mfa_challenge_dead');
    expect(
      await reasonOf(
        service.completeMfaChallenge({
          challengeToken: token,
          code: right,
          method: 'totp',
          context: CONTEXT,
        }),
      ),
    ).toBe('rate_limited:mfa_challenge_dead');
    expect(
      await reasonOf(service.sendSignInEmailCode({ challengeToken: token, context: CONTEXT })),
    ).toBe('invalid_credentials:mfa_challenge_dead');
  });

  it('lets the server decide the methods: e-mail without an e-mail method is refused', async () => {
    const { service, credentials, mailed } = build();
    credentials.factors = [factor(TOTP, 'totp')];
    const token = challenge();

    expect(
      await reasonOf(service.sendSignInEmailCode({ challengeToken: token, context: CONTEXT })),
    ).toBe('invalid_credentials:mfa_no_factor');
    expect(mailed).toHaveLength(0);
    expect(
      await reasonOf(
        service.completeMfaChallenge({
          challengeToken: token,
          code: '123456',
          method: 'email',
          context: CONTEXT,
        }),
      ),
    ).toBe('invalid_credentials:mfa_no_factor');
  });

  it('does not let an e-mail code pass as an authenticator code', async () => {
    const { service, credentials, mailed } = build();
    credentials.factors = [factor(EMAIL, 'email')];
    const token = challenge();
    await service.sendSignInEmailCode({ challengeToken: token, context: CONTEXT });
    expect(
      await reasonOf(
        service.completeMfaChallenge({
          challengeToken: token,
          code: mailed[0]!.code,
          context: CONTEXT,
        }),
      ),
    ).toBe('invalid_credentials:mfa_no_factor');
  });

  it('holds 30 seconds between sends, through the send budget', async () => {
    const { service, credentials, clock } = build();
    credentials.factors = [factor(EMAIL, 'email')];
    const token = challenge();
    await service.sendSignInEmailCode({ challengeToken: token, context: CONTEXT });
    clock.t += 10_000;
    expect(
      await reasonOf(service.sendSignInEmailCode({ challengeToken: token, context: CONTEXT })),
    ).toBe('rate_limited:mfa_email_too_soon');
  });

  it('refuses to send for a forged or missing challenge', async () => {
    const { service, mailed } = build();
    expect(
      await reasonOf(service.sendSignInEmailCode({ challengeToken: 'forged', context: CONTEXT })),
    ).toBe('invalid_credentials:challenge_invalid');
    expect(
      await reasonOf(service.sendSignInEmailCode({ challengeToken: undefined, context: CONTEXT })),
    ).toBe('invalid_credentials:challenge_invalid');
    expect(mailed).toHaveLength(0);
  });
});

describe('turning the e-mail method on', () => {
  const begin = (service: AuthenticationService, reauthToken: string | undefined) =>
    service.beginEmailFactor({ userId: USER, sessionId: SESSION, reauthToken, context: CONTEXT });

  it('needs fresh proof before anything is read or written', async () => {
    const { service, credentials, mailed } = build();
    await expect(begin(service, undefined)).rejects.toBeInstanceOf(ReauthenticationRequiredError);
    await expect(
      service.confirmEmailFactor({
        userId: USER,
        sessionId: SESSION,
        factorId: EMAIL,
        code: '123456',
        reauthToken: undefined,
        context: CONTEXT,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
    expect(credentials.reached).toEqual([]);
    expect(mailed).toHaveLength(0);
  });

  it('is refused for an address that was never verified', async () => {
    const { service, credentials, mailed } = build();
    credentials.verified = false;
    await expect(begin(service, proof())).rejects.toEqual(
      new EmailFactorUnavailableError('email_not_verified'),
    );
    expect(credentials.reached).toEqual([]);
    expect(mailed).toHaveLength(0);
  });

  it('is refused when no mail transport exists', async () => {
    const { service, credentials } = build({ mailer: false });
    await expect(begin(service, proof())).rejects.toEqual(
      new EmailFactorUnavailableError('mail_unavailable'),
    );
    expect(credentials.reached).toEqual([]);
  });

  it('authorises nothing until the mailed code is proved, then records the change', async () => {
    const { service, credentials, mailed } = build();
    credentials.usableRecoveryCodes = 6;
    const started = await begin(service, proof());
    expect(started.factorId).toBe(EMAIL);
    expect(mailed[0]!.purpose).toBe('enrol');
    expect(await credentials.listActiveFactors()).toHaveLength(0);

    const wrong = mailed[0]!.code === '000000' ? '111111' : '000000';
    await expect(
      service.confirmEmailFactor({
        userId: USER,
        sessionId: SESSION,
        factorId: EMAIL,
        code: wrong,
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).rejects.toBeInstanceOf(AuthenticationRejectedError);
    expect(await credentials.listActiveFactors()).toHaveLength(0);

    const confirmed = await service.confirmEmailFactor({
      userId: USER,
      sessionId: SESSION,
      factorId: EMAIL,
      code: mailed[0]!.code,
      reauthToken: proof(),
      context: CONTEXT,
    });
    expect(await credentials.listActiveFactors()).toHaveLength(1);
    expect(credentials.changes).toEqual(['mfa_factor_enrolled']);
    // An existing set of backup codes is kept.
    expect(confirmed.recoveryCodes).toEqual([]);
    expect(credentials.reached).not.toContain('replaceRecoveryCodes');
  });

  it('issues ten backup codes when the person has none', async () => {
    const { service, credentials, mailed } = build();
    await begin(service, proof());
    const confirmed = await service.confirmEmailFactor({
      userId: USER,
      sessionId: SESSION,
      factorId: EMAIL,
      code: mailed[0]!.code,
      reauthToken: proof(),
      context: CONTEXT,
    });
    expect(confirmed.recoveryCodes).toHaveLength(10);
    expect(new Set(confirmed.recoveryCodes).size).toBe(10);
    expect(credentials.changes).toEqual(['mfa_factor_enrolled', 'recovery_codes_issued']);
  });

  it('refuses a second e-mail method', async () => {
    const { service, credentials } = build();
    credentials.factors = [factor(EMAIL, 'email')];
    await expect(begin(service, proof())).rejects.toEqual(
      new EmailFactorUnavailableError('already_enabled'),
    );
  });

  it("refuses to confirm someone else's factor id", async () => {
    const { service, credentials, mailed } = build();
    await begin(service, proof());
    (credentials.factors[0] as { userId: string }).userId = '0198f0aa-0000-7000-8000-00000000ffff';
    await expect(
      service.confirmEmailFactor({
        userId: USER,
        sessionId: SESSION,
        factorId: EMAIL,
        code: mailed[0]!.code,
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).rejects.toBeInstanceOf(AuthenticationRejectedError);
    expect(credentials.changes).toEqual([]);
  });
});

describe('choosing the default method', () => {
  it('needs fresh proof, and records an audited change with its notice', async () => {
    const { service, credentials } = build();
    credentials.factors = [factor(TOTP, 'totp'), factor(EMAIL, 'email')];

    await expect(
      service.setDefaultFactor({
        userId: USER,
        sessionId: SESSION,
        factorId: EMAIL,
        reauthToken: undefined,
        context: CONTEXT,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
    expect(credentials.reached).toEqual([]);
    expect(credentials.events.at(-1)).toEqual({
      action: 'mfa_default_changed',
      outcome: 'failed',
      reason: 'reauth_required',
    });

    expect(
      await service.setDefaultFactor({
        userId: USER,
        sessionId: SESSION,
        factorId: EMAIL,
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).toBe(true);
    expect(credentials.changes).toEqual(['mfa_default_changed']);
  });

  it('writes nothing for an id that is not one of the person’s methods', async () => {
    const { service, credentials } = build();
    credentials.factors = [factor(TOTP, 'totp')];
    expect(
      await service.setDefaultFactor({
        userId: USER,
        sessionId: SESSION,
        factorId: EMAIL,
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).toBe(false);
    expect(credentials.changes).toEqual([]);
  });
});
