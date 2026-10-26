import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { parseSeedKeys } from '@tmanage/config';
import type { RowDataPacket } from 'mysql2/promise';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import {
  AuthenticationRejectedError,
  AuthenticationService,
} from '../src/modules/identity/authentication.service.js';
import type { AuthenticationOptions } from '../src/modules/identity/authentication.service.js';
import { signChallengeToken } from '../src/modules/identity/challenge-token.js';
import { CredentialsRepository } from '../src/modules/identity/credentials.repository.js';
import { issueInvitationToken } from '../src/modules/identity/invitation-token.js';
import { hashPassword } from '../src/modules/identity/password.js';
import { PasswordResetRepository } from '../src/modules/identity/password-reset.repository.js';
import { PasswordResetService } from '../src/modules/identity/password-reset.service.js';
import { createSeedCipher } from '../src/modules/identity/seed-cipher.js';
import { createSignInAbuseControl } from '../src/modules/identity/sign-in-abuse-control.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * Wave 10, lane R1 — security audit run 2, against a real MariaDB 11.8 server.
 *
 * - **N01.** A full lockout window refuses right and wrong guesses alike (F20), and `locked_out`
 *   refusals are not counted, so one wrong guess every few minutes kept a known account shut;
 *   a completed reset did not clear it. Now the count starts at the latest succeeded
 *   `password_set`, so the reset is a real way out — for sign-in, the MFA challenge, the
 *   recovery-code challenge and re-authentication alike, which all read the same count.
 * - **F03 / NV04 (verification half).** Spending a mailed reset link proves the mailbox, so it
 *   marks `users.email_verified_at`; the same reset ends every session.
 *
 * Lives in `test/` rather than beside the source because only `test/**\/*.db.test.ts` runs in the
 * `database` project (`vitest.config.ts`); a `.db.test.ts` under `src/` would run as a unit test.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let service: AuthenticationService;
let resets: PasswordResetService;

const SECRET = 'local_dev_only_session_secret_for_the_wave10_r1_suite_xx';
const seedCipher = createSeedCipher(
  parseSeedKeys(`1:${Buffer.alloc(32, 0x21).toString('base64url')}`),
);
const repository = new CredentialsRepository(seedCipher);

const OPTIONS: AuthenticationOptions = {
  sessionSecret: SECRET,
  maxFailuresInWindow: 5,
  failureWindowSeconds: 900,
  totpIssuer: 'TManage',
  // The in-process source budgets are not under test; the durable window is.
  abuseControl: createSignInAbuseControl({
    windowMs: 300_000,
    maxPerSource: 10_000,
    maxPerSourceAccount: 10_000,
    maxGlobal: 100_000,
  }),
};

const OLD_PASSWORD = 'a quiet line on paper';
const NEW_PASSWORD = 'violet-harbour-lantern-41';
const IDENTITY_TABLES = ['users', 'user_passwords', 'authentication_events'];

const context = () => ({ correlationId: uuidv7(), ip: '203.0.113.9', userAgent: 'vitest' });
const owner = () => world.northstar.owner;

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function liveSession(userId: string): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into sessions (id, user_id, refresh_token_hash, user_agent, expires_at, created_at)
     values (?, ?, ?, 'vitest', date_add(now(3), interval 1 day), now(3))`,
    [id, userId, randomBytes(32).toString('hex')],
  );
  return id;
}

async function rejection(promise: Promise<unknown>): Promise<AuthenticationRejectedError> {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(AuthenticationRejectedError);
  return thrown as AuthenticationRejectedError;
}

async function wrongPasswords(count: number): Promise<void> {
  for (let attempt = 0; attempt < count; attempt += 1) {
    await rejection(
      service.signInWithPassword({ email: owner().email, password: 'wrong', context: context() }),
    );
  }
}

/** Issue a reset link (as `request` would) and spend it with a new password. */
async function completeReset(): Promise<void> {
  const issued = issueInvitationToken();
  await tenant.identityTransaction(
    { correlationId: uuidv7(), tables: ['users', 'password_reset_tokens'] },
    (tx) =>
      new PasswordResetRepository().create(tx, {
        userId: owner().id,
        tokenHash: issued.tokenHash,
        ttlMinutes: 30,
      }),
  );
  await resets.complete(issued.token, NEW_PASSWORD, { correlationId: uuidv7() });
}

async function failuresNow(): Promise<number> {
  return tenant.identityRead({ correlationId: uuidv7(), tables: IDENTITY_TABLES }, (db) =>
    repository.countRecentFailures(db, owner().id, OPTIONS.failureWindowSeconds),
  );
}

function challenge(): string {
  return signChallengeToken(
    { userId: owner().id, expiresAt: new Date(Date.now() + 60_000) },
    SECRET,
  );
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  service = new AuthenticationService(tenant, OPTIONS, repository);
  resets = new PasswordResetService(tenant, null);
}, 300_000);

beforeEach(async () => {
  // TRUNCATE, not DELETE: `authentication_events` is append-only by trigger.
  await db.admin.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of [
      'user_recovery_codes',
      'user_mfa_factors',
      'user_passwords',
      'authentication_events',
      'credential_change_notices',
      'password_reset_tokens',
      'session_refresh_tokens',
      'sessions',
    ]) {
      await db.admin.query(`TRUNCATE TABLE \`${table}\``);
    }
  } finally {
    await db.admin.query('SET FOREIGN_KEY_CHECKS = 1');
  }
  const hash = await hashPassword(OLD_PASSWORD);
  await tenant.identityTransaction({ correlationId: uuidv7(), tables: IDENTITY_TABLES }, (tx) =>
    repository.setPassword(tx, owner().id, hash),
  );
});

afterAll(async () => {
  await db?.stop();
});

