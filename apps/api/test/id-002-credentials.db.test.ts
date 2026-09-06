import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { parseSeedKeys } from '@tmanage/config';
import type { RowDataPacket } from 'mysql2/promise';
import { IdentityScopeViolation, TenantDatabase } from '../src/common/database/tenant-context.js';
import {
  AuthenticationRejectedError,
  AuthenticationService,
  PasswordRejectedError,
  ReauthenticationRequiredError,
} from '../src/modules/identity/authentication.service.js';
import type { AuthenticationOptions } from '../src/modules/identity/authentication.service.js';
import { CredentialsRepository } from '../src/modules/identity/credentials.repository.js';
import { createSeedCipher, SeedCipherError } from '../src/modules/identity/seed-cipher.js';
import { encryptSeeds } from '../src/modules/identity/seed-backfill.repository.js';
import { SessionsRepository } from '../src/modules/identity/sessions.repository.js';
import { signChallengeToken } from '../src/modules/identity/challenge-token.js';
import { signReauthToken } from '../src/modules/identity/reauth-token.js';
import { hashPassword } from '../src/modules/identity/password.js';
import { hotpCode, base32Decode, totpCounterAt } from '../src/modules/identity/totp.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * ID-002 against a real server — passwords, second factors, recovery codes, and the
 * pre-tenant security log.
 *
 * The suite is written around the four claims that would matter in an incident:
 *
 * 1. **A refusal never says why.** Unknown email, no password set, and wrong password are
 *    three rows in `authentication_events` and one answer to the caller. This is the same
 *    discipline `MembershipResolver` and `SessionService` already hold to, and sign-in is
 *    where it matters most: the identifier is an email address.
 * 2. **A TOTP code is single-use inside its own window.** The counter column is the whole
 *    mechanism, and a code that is accepted twice is a code an observer can replay.
 * 3. **A recovery code is single-use, full stop**, and two concurrent attempts to spend the
 *    same one produce exactly one success.
 * 4. **The log is append-only and is not `audit_events`.** It records attempts that name no
 *    user at all, which is precisely why it cannot live in a table whose `organization_id` is
 *    NOT NULL.
 * 5. **A TOTP seed is not readable from the table** — D07. The column holds an `mfa1.`
 *    envelope; an altered one, or one moved to another person's row, refuses a sign-in
 *    rather than granting it; and a row left in plaintext refuses too, naming the backfill.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let service: AuthenticationService;
let clockMs: number;

/** Obviously fake keys: a byte repeated thirty-two times. Nothing here is a real key. */
const seedKey = (fill: number): string => Buffer.alloc(32, fill).toString('base64url');

/**
 * The suite runs on key version 1 alone, so every enrolment below writes `mfa1.1.…` and the
 * rotation case has something older than the active key to sweep.
 */
const seedCipher = createSeedCipher(parseSeedKeys(`1:${seedKey(0x11)}`));

const repository = new CredentialsRepository(seedCipher);

const SECRET = 'local_dev_only_session_secret_for_the_credentials_suite';

const OPTIONS: AuthenticationOptions = {
  sessionSecret: SECRET,
  maxFailuresInWindow: 5,
  failureWindowSeconds: 900,
  totpIssuer: 'TManage',
};

const IDENTITY_TABLES = [
  'users',
  'user_passwords',
  'user_mfa_factors',
  'user_recovery_codes',
  'authentication_events',
];

const context = () => ({ correlationId: uuidv7(), ip: '203.0.113.9', userAgent: 'vitest' });

const identity = () => ({ correlationId: uuidv7(), tables: IDENTITY_TABLES });

/** Unguarded observation of what actually landed, exactly as the isolation corpus does it. */
async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function events(userId?: string): Promise<RowDataPacket[]> {
  return userId === undefined
    ? observe('select * from authentication_events order by occurred_at, id')
    : observe('select * from authentication_events where user_id = ? order by occurred_at, id', [
        userId,
      ]);
}

const owner = () => world.northstar.owner;
const designer = () => world.northstar.designer;

const PASSWORD = 'a quiet line on paper';

/** The session every enrolment call in this file is made from. `D05` binds proof to it. */
const SESSION = '0198f0aa-0000-7000-8000-00000000aaaa';

/**
 * Fresh proof, minted directly. Most cases here are about passwords, factors and codes, not
 * about how proof is obtained; `D05 — re-authentication` below is where the minting path
 * itself is proved, through `confirmReauthentication`.
 */
function proofFor(userId: string, sessionId = SESSION): string {
  return signReauthToken({ userId, sessionId, expiresAt: new Date(clockMs + 60_000) }, SECRET);
}

/** Set a password directly, so a sign-in case does not depend on the enrolment path. */
async function giveOwnerAPassword(password = PASSWORD): Promise<void> {
  const hash = await hashPassword(password);
  await tenant.identityTransaction(identity(), (tx) =>
    repository.setPassword(tx, owner().id, hash),
  );
}

/** Enrol and confirm a TOTP factor, returning the secret so a test can produce codes. */
async function enrolOwnerTotp(): Promise<string> {
  const begun = await service.beginTotpEnrolment({
    userId: owner().id,
    accountName: owner().email,
    label: 'Test phone',
    context: context(),
  });
  const code = codeFor(begun.secret, clockMs);
  await service.confirmTotpFactor({
    userId: owner().id,
    factorId: begun.factorId,
    code,
    context: context(),
  });
  return begun.secret;
}

function codeFor(secret: string, atMs: number): string {
  return hotpCode(base32Decode(secret)!, totpCounterAt(atMs, 30), {
    digits: 6,
    algorithm: 'SHA1',
  });
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  // A fixed clock, so a TOTP window can be stepped rather than waited out.
  clockMs = Date.UTC(2026, 7, 26, 12, 0, 0);
  service = new AuthenticationService(tenant, OPTIONS, repository, () => clockMs);
});

