import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import { AuthenticationRejectedError, AuthenticationService } from './authentication.service.js';
import { CredentialsRepository } from './credentials.repository.js';
import { hashPassword } from './password.js';
import { createSeedCipher } from './seed-cipher.js';
import { createSignInAbuseControl } from './sign-in-abuse-control.js';
import type { AccountStanding, SessionsRepository } from './sessions.repository.js';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Platform admin v2 · PA-06 (0247). A platform admin disabled the account: the RIGHT password is
 * refused with the same neutral `invalid_credentials` a wrong one gets, and the
 * `authentication_events` row is the only place that says `account_disabled`. Without the
 * column set, the same password signs in.
 */

const USER = '0198f0aa-0000-7000-8000-0000000000d1';
const NOW = 1_757_000_000_000;
const PASSWORD = 'correct horse battery staple 42';
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x22).toString('base64url')}`));
const CONTEXT = {
  correlationId: '0198f0aa-0000-7000-8000-0000000000c9',
  ip: null,
  userAgent: null,
};

interface Event {
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
}

class FakeCredentials extends CredentialsRepository {
  readonly events: Event[] = [];
  constructor(private readonly hash: string) {
    super(CIPHER);
  }
  override async findUserIdByEmail() {
    return { id: USER, displayName: 'Maya' };
  }
  override async findPassword() {
    return { userId: USER, passwordHash: this.hash } as never;
  }
  override async countRecentFailures() {
    return 0;
  }
  override async listActiveFactors() {
    return [];
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

const RUNNER = {} as IdentityQueryRunner;
const DATABASE = {
  identityRead: <T>(_o: unknown, work: (db: IdentityQueryRunner) => Promise<T>) => work(RUNNER),
  identityTransaction: <T>(_o: unknown, work: (tx: IdentityQueryRunner) => Promise<T>) =>
    work(RUNNER),
} as unknown as TenantDatabase;

async function build(standing: AccountStanding) {
  const credentials = new FakeCredentials(await hashPassword(PASSWORD));
  const sessions = { findStanding: async () => standing } as unknown as SessionsRepository;
  const service = new AuthenticationService(
    DATABASE,
    {
      sessionSecret: 'local_dev_only_session_secret_for_the_disabled_account_test',
      maxFailuresInWindow: 5,
      failureWindowSeconds: 900,
      totpIssuer: 'TManage',
      abuseControl: createSignInAbuseControl({
        windowMs: 300_000,
        maxPerSource: 1_000,
        maxPerSourceAccount: 1_000,
        maxGlobal: 10_000,
        now: () => NOW,
      }),
    },
    credentials,
    () => NOW,
    sessions,
  );
  return { service, credentials };
}

describe('sign-in of a disabled account (PA-06)', () => {
  it('refuses the right password neutrally and records account_disabled', async () => {
    const { service, credentials } = await build({
      disabledAt: new Date(NOW - 60_000),
      twoStepRequiredAt: null,
    });
    const attempt = service.signInWithPassword({
      email: 'maya@northstar.studio',
      password: PASSWORD,
      context: CONTEXT,
    });
    await expect(attempt).rejects.toBeInstanceOf(AuthenticationRejectedError);
    await expect(attempt).rejects.toMatchObject({
      rejection: 'invalid_credentials',
      reason: 'account_disabled',
    });
    expect(credentials.events).toEqual([
      { action: 'password_sign_in', outcome: 'failed', reason: 'account_disabled' },
    ]);
  });

  it('signs in the same password once the account is enabled', async () => {
    const { service } = await build({ disabledAt: null, twoStepRequiredAt: null });
    await expect(
      service.signInWithPassword({
        email: 'maya@northstar.studio',
        password: PASSWORD,
        context: CONTEXT,
      }),
    ).resolves.toEqual({ status: 'authenticated', userId: USER });
  });

  it('two_step_required_at alone does not refuse the sign-in (enrolment needs a session)', async () => {
    const { service } = await build({ disabledAt: null, twoStepRequiredAt: new Date(NOW) });
    await expect(
      service.signInWithPassword({
        email: 'maya@northstar.studio',
        password: PASSWORD,
        context: CONTEXT,
      }),
    ).resolves.toMatchObject({ status: 'authenticated' });
  });
});