describe('N01 — a completed password reset clears the lockout', () => {
  it('locked out after five wrong passwords; the reset password then signs in', async () => {
    await wrongPasswords(OPTIONS.maxFailuresInWindow);

    // F20 still holds: inside the full window the correct password is refused too.
    const locked = await rejection(
      service.signInWithPassword({
        email: owner().email,
        password: OLD_PASSWORD,
        context: context(),
      }),
    );
    expect(locked.reason).toBe('locked_out');

    await completeReset();

    // The exploit: before N01 this was `locked_out` for the rest of the 900 s window.
    const admitted = await service.signInWithPassword({
      email: owner().email,
      password: NEW_PASSWORD,
      context: context(),
    });
    expect(admitted).toEqual({ status: 'authenticated', userId: owner().id });
  });

  it('a wrong guess after the reset counts from zero, and five of them lock again', async () => {
    await wrongPasswords(OPTIONS.maxFailuresInWindow);
    expect(await failuresNow()).toBe(OPTIONS.maxFailuresInWindow);
    await completeReset();
    expect(await failuresNow()).toBe(0);

    const first = await rejection(
      service.signInWithPassword({ email: owner().email, password: 'wrong', context: context() }),
    );
    expect(first.reason).toBe('bad_password');
    expect(await failuresNow()).toBe(1);

    // The lockout itself is untouched: a guesser after the reset is throttled as before.
    await wrongPasswords(OPTIONS.maxFailuresInWindow - 1);
    const relocked = await rejection(
      service.signInWithPassword({
        email: owner().email,
        password: NEW_PASSWORD,
        context: context(),
      }),
    );
    expect(relocked.reason).toBe('locked_out');
  });

  it('without a reset the full window still refuses (no F20 bypass)', async () => {
    await wrongPasswords(OPTIONS.maxFailuresInWindow);
    // A failed or merely requested reset writes no `password_set` row and changes nothing.
    expect(await failuresNow()).toBe(OPTIONS.maxFailuresInWindow);
    const refused = await rejection(
      service.completeWithRecoveryCode({
        challengeToken: challenge(),
        code: 'AAAA-BBBB',
        context: context(),
      }),
    );
    expect(refused.reason).toBe('locked_out');
  });

  it('the MFA challenge reads the same count: locked before the reset, open after', async () => {
    await wrongPasswords(OPTIONS.maxFailuresInWindow);
    const before = await rejection(
      service.completeMfaChallenge({
        challengeToken: challenge(),
        code: '000000',
        context: context(),
      }),
    );
    expect(before.reason).toBe('locked_out');
    await completeReset();
    const after = await rejection(
      service.completeMfaChallenge({
        challengeToken: challenge(),
        code: '000000',
        context: context(),
      }),
    );
    // Past the window check: the account has no factor, so the code is never reached.
    expect(after.reason).toBe('mfa_no_factor');
  });

  it('the recovery-code challenge reads the same count: locked before the reset, open after', async () => {
    await wrongPasswords(OPTIONS.maxFailuresInWindow);
    const before = await rejection(
      service.completeWithRecoveryCode({
        challengeToken: challenge(),
        code: 'AAAA-BBBB',
        context: context(),
      }),
    );
    expect(before.reason).toBe('locked_out');
    await completeReset();
    const after = await rejection(
      service.completeWithRecoveryCode({
        challengeToken: challenge(),
        code: 'AAAA-BBBB',
        context: context(),
      }),
    );
    expect(after.reason).toBe('recovery_code_invalid');
  });

  it('re-authentication reads the same count: locked before the reset, admitted after', async () => {
    await wrongPasswords(OPTIONS.maxFailuresInWindow);
    const before = await rejection(
      service.confirmReauthentication({
        userId: owner().id,
        sessionId: await liveSession(owner().id),
        password: OLD_PASSWORD,
        context: context(),
      }),
    );
    expect(before.reason).toBe('locked_out');
    await completeReset();
    const minted = await service.confirmReauthentication({
      userId: owner().id,
      sessionId: await liveSession(owner().id),
      password: NEW_PASSWORD,
      context: context(),
    });
    expect(minted.reauthToken.length).toBeGreaterThan(0);
  });
});

describe('F03 / NV04 — a completed reset proves the mailbox', () => {
  it('an unverified account is verified by the reset, and its sessions end', async () => {
    await db.admin.execute('update users set email_verified_at = null where id = ?', [owner().id]);
    const squatterSession = await liveSession(owner().id);

    await completeReset();

    const [user] = await observe('select email_verified_at from users where id = ?', [owner().id]);
    expect(user!['email_verified_at']).not.toBeNull();
    const [session] = await observe('select revoked_at from sessions where id = ?', [
      squatterSession,
    ]);
    expect(session!['revoked_at']).not.toBeNull();
  });

  it('an earlier verification time is kept, and an unspent link verifies nothing', async () => {
    await db.admin.execute(
      "update users set email_verified_at = '2026-01-02 03:04:05.000' where id = ?",
      [owner().id],
    );
    await completeReset();
    const [kept] = await observe(
      "select date_format(email_verified_at, '%Y-%m-%d %H:%i:%s') as at from users where id = ?",
      [owner().id],
    );
    expect(kept!['at']).toBe('2026-01-02 03:04:05');

    await db.admin.execute('update users set email_verified_at = null where id = ?', [owner().id]);
    const refused = await resets
      .complete(issueInvitationToken().token, NEW_PASSWORD, { correlationId: uuidv7() })
      .then(
        () => 'completed',
        () => 'refused',
      );
    expect(refused).toBe('refused');
    const [user] = await observe('select email_verified_at from users where id = ?', [owner().id]);
    expect(user!['email_verified_at']).toBeNull();
  });
});