beforeEach(async () => {
  // Credentials and the log are wiped between cases; the seeded world is not, because
  // rebuilding it per case costs more than every case in this file put together.
  //
  // TRUNCATE rather than DELETE, and that is not a preference: `authentication_events` is
  // append-only by trigger, so `DELETE` raises `SQLSTATE 45000` even for the migrator
  // credential. TRUNCATE is DDL and does not fire row triggers. The first run of this suite
  // failed on exactly that, which is the append-only guarantee working on its own author.
  await db.admin.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of [
      'user_recovery_codes',
      'user_mfa_factors',
      'user_passwords',
      'authentication_events',
      'session_refresh_tokens',
      'sessions',
    ]) {
      await db.admin.query(`TRUNCATE TABLE \`${table}\``);
    }
  } finally {
    await db.admin.query('SET FOREIGN_KEY_CHECKS = 1');
  }
  clockMs = Date.UTC(2026, 7, 26, 12, 0, 0);
});

afterAll(async () => {
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('setting a password', () => {
  it('stores an Argon2id hash and never the password', async () => {
    await service.setPassword({
      userId: owner().id,
      sessionId: SESSION,
      password: PASSWORD,
      context: context(),
    });

    const rows = await observe('select * from user_passwords where user_id = ?', [owner().id]);
    expect(rows).toHaveLength(1);
    const row = rows[0] as RowDataPacket;
    expect(String(row['password_hash']).startsWith('$argon2id$')).toBe(true);
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
  });

  it('replaces rather than duplicating when set twice', async () => {
    await service.setPassword({
      userId: owner().id,
      sessionId: SESSION,
      password: PASSWORD,
      context: context(),
    });
    const first = await observe('select password_hash from user_passwords where user_id = ?', [
      owner().id,
    ]);

    await service.setPassword({
      userId: owner().id,
      sessionId: SESSION,
      password: 'a different quiet line',
      reauthToken: proofFor(owner().id),
      context: context(),
    });
    const second = await observe('select password_hash from user_passwords where user_id = ?', [
      owner().id,
    ]);

    expect(second).toHaveLength(1);
    expect(second[0]!['password_hash']).not.toBe(first[0]!['password_hash']);
  });

  it('refuses a password the bundled list knows, and says exactly why', async () => {
    const error = await service
      .setPassword({
        userId: owner().id,
        sessionId: SESSION,
        password: 'Password123',
        context: context(),
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PasswordRejectedError);
    expect((error as PasswordRejectedError).rejections).toContain('commonly_breached');
    expect(await observe('select * from user_passwords')).toHaveLength(0);
  });

  it('refuses a password containing the person or their organization', async () => {
    const error = await service
      .setPassword({
        userId: owner().id,
        sessionId: SESSION,
        password: 'northstar-is-great',
        identifiers: ['Northstar'],
        context: context(),
      })
      .catch((thrown: unknown) => thrown);

    expect((error as PasswordRejectedError).rejections).toContain('contains_identifier');
  });

  it('records the change in the log', async () => {
    await service.setPassword({
      userId: owner().id,
      sessionId: SESSION,
      password: PASSWORD,
      context: context(),
    });
    const rows = await events(owner().id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['action']).toBe('password_set');
    expect(rows[0]!['outcome']).toBe('succeeded');
  });
});

describe('signing in with a password', () => {
  it('authenticates when there is no second factor', async () => {
    await giveOwnerAPassword();

    const outcome = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });

    expect(outcome).toEqual({ status: 'authenticated', userId: owner().id });
  });

  it('matches the email case-insensitively, because a person types it', async () => {
    await giveOwnerAPassword();
    const outcome = await service.signInWithPassword({
      email: owner().email.toUpperCase(),
      password: PASSWORD,
      context: context(),
    });
    expect(outcome.status).toBe('authenticated');
  });

  /**
   * Claim 1. Three different causes, one answer. The three rows below are the only place the
   * difference survives.
   */
  it.each([
    ['an unknown email', 'nobody@northstar.example', PASSWORD, 'no_such_user'],
    ['a user with no password', 'DESIGNER', PASSWORD, 'no_password_set'],
    ['a wrong password', 'OWNER', 'not the password', 'bad_password'],
  ])(
    'refuses %s with one message, and records the real reason',
    async (_name, emailSpec, password, expectedReason) => {
      await giveOwnerAPassword();

      const email =
        emailSpec === 'OWNER'
          ? owner().email
          : emailSpec === 'DESIGNER'
            ? designer().email
            : emailSpec;

      const error = await service
        .signInWithPassword({ email, password, context: context() })
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(AuthenticationRejectedError);
      expect((error as AuthenticationRejectedError).rejection).toBe('invalid_credentials');

      const rows = await events();
      const failure = rows.find((row) => row['outcome'] === 'failed');
      expect(failure?.['reason']).toBe(expectedReason);
    },
  );

  it('records the attempt even when no account holds the address', async () => {
    await service
      .signInWithPassword({
        email: 'nobody@northstar.example',
        password: PASSWORD,
        context: context(),
      })
      .catch(() => undefined);

    const rows = await events();
    expect(rows).toHaveLength(1);
    // The row that makes an enumeration sweep visible. It could not exist in `audit_events`,
    // whose `organization_id` is NOT NULL — and there is no organization here, nor a user.
    expect(rows[0]!['user_id']).toBeNull();
    expect(rows[0]!['reason']).toBe('no_such_user');
  });

  it('never writes the password into the log', async () => {
    await giveOwnerAPassword();
    await service
      .signInWithPassword({ email: owner().email, password: 'hunter2-wrong', context: context() })
      .catch(() => undefined);

    const rows = await events();
    expect(JSON.stringify(rows)).not.toContain('hunter2-wrong');
  });

  it('carries the correlation id, the address and the agent onto the row', async () => {
    await giveOwnerAPassword();
    const ctx = context();
    await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: ctx,
    });

    const rows = await events(owner().id);
    expect(rows[0]!['correlation_id']).toBe(ctx.correlationId);
    expect(rows[0]!['ip']).toBe('203.0.113.9');
    expect(rows[0]!['user_agent']).toBe('vitest');
  });

  it('upgrades a hash stored at weaker parameters, on a correct password', async () => {
    // Deliberately weak, and written straight to the table so the upgrade path is what is
    // under test rather than the setter.
    const weak =
      '$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHR2YWx1ZQ$QOdJH0Vfz3iDDR4bIT9SBQVbaJXDMvKZUKYVGHqCV6A';
    await tenant.identityTransaction(identity(), (tx) =>
      repository.setPassword(tx, owner().id, weak),
    );

    // A hash of the real password at the weak parameters, so the verify succeeds.
    const { hash: argonHash } = await import('@node-rs/argon2').then((module) => ({
      hash: module.hash,
    }));
    const weakButCorrect = await argonHash(PASSWORD, {
      memoryCost: 4096,
      timeCost: 1,
      parallelism: 1,
    });
    await tenant.identityTransaction(identity(), (tx) =>
      repository.setPassword(tx, owner().id, weakButCorrect),
    );

    await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });

    const rows = await observe('select password_hash from user_passwords where user_id = ?', [
      owner().id,
    ]);
    expect(String(rows[0]!['password_hash'])).toContain('m=19456');
  });
});

describe('the lockout window', () => {
  it('refuses once the window is full, with a different rejection', async () => {
    await giveOwnerAPassword();

    for (let attempt = 0; attempt < OPTIONS.maxFailuresInWindow; attempt += 1) {
      await service
        .signInWithPassword({ email: owner().email, password: 'wrong', context: context() })
        .catch(() => undefined);
    }

    const error = await service
      .signInWithPassword({ email: owner().email, password: PASSWORD, context: context() })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AuthenticationRejectedError);
    // `rate_limited` rather than `invalid_credentials`, because a person being told to wait
    // needs to know that waiting is the fix. It reveals that the account exists; §3's own
    // ID-02 screen already shows a rate-limit state, so this is the specified behaviour.
    expect((error as AuthenticationRejectedError).rejection).toBe('rate_limited');
    expect((error as AuthenticationRejectedError).reason).toBe('locked_out');
  });

  it('does not count a correct password toward the window', async () => {
    await giveOwnerAPassword();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service
        .signInWithPassword({ email: owner().email, password: 'wrong', context: context() })
        .catch(() => undefined);
      await service.signInWithPassword({
        email: owner().email,
        password: PASSWORD,
        context: context(),
      });
    }

    const failures = await observe(
      `select count(*) as n from authentication_events
        where user_id = ? and outcome = 'failed'`,
      [owner().id],
    );
    expect(Number(failures[0]!['n'])).toBe(3);
  });

  it('counts per user, so one account being locked does not lock another', async () => {
    await giveOwnerAPassword();
    const designerHash = await hashPassword(PASSWORD);
    await tenant.identityTransaction(identity(), (tx) =>
      repository.setPassword(tx, designer().id, designerHash),
    );

    for (let attempt = 0; attempt < OPTIONS.maxFailuresInWindow; attempt += 1) {
      await service
        .signInWithPassword({ email: owner().email, password: 'wrong', context: context() })
        .catch(() => undefined);
    }

    const outcome = await service.signInWithPassword({
      email: designer().email,
      password: PASSWORD,
      context: context(),
    });
    expect(outcome.status).toBe('authenticated');
  });
});

describe('the second factor', () => {
  it('asks for a code once a factor is confirmed', async () => {
    await giveOwnerAPassword();
    await enrolOwnerTotp();

    const outcome = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });

    expect(outcome.status).toBe('mfa_required');
    if (outcome.status !== 'mfa_required') throw new Error('unreachable');
    expect(outcome.factors).toEqual([
      { id: expect.any(String), kind: 'totp', label: 'Test phone' },
    ]);
    // The challenge names the factor and says nothing about the secret behind it.
    expect(JSON.stringify(outcome.factors)).not.toContain('secret');
  });

  it('does not ask for a code from an unconfirmed factor', async () => {
    await giveOwnerAPassword();
    await service.beginTotpEnrolment({
      userId: owner().id,
      accountName: owner().email,
      label: 'Half-finished',
      context: context(),
    });

    const outcome = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    // Opening the setup screen and closing the tab must not lock a person out.
    expect(outcome.status).toBe('authenticated');
  });

  it('completes the sign-in with a correct code', async () => {
    await giveOwnerAPassword();
    const secret = await enrolOwnerTotp();

    // A step forward, because enrolment consumed the current counter.
    clockMs += 30_000;
    const outcome = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    if (outcome.status !== 'mfa_required') throw new Error('expected a challenge');

    const completed = await service.completeMfaChallenge({
      challengeToken: outcome.challengeToken,
      code: codeFor(secret, clockMs),
      context: context(),
    });
    expect(completed).toEqual({ status: 'authenticated', userId: owner().id });
  });

  /** Claim 2. The counter column is the mechanism; this is the case that proves it works. */
  it('refuses the same code a second time, inside its own window', async () => {
    await giveOwnerAPassword();
    const secret = await enrolOwnerTotp();
    clockMs += 30_000;

    const challenge = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    if (challenge.status !== 'mfa_required') throw new Error('expected a challenge');

    const code = codeFor(secret, clockMs);
    await service.completeMfaChallenge({
      challengeToken: challenge.challengeToken,
      code,
      context: context(),
    });

    const error = await service
      .completeMfaChallenge({
        challengeToken: challenge.challengeToken,
        code,
        context: context(),
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AuthenticationRejectedError);
    expect((error as AuthenticationRejectedError).reason).toBe('mfa_replayed');
  });

  it('accepts the next code once the previous one has been spent', async () => {
    await giveOwnerAPassword();
    const secret = await enrolOwnerTotp();
    clockMs += 30_000;

    const first = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    if (first.status !== 'mfa_required') throw new Error('expected a challenge');
    await service.completeMfaChallenge({
      challengeToken: first.challengeToken,
      code: codeFor(secret, clockMs),
      context: context(),
    });

    clockMs += 30_000;
    const second = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    if (second.status !== 'mfa_required') throw new Error('expected a challenge');
    const completed = await service.completeMfaChallenge({
      challengeToken: second.challengeToken,
      code: codeFor(secret, clockMs),
      context: context(),
    });
    expect(completed.status).toBe('authenticated');
  });

  it('refuses a wrong code', async () => {
    await giveOwnerAPassword();
    await enrolOwnerTotp();
    clockMs += 30_000;

    const challenge = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    if (challenge.status !== 'mfa_required') throw new Error('expected a challenge');

    const error = await service
      .completeMfaChallenge({
        challengeToken: challenge.challengeToken,
        code: '000000',
        context: context(),
      })
      .catch((thrown: unknown) => thrown);
    expect((error as AuthenticationRejectedError).reason).toBe('mfa_bad_code');
  });

  it('refuses a challenge token signed with another secret', async () => {
    await giveOwnerAPassword();
    await enrolOwnerTotp();

    const forged = signChallengeToken(
      { userId: owner().id, expiresAt: new Date(clockMs + 60_000) },
      'a different secret entirely',
    );

    const error = await service
      .completeMfaChallenge({ challengeToken: forged, code: '123456', context: context() })
      .catch((thrown: unknown) => thrown);
    expect((error as AuthenticationRejectedError).reason).toBe('challenge_invalid');
  });

  it('refuses an expired challenge token', async () => {
    await giveOwnerAPassword();
    await enrolOwnerTotp();

    const stale = signChallengeToken(
      { userId: owner().id, expiresAt: new Date(clockMs - 1_000) },
      SECRET,
    );

    const error = await service
      .completeMfaChallenge({ challengeToken: stale, code: '123456', context: context() })
      .catch((thrown: unknown) => thrown);
    expect((error as AuthenticationRejectedError).reason).toBe('challenge_expired');
  });

  it('refuses to confirm someone else’s pending factor', async () => {
    const begun = await service.beginTotpEnrolment({
      userId: owner().id,
      accountName: owner().email,
      label: 'Owner phone',
      context: context(),
    });

    const error = await service
      .confirmTotpFactor({
        // The designer, presenting the owner's factor id and a code they can compute because
        // the enrolment response handed them the secret.
        userId: designer().id,
        factorId: begun.factorId,
        code: codeFor(begun.secret, clockMs),
        context: context(),
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AuthenticationRejectedError);
    const rows = await observe('select confirmed_at from user_mfa_factors where id = ?', [
      begun.factorId,
    ]);
    expect(rows[0]!['confirmed_at']).toBeNull();
  });

  it('removes a factor without deleting the row', async () => {
    await enrolOwnerTotp();
    const factors = await service.listFactors({
      userId: owner().id,
      correlationId: uuidv7(),
    });

    expect(
      await service.disableFactor({
        userId: owner().id,
        sessionId: SESSION,
        factorId: factors[0]!.id,
        reauthToken: proofFor(owner().id),
        context: context(),
      }),
    ).toBe(true);

    const rows = await observe('select disabled_at from user_mfa_factors where id = ?', [
      factors[0]!.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['disabled_at']).not.toBeNull();
  });

  it('will not let one person disable another’s factor', async () => {
    await enrolOwnerTotp();
    const factors = await service.listFactors({ userId: owner().id, correlationId: uuidv7() });

    expect(
      await service.disableFactor({
        userId: designer().id,
        sessionId: SESSION,
        factorId: factors[0]!.id,
        reauthToken: proofFor(designer().id),
        context: context(),
      }),
    ).toBe(false);
  });
});

describe('recovery codes', () => {
  it('are issued with the factor, hashed, and never stored in the clear', async () => {
    await enrolOwnerTotp();

    const rows = await observe('select * from user_recovery_codes where user_id = ?', [owner().id]);
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(String(row['code_hash'])).toMatch(/^[0-9a-f]{64}$/);
      expect(row['used_at']).toBeNull();
    }
  });

  it('complete a sign-in, and are then spent', async () => {
    await giveOwnerAPassword();
    await enrolOwnerTotp();
    const issued = await service.regenerateRecoveryCodes({
      userId: owner().id,
      sessionId: SESSION,
      reauthToken: proofFor(owner().id),
      context: context(),
    });
    clockMs += 30_000;

    const challenge = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    if (challenge.status !== 'mfa_required') throw new Error('expected a challenge');

    const completed = await service.completeWithRecoveryCode({
      challengeToken: challenge.challengeToken,
      code: issued.recoveryCodes[0]!,
      context: context(),
    });
    expect(completed.status).toBe('authenticated');

    const remaining = await service.countUsableRecoveryCodes({
      userId: owner().id,
      correlationId: uuidv7(),
    });
    expect(remaining).toBe(9);
  });

  /** Claim 3. Single use is the property; the second attempt must fail. */
  it('cannot be used twice', async () => {
    await giveOwnerAPassword();
    await enrolOwnerTotp();
    const issued = await service.regenerateRecoveryCodes({
      userId: owner().id,
      sessionId: SESSION,
      reauthToken: proofFor(owner().id),
      context: context(),
    });
    clockMs += 30_000;

    const challenge = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    if (challenge.status !== 'mfa_required') throw new Error('expected a challenge');

    await service.completeWithRecoveryCode({
      challengeToken: challenge.challengeToken,
      code: issued.recoveryCodes[0]!,
      context: context(),
    });

    const error = await service
      .completeWithRecoveryCode({
        challengeToken: challenge.challengeToken,
        code: issued.recoveryCodes[0]!,
        context: context(),
      })
      .catch((thrown: unknown) => thrown);

    expect((error as AuthenticationRejectedError).reason).toBe('recovery_code_invalid');
  });

  /**
   * Two requests presenting the same code at once. The `used_at IS NULL` predicate is what
   * makes exactly one of them win; without it both would read the code as unspent and both
   * would be handed a session.
   */
  it('are spent exactly once under a concurrent attempt', async () => {
    await giveOwnerAPassword();
    await enrolOwnerTotp();
    const issued = await service.regenerateRecoveryCodes({
      userId: owner().id,
      sessionId: SESSION,
      reauthToken: proofFor(owner().id),
      context: context(),
    });

    const token = signChallengeToken(
      { userId: owner().id, expiresAt: new Date(clockMs + 60_000) },
      SECRET,
    );

    const settled = await Promise.allSettled([
      service.completeWithRecoveryCode({
        challengeToken: token,
        code: issued.recoveryCodes[2]!,
        context: context(),
      }),
      service.completeWithRecoveryCode({
        challengeToken: token,
        code: issued.recoveryCodes[2]!,
        context: context(),
      }),
    ]);

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await service.countUsableRecoveryCodes({ userId: owner().id, correlationId: uuidv7() }),
    ).toBe(9);
  });

  it('regenerating invalidates the previous set immediately', async () => {
    await giveOwnerAPassword();
    await enrolOwnerTotp();
    const first = await service.regenerateRecoveryCodes({
      userId: owner().id,
      sessionId: SESSION,
      reauthToken: proofFor(owner().id),
      context: context(),
    });
    await service.regenerateRecoveryCodes({
      userId: owner().id,
      sessionId: SESSION,
      reauthToken: proofFor(owner().id),
      context: context(),
    });

    const token = signChallengeToken(
      { userId: owner().id, expiresAt: new Date(clockMs + 60_000) },
      SECRET,
    );
    const error = await service
      .completeWithRecoveryCode({
        challengeToken: token,
        code: first.recoveryCodes[0]!,
        context: context(),
      })
      .catch((thrown: unknown) => thrown);

    expect((error as AuthenticationRejectedError).reason).toBe('recovery_code_invalid');
    expect(
      await service.countUsableRecoveryCodes({ userId: owner().id, correlationId: uuidv7() }),
    ).toBe(10);
  });

  it('leaves the revoked rows in place, distinguishable from the spent ones', async () => {
    await enrolOwnerTotp();
    await service.regenerateRecoveryCodes({
      userId: owner().id,
      sessionId: SESSION,
      reauthToken: proofFor(owner().id),
      context: context(),
    });

    const rows = await observe(
      'select used_at, revoked_at from user_recovery_codes where user_id = ?',
      [owner().id],
    );
    expect(rows).toHaveLength(20);
    expect(rows.filter((row) => row['revoked_at'] !== null)).toHaveLength(10);
    // "Spent" and "replaced" are different answers to "why did my code not work".
    expect(rows.filter((row) => row['used_at'] !== null)).toHaveLength(0);
  });
});

/**
 * `D05`. A session proves that someone authenticated once; replacing the password, removing
 * the second factor and reissuing the recovery codes are the three moves that decide who can
 * authenticate from now on, and each one now needs the person to prove themselves again,
 * bound to the very session making the change.
 */
describe('D05 — re-authentication before a credential changes', () => {
  async function factorIdOf(userId: string): Promise<string> {
    const factors = await service.listFactors({ userId, correlationId: uuidv7() });
    return factors[0]!.id;
  }

  async function reject(work: Promise<unknown>): Promise<ReauthenticationRequiredError> {
    const error = await work.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ReauthenticationRequiredError);
    return error as ReauthenticationRequiredError;
  }

  it('lets a first password be set with no proof, because there is nothing to re-present', async () => {
    await service.setPassword({
      userId: owner().id,
      sessionId: SESSION,
      password: PASSWORD,
      context: context(),
    });
    expect(
      await observe('select * from user_passwords where user_id = ?', [owner().id]),
    ).toHaveLength(1);
  });

  it('refuses to replace an existing password without proof, and changes nothing', async () => {
    await giveOwnerAPassword();
    const before = await observe('select password_hash from user_passwords where user_id = ?', [
      owner().id,
    ]);

    const error = await reject(
      service.setPassword({
        userId: owner().id,
        sessionId: SESSION,
        password: 'a different quiet line',
        context: context(),
      }),
    );
    expect(error.reason).toBe('reauth_required');

    const after = await observe('select password_hash from user_passwords where user_id = ?', [
      owner().id,
    ]);
    expect(after[0]!['password_hash']).toBe(before[0]!['password_hash']);

    const rows = await events(owner().id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['action']).toBe('password_set');
    expect(rows[0]!['outcome']).toBe('failed');
    expect(rows[0]!['reason']).toBe('reauth_required');
  });

  it('refuses to remove a factor without proof, and the factor stays live', async () => {
    await enrolOwnerTotp();
    const factorId = await factorIdOf(owner().id);

    const error = await reject(
      service.disableFactor({
        userId: owner().id,
        sessionId: SESSION,
        factorId,
        context: context(),
      }),
    );
    expect(error.reason).toBe('reauth_required');

    const rows = await observe('select disabled_at from user_mfa_factors where id = ?', [factorId]);
    expect(rows[0]!['disabled_at']).toBeNull();
  });

  it('refuses to reissue recovery codes without proof, and the old set stays usable', async () => {
    await enrolOwnerTotp();

    const error = await reject(
      service.regenerateRecoveryCodes({
        userId: owner().id,
        sessionId: SESSION,
        context: context(),
      }),
    );
    expect(error.reason).toBe('reauth_required');

    expect(
      await service.countUsableRecoveryCodes({ userId: owner().id, correlationId: uuidv7() }),
    ).toBe(10);
    expect(
      await observe('select * from user_recovery_codes where user_id = ?', [owner().id]),
    ).toHaveLength(10);
  });

  /** The acceptance criterion: proof minted in one session is not proof in another. */
  it('refuses proof minted for another session, even the same person’s', async () => {
    await enrolOwnerTotp();
    const error = await reject(
      service.regenerateRecoveryCodes({
        userId: owner().id,
        sessionId: SESSION,
        reauthToken: proofFor(owner().id, '0198f0aa-0000-7000-8000-00000000bbbb'),
        context: context(),
      }),
    );
    expect(error.reason).toBe('reauth_wrong_session');
  });

  it('refuses proof minted for another person in the same session id', async () => {
    await enrolOwnerTotp();
    const error = await reject(
      service.disableFactor({
        userId: owner().id,
        sessionId: SESSION,
        factorId: await factorIdOf(owner().id),
        reauthToken: proofFor(designer().id),
        context: context(),
      }),
    );
    expect(error.reason).toBe('reauth_wrong_session');
  });

  it('refuses expired proof, forged proof, and a challenge token presented as proof', async () => {
    await enrolOwnerTotp();
    const attempt = (reauthToken: string) =>
      reject(
        service.regenerateRecoveryCodes({
          userId: owner().id,
          sessionId: SESSION,
          reauthToken,
          context: context(),
        }),
      );

    const expired = signReauthToken(
      { userId: owner().id, sessionId: SESSION, expiresAt: new Date(clockMs - 1) },
      SECRET,
    );
    expect((await attempt(expired)).reason).toBe('reauth_expired');

    const forged = signReauthToken(
      { userId: owner().id, sessionId: SESSION, expiresAt: new Date(clockMs + 60_000) },
      'another secret entirely',
    );
    expect((await attempt(forged)).reason).toBe('reauth_invalid');

    const challenge = signChallengeToken(
      { userId: owner().id, expiresAt: new Date(clockMs + 60_000) },
      SECRET,
    );
    expect((await attempt(challenge)).reason).toBe('reauth_invalid');
  });

  describe('obtaining proof', () => {
    it('mints proof from a correct password when there is no factor, bound to the session', async () => {
      await giveOwnerAPassword();
      const minted = await service.confirmReauthentication({
        userId: owner().id,
        sessionId: SESSION,
        password: PASSWORD,
        context: context(),
      });
      expect(minted.expiresAt.getTime()).toBe(clockMs + 300_000);

      // Usable on the enforcement points, in this session only.
      await service.setPassword({
        userId: owner().id,
        sessionId: SESSION,
        password: 'a different quiet line',
        reauthToken: minted.reauthToken,
        context: context(),
      });
      const elsewhere = await reject(
        service.regenerateRecoveryCodes({
          userId: owner().id,
          sessionId: '0198f0aa-0000-7000-8000-00000000bbbb',
          reauthToken: minted.reauthToken,
          context: context(),
        }),
      );
      expect(elsewhere.reason).toBe('reauth_wrong_session');

      const rows = await events(owner().id);
      expect(rows.map((row) => [row['action'], row['outcome']])).toEqual([
        ['reauthentication', 'succeeded'],
        ['password_set', 'succeeded'],
        ['recovery_codes_issued', 'failed'],
      ]);
    });

    it('refuses a wrong password with the sign-in vocabulary, and logs the precise cause', async () => {
      await giveOwnerAPassword();
      const error = await service
        .confirmReauthentication({
          userId: owner().id,
          sessionId: SESSION,
          password: 'not it',
          context: context(),
        })
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(AuthenticationRejectedError);
      expect((error as AuthenticationRejectedError).rejection).toBe('invalid_credentials');
      expect((error as AuthenticationRejectedError).reason).toBe('bad_password');
      const rows = await events(owner().id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!['action']).toBe('reauthentication');
      expect(rows[0]!['reason']).toBe('bad_password');
    });

    it('refuses when no password is set, with the same rejection', async () => {
      const error = await service
        .confirmReauthentication({
          userId: owner().id,
          sessionId: SESSION,
          password: PASSWORD,
          context: context(),
        })
        .catch((thrown: unknown) => thrown);
      expect((error as AuthenticationRejectedError).rejection).toBe('invalid_credentials');
      expect((error as AuthenticationRejectedError).reason).toBe('no_password_set');
    });

    it('requires a code once a factor is confirmed, and accepts the right one once', async () => {
      await giveOwnerAPassword();
      const secret = await enrolOwnerTotp();
      clockMs += 30_000;

      const withoutCode = await service
        .confirmReauthentication({
          userId: owner().id,
          sessionId: SESSION,
          password: PASSWORD,
          context: context(),
        })
        .catch((thrown: unknown) => thrown);
      expect((withoutCode as AuthenticationRejectedError).rejection).toBe('invalid_credentials');
      expect((withoutCode as AuthenticationRejectedError).reason).toBe('mfa_bad_code');

      const wrongCode = await service
        .confirmReauthentication({
          userId: owner().id,
          sessionId: SESSION,
          password: PASSWORD,
          code: '000000',
          context: context(),
        })
        .catch((thrown: unknown) => thrown);
      expect((wrongCode as AuthenticationRejectedError).reason).toBe('mfa_bad_code');

      const code = codeFor(secret, clockMs);
      const minted = await service.confirmReauthentication({
        userId: owner().id,
        sessionId: SESSION,
        password: PASSWORD,
        code,
        context: context(),
      });

      // The same code again is a replay, exactly as it would be at sign-in.
      const replayed = await service
        .confirmReauthentication({
          userId: owner().id,
          sessionId: SESSION,
          password: PASSWORD,
          code,
          context: context(),
        })
        .catch((thrown: unknown) => thrown);
      expect((replayed as AuthenticationRejectedError).reason).toBe('mfa_replayed');

      // And the proof it minted removes the factor.
      expect(
        await service.disableFactor({
          userId: owner().id,
          sessionId: SESSION,
          factorId: await factorIdOf(owner().id),
          reauthToken: minted.reauthToken,
          context: context(),
        }),
      ).toBe(true);
    });

    it('shares the sign-in lockout window in both directions', async () => {
      await giveOwnerAPassword();

      // Failures here count against sign-in.
      for (let attempt = 0; attempt < OPTIONS.maxFailuresInWindow; attempt += 1) {
        await service
          .confirmReauthentication({
            userId: owner().id,
            sessionId: SESSION,
            password: 'not it',
            context: context(),
          })
          .catch(() => undefined);
      }
      const signIn = await service
        .signInWithPassword({ email: owner().email, password: PASSWORD, context: context() })
        .catch((thrown: unknown) => thrown);
      expect((signIn as AuthenticationRejectedError).rejection).toBe('rate_limited');

      // And a locked-out account cannot mint proof with the right password either.
      const locked = await service
        .confirmReauthentication({
          userId: owner().id,
          sessionId: SESSION,
          password: PASSWORD,
          context: context(),
        })
        .catch((thrown: unknown) => thrown);
      expect((locked as AuthenticationRejectedError).rejection).toBe('rate_limited');
      expect((locked as AuthenticationRejectedError).reason).toBe('locked_out');
    });
  });
});

describe('the log', () => {
  it('refuses an UPDATE, even from the migrator credential', async () => {
    await giveOwnerAPassword();
    await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    const rows = await events(owner().id);

    await expect(
      db.admin.query('update authentication_events set outcome = ? where id = ?', [
        'succeeded',
        rows[0]!['id'],
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a DELETE', async () => {
    await giveOwnerAPassword();
    await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    const rows = await events(owner().id);

    await expect(
      db.admin.query('delete from authentication_events where id = ?', [rows[0]!['id']]),
    ).rejects.toThrow(/append-only/);
  });

  /**
   * Claim 4, the structural half. The identity path exists precisely so that authentication
   * cannot reach tenant data, and these tables are on it.
   */
  it('cannot reach a tenant table from the identity path', async () => {
    await expect(
      tenant.identityRead({ correlationId: uuidv7(), tables: IDENTITY_TABLES }, async (db) => {
        await db.query('select id from projects limit 1', []);
      }),
    ).rejects.toBeInstanceOf(IdentityScopeViolation);
  });
});

/**
 * `D06`. A password is replaced to *recover* from a suspected compromise as often as for any
 * other reason, and a session the intruder already holds does not care that the password it
 * was opened with is gone. So replacing the password ends every other live session the person
 * has, in the same transaction as the new hash — the row and the cutoff land together or not
 * at all. The session that proved itself (`D05` bound the proof to it) is the one kept: it is
 * the device the person is holding, and signing it out would turn the recovery into a lockout.
 * A *first* password ends nothing, because no session was ever opened against a password that
 * is now stale.
 */
describe('D06 — replacing a password ends every other session', () => {
  const sessionsRepository = new SessionsRepository();
  const SESSION_TABLES = ['sessions', 'session_refresh_tokens'];

  /** A live session row, opened directly: this file is about credentials, not sign-in. */
  async function openSession(userId: string, agent: string): Promise<string> {
    const row = await tenant.identityTransaction(
      { correlationId: uuidv7(), tables: SESSION_TABLES },
      (tx) =>
        sessionsRepository.create(tx, {
          userId,
          refreshTokenHash: uuidv7().replaceAll('-', '').padEnd(64, '0'),
          userAgent: agent,
          ttlSeconds: 3600,
        }),
    );
    return row.id;
  }

  async function sessionRows(userId: string): Promise<RowDataPacket[]> {
    return observe(
      'select id, revoked_at, revoked_reason from sessions where user_id = ? order by id',
      [userId],
    );
  }

  it('revokes the other sessions with the reason recorded, and keeps the proving one', async () => {
    await giveOwnerAPassword();
    const here = await openSession(owner().id, 'the laptop in hand');
    const elsewhere = await openSession(owner().id, 'a phone left on a desk');
    const another = await openSession(owner().id, 'an intruder');
    const someoneElse = await openSession(designer().id, 'a colleague');

    await service.setPassword({
      userId: owner().id,
      sessionId: here,
      password: 'a different quiet line',
      reauthToken: proofFor(owner().id, here),
      context: context(),
    });

    const rows = await sessionRows(owner().id);
    const byId = new Map(rows.map((row) => [row['id'], row]));
    expect(byId.get(here)!['revoked_at']).toBeNull();
    for (const ended of [elsewhere, another]) {
      expect(byId.get(ended)!['revoked_at']).not.toBeNull();
      expect(byId.get(ended)!['revoked_reason']).toBe('password_changed');
    }
    // Another person's session is not this person's to end.
    const theirs = await sessionRows(designer().id);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!['id']).toBe(someoneElse);
    expect(theirs[0]!['revoked_at']).toBeNull();
  });

  it('ends nothing when the first password is set', async () => {
    const here = await openSession(owner().id, 'the laptop in hand');
    const elsewhere = await openSession(owner().id, 'a phone');

    await service.setPassword({
      userId: owner().id,
      sessionId: here,
      password: PASSWORD,
      context: context(),
    });

    const rows = await sessionRows(owner().id);
    expect(rows.map((row) => row['revoked_at'])).toEqual([null, null]);
    expect(rows.map((row) => row['id'])).toEqual([here, elsewhere].sort());
  });

  it('ends nothing when the replacement is refused or rejected', async () => {
    await giveOwnerAPassword();
    const here = await openSession(owner().id, 'the laptop in hand');
    await openSession(owner().id, 'a phone');

    await expect(
      service.setPassword({
        userId: owner().id,
        sessionId: here,
        password: 'a different quiet line',
        context: context(),
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
    await expect(
      service.setPassword({
        userId: owner().id,
        sessionId: here,
        password: 'password',
        reauthToken: proofFor(owner().id, here),
        context: context(),
      }),
    ).rejects.toBeInstanceOf(PasswordRejectedError);

    const rows = await sessionRows(owner().id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row['revoked_at'])).toEqual([null, null]);
  });
});

/**
 * `D07`. The TOTP seed was written to `user_mfa_factors.secret` exactly as the authenticator
 * produced it, so a database dump or a backup disclosure handed over every second factor in
 * the system. It now holds an AES-256-GCM envelope under a key that lives in the
 * environment, and the cases below are the four things that has to mean in a real database
 * rather than in a unit test: the column no longer holds the seed; editing it breaks it;
 * moving it between rows breaks it; and a row nobody has swept yet refuses rather than works.
 *
 * `db.admin` is used to read and to corrupt the column directly, exactly as the cases above
 * use it to observe what actually landed — the point is what an attacker with database
 * access can and cannot do, so the assertions have to be made from that side of the line.
 */
describe('D07 — the seed is ciphertext in the column', () => {
  /** Keys 1 and 2. Version 2 is active, so version 1 rows are what the sweep rotates. */
  const rotatedCipher = createSeedCipher(parseSeedKeys(`1:${seedKey(0x11)};2:${seedKey(0x22)}`));

  /** A real seed shape: RFC 4648 base32, which is what the column held before D07. */
  const LEGACY_SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

  async function givePassword(userId: string): Promise<void> {
    const hash = await hashPassword(PASSWORD);
    await tenant.identityTransaction(identity(), (tx) => repository.setPassword(tx, userId, hash));
  }

  async function enrolTotpFor(
    user: { id: string; email: string },
    label: string,
  ): Promise<{ factorId: string; secret: string }> {
    const begun = await service.beginTotpEnrolment({
      userId: user.id,
      accountName: user.email,
      label,
      context: context(),
    });
    await service.confirmTotpFactor({
      userId: user.id,
      factorId: begun.factorId,
      code: codeFor(begun.secret, clockMs),
      context: context(),
    });
    return { factorId: begun.factorId, secret: begun.secret };
  }

  /** The column as a dump would show it. Never through the repository, which decrypts. */
  async function rawSecret(factorId: string): Promise<string> {
    const rows = await observe('select secret from user_mfa_factors where id = ?', [factorId]);
    return String(rows[0]!['secret']);
  }

  async function setRawSecret(factorId: string, secret: string): Promise<void> {
    await db.admin.query('update user_mfa_factors set secret = ? where id = ?', [secret, factorId]);
  }

  /** Alter one character of the ciphertext field, keeping it valid base64url. */
  function tamper(envelope: string): string {
    const parts = envelope.split('.');
    const ciphertext = parts[3];
    if (ciphertext === undefined) throw new Error('not an envelope');
    parts[3] = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1);
    return parts.join('.');
  }

  async function refusal(work: Promise<unknown>): Promise<SeedCipherError> {
    const error = await work.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SeedCipherError);
    return error as SeedCipherError;
  }

  /** (a) The acceptance criterion: a dump contains ciphertext rather than a usable seed. */
  it('writes an envelope, not the seed the enrolment handed back', async () => {
    const begun = await service.beginTotpEnrolment({
      userId: owner().id,
      accountName: owner().email,
      label: 'Test phone',
      context: context(),
    });

    expect(await rawSecret(begun.factorId)).toMatch(/^mfa1\.1\./);
    // The whole row, not just the column: nothing else quietly keeps a copy.
    const rows = await observe('select * from user_mfa_factors where id = ?', [begun.factorId]);
    expect(JSON.stringify(rows)).not.toContain(begun.secret);
  });

  /** (b) "Altered ciphertext is rejected", stated as the thing a person would notice. */
  it('refuses the sign-in after one character of the stored ciphertext is altered', async () => {
    await givePassword(owner().id);
    const enrolled = await enrolTotpFor(owner(), 'Test phone');
    clockMs += 30_000;

    await setRawSecret(enrolled.factorId, tamper(await rawSecret(enrolled.factorId)));

    const error = await refusal(
      service.signInWithPassword({
        email: owner().email,
        password: PASSWORD,
        context: context(),
      }),
    );
    // Not "wrong code", and not a challenge either: the read fails, so no sign-in of any
    // kind is offered. Failing closed is the whole point of the tag.
    expect(error.reason).toBe('authentication_failed');
  });

  /** (c) The AAD, under test. Ciphertext is not portable between rows. */
  it('refuses a ciphertext moved into another person’s row', async () => {
    await givePassword(owner().id);
    await givePassword(designer().id);
    const ownersFactor = await enrolTotpFor(owner(), 'Owner phone');
    const designersFactor = await enrolTotpFor(designer(), 'Designer phone');

    await setRawSecret(designersFactor.factorId, await rawSecret(ownersFactor.factorId));

    const error = await refusal(
      service.signInWithPassword({
        email: designer().email,
        password: PASSWORD,
        context: context(),
      }),
    );
    expect(error.reason).toBe('authentication_failed');

    // And the row it was copied from is untouched, so this is the transplant failing rather
    // than the suite having broken both factors.
    clockMs += 30_000;
    const outcome = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    expect(outcome.status).toBe('mfa_required');
  });

  /** (d) "Rotation works": a second key, a sweep, and the same authenticator still signs in. */
  it('rotates a factor onto a new key version without invalidating the authenticator', async () => {
    await givePassword(owner().id);
    const enrolled = await enrolTotpFor(owner(), 'Test phone');
    expect(await rawSecret(enrolled.factorId)).toMatch(/^mfa1\.1\./);

    const report = await encryptSeeds(db.admin, rotatedCipher);
    expect(report).toMatchObject({
      plaintextEncrypted: 0,
      rotated: 1,
      unchanged: 0,
      failed: 0,
    });
    expect(await rawSecret(enrolled.factorId)).toMatch(/^mfa1\.2\./);

    // The API restarted with both keys: same options, same clock, a repository holding the
    // rotated keyring. The person's authenticator knows nothing about any of this.
    const rotated = new AuthenticationService(
      tenant,
      OPTIONS,
      new CredentialsRepository(rotatedCipher),
      () => clockMs,
    );
    clockMs += 30_000;
    const challenge = await rotated.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    if (challenge.status !== 'mfa_required') throw new Error('expected a challenge');
    const completed = await rotated.completeMfaChallenge({
      challengeToken: challenge.challengeToken,
      code: codeFor(enrolled.secret, clockMs),
      context: context(),
    });
    expect(completed).toEqual({ status: 'authenticated', userId: owner().id });

    // A second sweep has nothing left to do, which is what makes the command safe to re-run.
    expect(await encryptSeeds(db.admin, rotatedCipher)).toMatchObject({
      rotated: 0,
      unchanged: 1,
      failed: 0,
    });
  });

  /**
   * (e) A row from before the backfill. It holds a *usable* seed, which is exactly why it
   * must not be used: accepting it would leave plaintext working forever, invisibly.
   */
  it('refuses a row still holding a bare seed, and names the command that fixes it', async () => {
    await givePassword(owner().id);
    const factorId = uuidv7();
    await db.admin.query(
      `insert into user_mfa_factors (id, user_id, kind, label, secret, confirmed_at, created_at)
       values (?, ?, 'totp', 'Legacy phone', ?, current_timestamp(3), current_timestamp(3))`,
      [factorId, owner().id, LEGACY_SEED],
    );

    const error = await refusal(
      service.signInWithPassword({
        email: owner().email,
        password: PASSWORD,
        context: context(),
      }),
    );
    expect(error.reason).toBe('not_encrypted');
    expect(error.message).toContain('mfa:encrypt-seeds');
  });

  it('encrypts that row when the backfill is run, keeping the seed the person enrolled', async () => {
    await givePassword(owner().id);
    const factorId = uuidv7();
    await db.admin.query(
      `insert into user_mfa_factors (id, user_id, kind, label, secret, confirmed_at, created_at)
       values (?, ?, 'totp', 'Legacy phone', ?, current_timestamp(3), current_timestamp(3))`,
      [factorId, owner().id, LEGACY_SEED],
    );

    const report = await encryptSeeds(db.admin, seedCipher);
    expect(report).toMatchObject({ plaintextEncrypted: 1, rotated: 0, failed: 0 });

    const stored = await rawSecret(factorId);
    expect(stored).toMatch(/^mfa1\.1\./);
    expect(seedCipher.decrypt(stored, { userId: owner().id })).toBe(LEGACY_SEED);

    // And the sign-in the previous case refused now reaches the challenge.
    const outcome = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    expect(outcome.status).toBe('mfa_required');
  });
});
