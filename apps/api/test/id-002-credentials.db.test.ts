import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import {
  AUTH_ABUSE_MAX_PER_SOURCE_ACCOUNT_DEFAULT,
  AUTH_MAX_FAILURES_IN_WINDOW_DEFAULT,
  parseSeedKeys,
} from '@tmanage/config';
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
import { createSignInAbuseControl } from '../src/modules/identity/sign-in-abuse-control.js';
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

/** The window `D08`'s control runs on here, in milliseconds — the config carries seconds. */
const ABUSE_WINDOW_MS = 300 * 1000;

const OPTIONS: AuthenticationOptions = {
  sessionSecret: SECRET,
  maxFailuresInWindow: 5,
  failureWindowSeconds: 900,
  totpIssuer: 'TManage',
  // `D08`. Deliberately far above anything this suite does: it makes some thirty-odd password
  // sign-ins and as many re-authentications from the single address `203.0.113.9`, and a
  // production-sized budget here would refuse cases that are about factors and recovery codes
  // and prove nothing about either. The cases that are about the bound build their own control
  // with a tight budget, below.
  //
  // Read the budget as file-global and never reset: this control is built once at module load
  // and reads the same `clockMs` every case does, and `beforeEach` sets that clock *back* to
  // the same fixed instant, which a fixed window reads as one continuous window — so these
  // counts accumulate across every case in the file and are never cleared. That is exactly
  // why the numbers here are far above what the whole file spends.
  abuseControl: createSignInAbuseControl({
    windowMs: ABUSE_WINDOW_MS,
    maxPerSource: 1000,
    maxPerSourceAccount: 1000,
    maxGlobal: 10_000,
    now: () => clockMs,
  }),
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
  // `D05` third clause: both halves of the enrolment are behind fresh proof, because
  // confirming replaces the recovery codes and hands the new set back.
  const begun = await service.beginTotpEnrolment({
    userId: owner().id,
    sessionId: SESSION,
    accountName: owner().email,
    label: 'Test phone',
    reauthToken: proofFor(owner().id),
    context: context(),
  });
  const code = codeFor(begun.secret, clockMs);
  await service.confirmTotpFactor({
    userId: owner().id,
    sessionId: SESSION,
    factorId: begun.factorId,
    code,
    reauthToken: proofFor(owner().id),
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

/**
 * `D08` — the bound the lockout above could never be.
 *
 * The lockout counts failures per *user*. One address trying one password against a thousand
 * addresses it guessed passes it every time, because every attempt is a fresh user: a read, an
 * Argon2 verify and a row, each. These cases are about the bound that counts by *source*, and
 * they are the acceptance evidence for the finding — proved on rows, not on timings.
 *
 * Each case builds its **own** service on its **own** control, because the control's map *is*
 * the state: a shared one would carry the previous case's window into the next.
 */
describe('D08 — bounding sign-in by where the attempt came from', () => {
  /** A context from a chosen address; the suite's own `context()` is fixed to one. */
  const from = (ip: string) => ({ correlationId: uuidv7(), ip, userAgent: 'vitest' });

  function tightlyBounded(budgets: {
    maxPerSource: number;
    maxPerSourceAccount: number;
  }): AuthenticationService {
    return new AuthenticationService(
      tenant,
      {
        ...OPTIONS,
        abuseControl: createSignInAbuseControl({
          windowMs: ABUSE_WINDOW_MS,
          maxPerSource: budgets.maxPerSource,
          maxPerSourceAccount: budgets.maxPerSourceAccount,
          // Never the narrowest bound in these cases; a global refusal here would name a
          // different reason and prove something else.
          maxGlobal: 10_000,
          now: () => clockMs,
        }),
      },
      repository,
      () => clockMs,
    );
  }

  async function refusal(work: Promise<unknown>): Promise<AuthenticationRejectedError> {
    const error = await work.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AuthenticationRejectedError);
    return error as AuthenticationRejectedError;
  }

  const reasons = (rows: readonly RowDataPacket[], reason: string) =>
    rows.filter((row) => row['reason'] === reason);

  /** What the durable lockout would see right now, read through the production predicate. */
  const countedFailures = (userId: string, windowSeconds = OPTIONS.failureWindowSeconds) =>
    tenant.identityRead(identity(), (db) =>
      repository.countRecentFailures(db, userId, windowSeconds),
    );

  /**
   * Real time, and the only place in this file that spends any.
   *
   * `countRecentFailures` expresses its window as `now(3)` on the server, deliberately (a
   * `Date` from Node would make the lockout depend on the API instance's clock). So the one
   * case that has to watch a lockout window *end* cannot step `clockMs` to do it — it has to
   * let the database's own clock pass the boundary.
   */
  const sleepUntil = (at: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, at - Date.now()));
    });

  /**
   * (a) The acceptance sentence. A spray across distinct unknown addresses is refused, and the
   * refusal costs **one** row — not one per attempt beyond the budget, which would be the same
   * log flood in a different colour.
   */
  it('refuses a spray across many accounts and writes one row for the whole refusal', async () => {
    const MAX_PER_SOURCE = 3;
    const spraying = tightlyBounded({ maxPerSource: MAX_PER_SOURCE, maxPerSourceAccount: 100 });
    const SOURCE = '198.51.100.7';

    // A different unknown address every time: exactly the shape the per-user lockout cannot
    // see, because each attempt is a fresh user and passes that counter untouched.
    for (let attempt = 0; attempt < MAX_PER_SOURCE; attempt += 1) {
      await spraying
        .signInWithPassword({
          email: `sprayed-${attempt}@northstar.example`,
          password: PASSWORD,
          context: from(SOURCE),
        })
        .catch(() => undefined);
    }

    const refused = await refusal(
      spraying.signInWithPassword({
        email: `sprayed-${MAX_PER_SOURCE}@northstar.example`,
        password: PASSWORD,
        context: from(SOURCE),
      }),
    );
    expect(refused.rejection).toBe('rate_limited');
    expect(refused.reason).toBe('source_throttled');

    const rows = await events();
    expect(rows).toHaveLength(MAX_PER_SOURCE + 1);
    expect(reasons(rows, 'no_such_user')).toHaveLength(MAX_PER_SOURCE);
    const throttle = reasons(rows, 'source_throttled');
    expect(throttle).toHaveLength(1);
    expect(throttle[0]!['user_id']).toBeNull();
    expect(throttle[0]!['action']).toBe('password_sign_in');
    expect(throttle[0]!['outcome']).toBe('failed');
    expect(throttle[0]!['ip']).toBe(SOURCE);

    // And the flood is bounded, which is the half a single refusal cannot show: three more
    // refused attempts add no rows at all. One row per key per window, as the design says —
    // bounded *per key*, so a caller that goes on to cross the source budget from a second
    // address buys one more row there, and no more.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await spraying
        .signInWithPassword({
          email: `sprayed-later-${attempt}@northstar.example`,
          password: PASSWORD,
          context: from(SOURCE),
        })
        .catch(() => undefined);
    }
    expect(await events()).toHaveLength(MAX_PER_SOURCE + 1);
  });

  /**
   * (b) The refusal happens in front of the read and in front of Argon2. There is no timing
   * assertion here on purpose — a stopwatch in a test suite proves nothing repeatable. The
   * evidence is the row that would exist if the verify had run, and does not.
   */
  it('reaches neither the user lookup nor Argon2 for a refused attempt', async () => {
    await giveOwnerAPassword();
    const MAX_PER_SOURCE = 3;
    const grinding = tightlyBounded({ maxPerSource: MAX_PER_SOURCE, maxPerSourceAccount: 100 });
    const SOURCE = '198.51.100.8';

    for (let attempt = 0; attempt < MAX_PER_SOURCE; attempt += 1) {
      await grinding
        .signInWithPassword({
          email: `filler-${attempt}@northstar.example`,
          password: PASSWORD,
          context: from(SOURCE),
        })
        .catch(() => undefined);
    }
    expect(await events()).toHaveLength(MAX_PER_SOURCE);

    // A real account and a wrong password. Reaching the read would produce `bad_password`;
    // reaching an unknown address would produce `no_such_user`. Neither appears.
    const refused = await refusal(
      grinding.signInWithPassword({
        email: owner().email,
        password: 'not the password',
        context: from(SOURCE),
      }),
    );
    expect(refused.reason).toBe('source_throttled');

    const after = await events();
    expect(after).toHaveLength(MAX_PER_SOURCE + 1);
    expect(reasons(after, 'bad_password')).toHaveLength(0);
    expect(reasons(after, 'no_such_user')).toHaveLength(MAX_PER_SOURCE);
    expect(reasons(after, 'source_throttled')).toHaveLength(1);

    // The owner's own failure count is untouched, so a refused attempt cannot be used to push
    // a real account toward the lockout either.
    expect(await events(owner().id)).toHaveLength(0);
  });

  /**
   * (c) The narrower key, and the finding's shared-office warning answered on rows: an address
   * grinding one account is stopped ahead of the lockout, and the account itself is not locked
   * by anybody else's traffic.
   */
  it('stops one address grinding one account ahead of the lockout, without locking it', async () => {
    await giveOwnerAPassword();
    const MAX_PER_SOURCE_ACCOUNT = 3;
    // The point of "ahead of": the address is refused while the account is still three
    // failures into a window that wants five.
    expect(MAX_PER_SOURCE_ACCOUNT).toBeLessThan(OPTIONS.maxFailuresInWindow);

    // Audit C-1. The two lines above are a property of literals this file chose, and that is
    // exactly why this test stayed green while the product shipped 10 against 5. The harness
    // must at least not lie about the threshold it is modelling, and the shipped pair must
    // hold the same relation the mechanism below demonstrates. The binding assertions live
    // in `packages/config/src/env.test.ts` and `src/common/http/api-config.test.ts`, which
    // run without a database; these two keep this file honest about what it is a model of.
    expect(OPTIONS.maxFailuresInWindow).toBe(AUTH_MAX_FAILURES_IN_WINDOW_DEFAULT);
    expect(AUTH_ABUSE_MAX_PER_SOURCE_ACCOUNT_DEFAULT).toBeLessThan(
      AUTH_MAX_FAILURES_IN_WINDOW_DEFAULT,
    );

    const grinding = tightlyBounded({
      maxPerSource: 100,
      maxPerSourceAccount: MAX_PER_SOURCE_ACCOUNT,
    });

    for (let attempt = 0; attempt < MAX_PER_SOURCE_ACCOUNT; attempt += 1) {
      await grinding
        .signInWithPassword({
          email: owner().email,
          password: 'wrong',
          context: from('198.51.100.9'),
        })
        .catch(() => undefined);
    }

    const refused = await refusal(
      grinding.signInWithPassword({
        email: owner().email,
        password: 'wrong',
        context: from('198.51.100.9'),
      }),
    );
    expect(refused.rejection).toBe('rate_limited');
    // The narrowest bound names itself: the address is nowhere near its own budget of 100.
    expect(refused.reason).toBe('source_account_throttled');

    const failures = await observe(
      `select count(*) as n from authentication_events
        where user_id = ? and outcome = 'failed' and reason = 'bad_password'`,
      [owner().id],
    );
    expect(Number(failures[0]!['n'])).toBe(MAX_PER_SOURCE_ACCOUNT);

    // No lockout by proxy. Same account, same window, a second address, the right password:
    // admitted. The source keys refuse *requests from that source*; they do not touch the
    // user's failure count, which is exactly what a shared office needs them not to do.
    const outcome = await grinding.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: from('203.0.113.200'),
    });
    expect(outcome).toEqual({ status: 'authenticated', userId: owner().id });
  });

  /**
   * (d) Self-healing, which is what makes this a bound and not a lockout. Every attempt below
   * carries the *right* password: success is not exempt from the count — a caller sitting on
   * the boundary must not be able to keep guessing — which is why the production per-source
   * default is thirty and not five.
   */
  it('lets the same address back in once the window turns', async () => {
    await giveOwnerAPassword();
    const MAX_PER_SOURCE = 3;
    const bounded = tightlyBounded({ maxPerSource: MAX_PER_SOURCE, maxPerSourceAccount: 100 });
    const SOURCE = '198.51.100.10';

    for (let attempt = 0; attempt < MAX_PER_SOURCE; attempt += 1) {
      const admitted = await bounded.signInWithPassword({
        email: owner().email,
        password: PASSWORD,
        context: from(SOURCE),
      });
      expect(admitted.status).toBe('authenticated');
    }

    const refused = await refusal(
      bounded.signInWithPassword({
        email: owner().email,
        password: PASSWORD,
        context: from(SOURCE),
      }),
    );
    expect(refused.rejection).toBe('rate_limited');
    expect(refused.reason).toBe('source_throttled');

    // Nothing is unlocked by hand and no operator is involved. The window turns.
    clockMs += ABUSE_WINDOW_MS + 1_000;

    const outcome = await bounded.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: from(SOURCE),
    });
    expect(outcome).toEqual({ status: 'authenticated', userId: owner().id });
  });

  /**
   * (e) `D05`'s re-authentication is the second password oracle in the file and costs the same
   * Argon2 verify, so the same bound sits in front of it — keyed by `userId` rather than by an
   * email, because that is what the caller names there.
   */
  it('bounds re-authentication too, and revokes nothing doing it', async () => {
    await giveOwnerAPassword();
    const designerHash = await hashPassword(PASSWORD);
    await tenant.identityTransaction(identity(), (tx) =>
      repository.setPassword(tx, designer().id, designerHash),
    );

    const MAX_PER_SOURCE_ACCOUNT = 2;
    const bounded = tightlyBounded({
      maxPerSource: 100,
      maxPerSourceAccount: MAX_PER_SOURCE_ACCOUNT,
    });

    for (let attempt = 0; attempt < MAX_PER_SOURCE_ACCOUNT; attempt += 1) {
      const minted = await bounded.confirmReauthentication({
        userId: owner().id,
        sessionId: SESSION,
        password: PASSWORD,
        context: from('198.51.100.11'),
      });
      expect(minted.expiresAt.getTime()).toBe(clockMs + 300_000);
    }

    const refused = await refusal(
      bounded.confirmReauthentication({
        userId: owner().id,
        sessionId: SESSION,
        password: PASSWORD,
        context: from('198.51.100.11'),
      }),
    );
    expect(refused.rejection).toBe('rate_limited');
    expect(refused.reason).toBe('source_account_throttled');

    // The session is untouched: this control refuses requests from a source, it does not
    // revoke anything and it writes nothing to `sessions`. The same session proves itself
    // again from a second address, inside the same window.
    const elsewhere = await bounded.confirmReauthentication({
      userId: owner().id,
      sessionId: SESSION,
      password: PASSWORD,
      context: from('203.0.113.201'),
    });
    expect(elsewhere.expiresAt.getTime()).toBe(clockMs + 300_000);

    // And another person, from another address, is not caught by any of it.
    const outcome = await bounded.signInWithPassword({
      email: designer().email,
      password: PASSWORD,
      context: from('203.0.113.202'),
    });
    expect(outcome).toEqual({ status: 'authenticated', userId: designer().id });
  });

  /**
   * (f) The refusal is the control; the row is a trace of it, and the trace must not be able
   * to take the control down with it.
   *
   * `record()` is awaited before the rejection is thrown, so before this was fixed a database
   * that could not take the row threw *that* error instead — and the caller got a 500 where a
   * 429 was owed. Two things are wrong with that: the 500 costs more than the refusal it
   * replaces, on the one path in this file that exists to be cheap; and it is a different
   * answer from the one every other refused caller receives, which is the disclosure the rest
   * of this design spends its effort avoiding.
   *
   * The seam is a repository whose one method rejects. Nothing else is stubbed, and nothing
   * else is called: the abuse control refuses in front of the lookup, so `record()` is the
   * only repository call this path makes. The source budget is spent on the **control**
   * directly rather than through a sign-in, because a service holding a broken log cannot
   * complete an admitted attempt either — this way the very first call the service makes is
   * the refused one.
   *
   * The case also pins **what the line says**, which nothing asserted before (N-5's own fix was
   * left uncovered, so deleting the counter and the correlation id kept every suite green).
   * Two refusals are driven through the *same* service instance, from two addresses, because
   * the counter is per process and the whole point of it is that the second line does not read
   * like the first: `loss 2`, and the correlation id of the attempt that lost *that* row.
   */
  it('still refuses when the row recording the refusal cannot be written', async () => {
    const SOURCE = '198.51.100.12';
    // A second address, because `recordRefusal` is reached once per key per window: the same
    // source key refusing again writes no row and so loses none.
    const OTHER_SOURCE = '198.51.100.14';
    const ACCOUNT = 'unknown-to-anyone@northstar.example';

    const control = createSignInAbuseControl({
      windowMs: ABUSE_WINDOW_MS,
      maxPerSource: 1,
      // Never the narrowest bound here: the source key is the one that must refuse, so the
      // reason below names it and the case cannot pass on a different refusal.
      maxPerSourceAccount: 100,
      maxGlobal: 10_000,
      now: () => clockMs,
    });
    expect(control.admit({ ip: SOURCE, account: ACCOUNT }).admitted).toBe(true);
    expect(control.admit({ ip: OTHER_SOURCE, account: ACCOUNT }).admitted).toBe(true);

    const brokenLog = {
      recordAuthenticationEvent: () =>
        Promise.reject(new Error('the authentication log is unavailable')),
    } as unknown as CredentialsRepository;

    const withBrokenLog = new AuthenticationService(
      tenant,
      { ...OPTIONS, abuseControl: control },
      brokenLog,
      () => clockMs,
    );

    // The loss is reported rather than swallowed in silence. Asserting on it also keeps the
    // suite's output clean, which a bare `console.error` in a passing test would not.
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const first = from(SOURCE);
      const refused = await refusal(
        withBrokenLog.signInWithPassword({
          email: ACCOUNT,
          password: PASSWORD,
          context: first,
        }),
      );
      expect(refused.rejection).toBe('rate_limited');
      expect(refused.reason).toBe('source_throttled');
      expect(reported).toHaveBeenCalledTimes(1);
      const firstLine = String(reported.mock.calls[0]?.[0]);
      expect(firstLine).toContain('password_sign_in');
      expect(firstLine).toContain('loss 1');
      expect(firstLine).toContain(first.correlationId);

      // A second refusal through the same service, from the other address. A reader of the
      // process log has to be able to tell this line from the one above it — a log that has
      // been failing for an hour is otherwise indistinguishable from a single blip, and the
      // enumeration trace `migrations/0004_credentials.sql` asks for is quietly missing.
      const second = from(OTHER_SOURCE);
      const refusedAgain = await refusal(
        withBrokenLog.signInWithPassword({
          email: ACCOUNT,
          password: PASSWORD,
          context: second,
        }),
      );
      expect(refusedAgain.reason).toBe('source_throttled');
      expect(reported).toHaveBeenCalledTimes(2);
      const secondLine = String(reported.mock.calls[1]?.[0]);
      expect(secondLine).toContain('loss 2');
      expect(secondLine).toContain(second.correlationId);
      // The counter is the running one, not the attempt's own: the second line does not carry
      // the first attempt's id, and the first line never claimed to be the second loss.
      expect(secondLine).not.toContain(first.correlationId);
      expect(firstLine).not.toContain('loss 2');
    } finally {
      reported.mockRestore();
    }

    // And nothing reached the log, which is the premise of the case rather than its point.
    expect(await events()).toHaveLength(0);
  });

  /**
   * (g) N-2 (re-review of 2026-09-07). A throttle refusal is not a credential failure, and it
   * must not move the user it names towards the durable lockout.
   *
   * `confirmReauthentication` is the one route whose refusal row carries a real `user_id` — the
   * session guard has already established who is calling. Two of the three budgets that can
   * produce that refusal are spent by *everybody*: the per-source key by anyone sharing the
   * address, the global key by anyone at all. The row itself, though, is always written by the
   * named user's own re-authentication being refused — a third party supplies the refusal, not
   * the row, by keeping a shared budget spent. While `countRecentFailures` counted those rows,
   * five of the user's own re-authentications inside the 900-second lockout window — three
   * source windows fit, and a concurrent global refusal adds more — locked that user out of
   * their own account on traffic that was never theirs.
   *
   * The fix is one predicate in the query, so the row keeps doing the job it was written for.
   * This case pins both halves: the trace survives and still names the user, and the counter
   * stops reading it — while a genuine wrong password still counts exactly as it did.
   */
  it('does not let a throttle refusal move a named user towards the durable lockout', async () => {
    await giveOwnerAPassword();

    const SOURCE = '198.51.100.13';
    const control = createSignInAbuseControl({
      windowMs: ABUSE_WINDOW_MS,
      maxPerSource: 1,
      // Never the narrowest bound: the source key — the one a third party spends — must be
      // what refuses, or the case would prove something about the owner's own traffic.
      maxPerSourceAccount: 100,
      maxGlobal: 10_000,
      now: () => clockMs,
    });

    // Somebody else's attempt from the same address spends the source budget. Nothing about it
    // names the owner.
    expect(control.admit({ ip: SOURCE, account: 'someone-else@northstar.example' }).admitted).toBe(
      true,
    );

    const shared = new AuthenticationService(
      tenant,
      { ...OPTIONS, abuseControl: control },
      repository,
      () => clockMs,
    );

    const refused = await refusal(
      shared.confirmReauthentication({
        userId: owner().id,
        sessionId: SESSION,
        password: PASSWORD,
        context: from(SOURCE),
      }),
    );
    expect(refused.rejection).toBe('rate_limited');
    expect(refused.reason).toBe('source_throttled');

    // Half one: the audit trail is intact. The row is written, it names the owner, and it
    // carries the reason an operator needs. The fix must not buy the counter at its expense.
    const named = await events(owner().id);
    expect(named).toHaveLength(1);
    expect(named[0]!['action']).toBe('reauthentication');
    expect(named[0]!['outcome']).toBe('failed');
    expect(named[0]!['reason']).toBe('source_throttled');

    // Four more of the same shape, written through the same repository method the service uses.
    // Three of them are what the shared budgets produce as the 900-second window runs on: the
    // later source windows a colleague keeps spending, and the global key anyone at all can
    // spend. The fourth is `source_account_throttled`, and it is deliberately *not* attributed
    // to that traffic — the `sa:` key names this account, so a third party grinding somebody
    // else cannot cross it, and only the owner's own repeated attempts from this address can.
    // It is here because all three throttle reasons have to be shown not to count, not because
    // a third party could write it.
    // Five is `maxFailuresInWindow`, so this is exactly the lockout the review described.
    await tenant.identityTransaction(identity(), async (tx) => {
      for (const reason of [
        'source_throttled',
        'global_throttled',
        'global_throttled',
        'source_account_throttled',
      ]) {
        await repository.recordAuthenticationEvent(tx, {
          userId: owner().id,
          action: 'reauthentication',
          outcome: 'failed',
          reason,
          ip: SOURCE,
        });
      }
    });
    expect(await events(owner().id)).toHaveLength(5);

    // Half two: not one of them is a credential failure, so not one of them counts.
    const counted = await tenant.identityRead(identity(), (db) =>
      repository.countRecentFailures(db, owner().id, OPTIONS.failureWindowSeconds),
    );
    expect(counted).toBe(0);

    // And the owner, who did none of this, signs in from their own address. Before the fix
    // this was `locked_out` — the third-party lockout N-2 named.
    const outcome = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    expect(outcome).toEqual({ status: 'authenticated', userId: owner().id });

    // The counter still counts what it is for: five genuine wrong passwords, and the durable
    // lockout fires exactly as it always did. Nothing was weakened to close N-2.
    for (let attempt = 0; attempt < OPTIONS.maxFailuresInWindow; attempt += 1) {
      await service
        .signInWithPassword({ email: owner().email, password: 'wrong', context: context() })
        .catch(() => undefined);
    }
    expect(
      await tenant.identityRead(identity(), (db) =>
        repository.countRecentFailures(db, owner().id, OPTIONS.failureWindowSeconds),
      ),
    ).toBe(OPTIONS.maxFailuresInWindow);

    const locked = await refusal(
      service.signInWithPassword({
        email: owner().email,
        password: PASSWORD,
        context: context(),
      }),
    );
    expect(locked.rejection).toBe('rate_limited');
    expect(locked.reason).toBe('locked_out');

    // And the other half of the predicate, which no row this codebase writes reaches: a
    // `failed` row carrying no reason at all. `NOT IN` over a NULL is NULL, so without the
    // explicit `reason IS NULL` clause such a row would silently stop counting — a failure
    // that no longer counts towards a lockout is the direction that fails open. Written
    // through the repository, so it is the production insert that produces it.
    const beforeUnnamed = await countedFailures(owner().id);
    await tenant.identityTransaction(identity(), (tx) =>
      repository.recordAuthenticationEvent(tx, {
        userId: owner().id,
        action: 'password_sign_in',
        outcome: 'failed',
        reason: null,
        ip: SOURCE,
      }),
    );
    expect(await countedFailures(owner().id)).toBe(beforeUnnamed + 1);
  });

  /**
   * (h) A-1 (four-lens review of `7cc9c16`). The row the lockout writes *about itself* is not
   * evidence that anybody guessed a password — and while the counter read it, the lockout
   * renewed itself for as long as anyone kept knocking.
   *
   * When `signInWithPassword` finds the window full it records
   * `outcome: 'failed', reason: 'locked_out'` against the victim's user id and refuses. That
   * row has exactly the shape `7cc9c16` excluded the three throttle reasons for: written in front
   * of the password check, carrying the victim's id, nothing guessed. It was not excluded, so
   * every refusal pushed a fresh counted row into the very window the refusal was derived
   * from. At the shipped defaults — five failures in 900 s, ten requests per 300 s on the
   * account key — about two attempts every five minutes hold the count at five for ever: a
   * third party who knows the address keeps the account shut indefinitely, and the victim's own
   * retries do it to themselves, which is the opposite of what the lockout case above tells
   * them ("a person being told to wait needs to know that waiting is the fix").
   *
   * The fix keeps the trace and cuts the feedback: the row is still written, still names the
   * user, still carries `locked_out`, and `countRecentFailures` no longer reads it. The
   * invariant is that **a row the counter itself caused is never an input to it** — the count
   * is of credentials presented and refused, and the lockout row is a consequence of the count.
   *
   * The window here is eight seconds rather than the configured 900 because this is the one case
   * in the file that must watch a window actually *end*, and the clock that decides it is the
   * database's `now(3)`, which no injected clock can move.
   */
  it('does not let its own lockout row renew the lockout, so the window ends', async () => {
    await giveOwnerAPassword();

    const WINDOW_SECONDS = 8;
    const briefWindow = new AuthenticationService(
      tenant,
      { ...OPTIONS, failureWindowSeconds: WINDOW_SECONDS },
      repository,
      () => clockMs,
    );

    // Five genuine wrong passwords. This is the lockout working as designed.
    for (let attempt = 0; attempt < OPTIONS.maxFailuresInWindow; attempt += 1) {
      await briefWindow
        .signInWithPassword({ email: owner().email, password: 'wrong', context: context() })
        .catch(() => undefined);
    }
    const lockedAt = Date.now();
    expect(await countedFailures(owner().id, WINDOW_SECONDS)).toBe(OPTIONS.maxFailuresInWindow);

    // The attempts that used to renew it, made partway into the window and well inside every
    // budget the abuse control keeps — nothing here is throttled, and none of it reaches a
    // password. Five of them, so that on the pre-fix counter they are a fresh full lockout of
    // their own once the original five age out.
    await sleepUntil(lockedAt + 2_000);
    for (let attempt = 0; attempt < OPTIONS.maxFailuresInWindow; attempt += 1) {
      const refused = await refusal(
        briefWindow.signInWithPassword({
          email: owner().email,
          password: 'wrong',
          context: context(),
        }),
      );
      expect(refused.rejection).toBe('rate_limited');
      expect(refused.reason).toBe('locked_out');
    }

    // Half one: the audit trail still records every refusal, naming the user and the reason —
    // ten rows, five of them `locked_out` — and the count does not grow by one of them.
    const rows = await events(owner().id);
    expect(rows).toHaveLength(2 * OPTIONS.maxFailuresInWindow);
    expect(reasons(rows, 'locked_out')).toHaveLength(OPTIONS.maxFailuresInWindow);
    expect(await countedFailures(owner().id, WINDOW_SECONDS)).toBe(OPTIONS.maxFailuresInWindow);

    // Half two: the window ends, which is the whole promise of a lockout that is not a ban. The
    // five credential failures are outside it now; the five `locked_out` rows, written two
    // seconds later, are still well inside it — on the pre-fix counter the account stays shut.
    await sleepUntil(lockedAt + (WINDOW_SECONDS + 1) * 1_000);
    expect(await countedFailures(owner().id, WINDOW_SECONDS)).toBe(0);

    const outcome = await briefWindow.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    expect(outcome).toEqual({ status: 'authenticated', userId: owner().id });
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
      sessionId: SESSION,
      accountName: owner().email,
      label: 'Half-finished',
      reauthToken: proofFor(owner().id),
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
      sessionId: SESSION,
      accountName: owner().email,
      label: 'Owner phone',
      reauthToken: proofFor(owner().id),
      context: context(),
    });

    const error = await service
      .confirmTotpFactor({
        // The designer, presenting the owner's factor id and a code they can compute because
        // the enrolment response handed them the secret. `D05`: their own proof is valid, so
        // the refusal below is the ownership answer and not the re-authentication one.
        userId: designer().id,
        sessionId: SESSION,
        factorId: begun.factorId,
        code: codeFor(begun.secret, clockMs),
        reauthToken: proofFor(designer().id),
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

  /**
   * The lockout class, reached through `D05`'s own gate.
   *
   * `requireReauth` writes a `failed` row against the caller's user id every time it refuses,
   * and `countRecentFailures` counted it. Five refusals inside `AUTH_FAILURE_WINDOW_SECONDS`
   * are therefore a full lockout of the account that was refused — and the party who can
   * produce them is not the owner. Somebody holding a stolen session cookie posts five
   * ungated requests at the five gated routes; every one of them is refused for want of
   * proof, and every refusal counts against the person whose cookie it is.
   *
   * What that shuts is precisely the recovery. The lockout is read by `signInWithPassword`
   * *and* by `confirmReauthentication`, so the owner can neither sign in nor mint the proof
   * that would end the intruder's session or rotate what they hold — and the intruder, who
   * needs no proof to keep writing rows, can hold it shut for as long as they like. None of
   * the five routes consults the `D08` bound, so the row-writing itself has no ceiling.
   *
   * None of the four `reauth_*` reasons is a credential guess. `reauth_required` is no token
   * at all; `reauth_expired` is a token this server itself signed, correctly, whose TTL has
   * passed; `reauth_wrong_session` is an authentic token whose claims name another session.
   * The one worth arguing is `reauth_invalid` — a malformed or badly signed token — and it is
   * an attempt to forge an HMAC over `SESSION_SECRET`, not to guess the low-entropy secret
   * this counter was built to protect. A five-in-900-seconds budget is meaningless against
   * the first and decisive against the second. All four are excluded.
   *
   * The relation is `locked_out`'s, reached by a different path: a `reauth_*` refusal is a
   * *consequence* of the counter's own gate, never an input to it. The rows are still
   * written, still name the user, still carry the reason — the evidence of an attempt on a
   * credential-changing route is the reason they exist — and only the counter stops reading
   * them.
   */
  describe('a refused re-authentication does not spend the owner’s lockout', () => {
    /** Not the owner's address. Every attempt below is the intruder's traffic. */
    const intruder = () => ({
      correlationId: uuidv7(),
      ip: '198.51.100.77',
      userAgent: 'a stolen cookie',
    });

    /** What the durable lockout would see right now, read through the production predicate. */
    const countedFailures = () =>
      tenant.identityRead(identity(), (db) =>
        repository.countRecentFailures(db, owner().id, OPTIONS.failureWindowSeconds),
      );

    /** Correctly signed, for this person and this session, and already past its expiry. */
    const expiredProof = () =>
      signReauthToken(
        { userId: owner().id, sessionId: SESSION, expiresAt: new Date(clockMs - 1) },
        SECRET,
      );

    /** The right shape under the wrong key — the only one of the four that is a forgery. */
    const forgedProof = () =>
      signReauthToken(
        { userId: owner().id, sessionId: SESSION, expiresAt: new Date(clockMs + 60_000) },
        'not the session secret',
      );

    it('keeps the rows, stops counting them, and still locks out a real bad password', async () => {
      await giveOwnerAPassword();

      // One entry per gated route, twice over for three of them, so that all five routes and
      // all four causes are represented. The gate is the first statement in four of the five
      // and runs before any id is read, so a factor need not exist for the two that name one.
      const attempts: readonly (() => Promise<unknown>)[] = [
        // POST /v1/auth/password/set — take the account outright. No proof offered at all.
        () =>
          service.setPassword({
            userId: owner().id,
            sessionId: SESSION,
            password: 'a line the owner never wrote',
            context: intruder(),
          }),
        () =>
          service.setPassword({
            userId: owner().id,
            sessionId: SESSION,
            password: 'a line the owner never wrote',
            reauthToken: expiredProof(),
            context: intruder(),
          }),
        // POST /v1/auth/factors/totp — add a second factor of the intruder's own.
        () =>
          service.beginTotpEnrolment({
            userId: owner().id,
            sessionId: SESSION,
            accountName: owner().email,
            label: 'a phone the owner has never held',
            context: intruder(),
          }),
        () =>
          service.beginTotpEnrolment({
            userId: owner().id,
            sessionId: SESSION,
            accountName: owner().email,
            label: 'a phone the owner has never held',
            reauthToken: forgedProof(),
            context: intruder(),
          }),
        // POST /v1/auth/factors/totp/confirm — proof for a session they hold, not this one.
        () =>
          service.confirmTotpFactor({
            userId: owner().id,
            sessionId: SESSION,
            factorId: uuidv7(),
            code: '000000',
            reauthToken: proofFor(owner().id, '0198f0aa-0000-7000-8000-00000000cccc'),
            context: intruder(),
          }),
        // DELETE /v1/auth/factors/:factorId — strip the owner's second factor.
        () =>
          service.disableFactor({
            userId: owner().id,
            sessionId: SESSION,
            factorId: uuidv7(),
            context: intruder(),
          }),
        // POST /v1/auth/recovery-codes — reissue, and read, a printable set.
        () =>
          service.regenerateRecoveryCodes({
            userId: owner().id,
            sessionId: SESSION,
            reauthToken: forgedProof(),
            context: intruder(),
          }),
        () =>
          service.regenerateRecoveryCodes({
            userId: owner().id,
            sessionId: SESSION,
            reauthToken: expiredProof(),
            context: intruder(),
          }),
      ];

      // Comfortably above the threshold: eight refusals where five is a lockout.
      expect(attempts.length).toBeGreaterThan(OPTIONS.maxFailuresInWindow);
      for (const attempt of attempts) {
        await reject(attempt());
      }

      // Half one: the evidence survives whole. Eight `failed` rows, every one naming the
      // owner, spread across the four gate reasons and the four actions the five routes
      // write under. The counter must not be bought at the audit trail's expense.
      const rows = await events(owner().id);
      expect(rows).toHaveLength(attempts.length);
      expect(rows.map((row) => row['outcome'])).toEqual(attempts.map(() => 'failed'));
      expect(new Set(rows.map((row) => row['reason']))).toEqual(
        new Set(['reauth_required', 'reauth_expired', 'reauth_invalid', 'reauth_wrong_session']),
      );
      expect(new Set(rows.map((row) => row['action']))).toEqual(
        new Set([
          'password_set',
          'mfa_factor_enrolled',
          'mfa_factor_disabled',
          'recovery_codes_issued',
        ]),
      );

      // Half two: not one of them is a credential presented and refused, so not one counts.
      expect(await countedFailures()).toBe(0);

      // The consequence that made this a denial of service rather than noise in the log. The
      // owner, who did none of the above, signs in.
      expect(
        await service.signInWithPassword({
          email: owner().email,
          password: PASSWORD,
          context: context(),
        }),
      ).toEqual({ status: 'authenticated', userId: owner().id });

      // And re-authenticates — the route that mints the proof to end the intruder's session
      // and rotate what they hold. Closing this one was the whole of the attack.
      const minted = await service.confirmReauthentication({
        userId: owner().id,
        sessionId: SESSION,
        password: PASSWORD,
        context: context(),
      });
      const reissued = await service.regenerateRecoveryCodes({
        userId: owner().id,
        sessionId: SESSION,
        reauthToken: minted.reauthToken,
        context: context(),
      });
      expect(reissued.recoveryCodes).toHaveLength(10);

      // Nothing was weakened to get there. Five genuine wrong passwords still count, and the
      // durable lockout fires exactly as it always did.
      for (let attempt = 0; attempt < OPTIONS.maxFailuresInWindow; attempt += 1) {
        await service
          .signInWithPassword({ email: owner().email, password: 'wrong', context: context() })
          .catch(() => undefined);
      }
      expect(await countedFailures()).toBe(OPTIONS.maxFailuresInWindow);

      const locked = await service
        .signInWithPassword({ email: owner().email, password: PASSWORD, context: context() })
        .catch((thrown: unknown) => thrown);
      expect(locked).toBeInstanceOf(AuthenticationRejectedError);
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
 * `D09`, task 4. What the log row is allowed to be, against the columns it actually has.
 *
 * `authentication_events.ip` is `VARCHAR(45)` and `user_agent` is `VARCHAR(255)`
 * (`migrations/0004_credentials.sql`), and both values come from request headers. Since
 * D09 tasks 1–3 the API believes a forwarded address where — and only where — the operator
 * named a trusted proxy, and behind such a proxy `request.ip` is the last forwarded entry
 * *verbatim*: `@fastify/proxy-addr` never validates that final element, so its length is the
 * client's to choose. `User-Agent` has always been unbounded.
 *
 * Under strict mode an over-long value is `ER_DATA_TOO_LONG`, and this insert sits on the
 * **failure** path of sign-in. So the row that a long forged header destroys is the row that
 * is the only trace of the sweep that sent it — and the caller sees a 500 instead of the
 * refusal it earned. The fix is a clamp at the insert rather than a rejection, for exactly
 * that reason: a truncated trace is worth more than no trace.
 *
 * These cases go through the real repository against the real server, because what is being
 * proved is what the *engine* accepts. `clampToColumnCharacters` has its own unit cases in
 * `src/modules/identity/credentials.repository.test.ts` for the string shapes.
 */
describe('D09 — the log row is clamped to the columns that hold it', () => {
  /** One row, written by the production insert, then read back unguarded. */
  async function record(input: { ip: string | null; userAgent: string | null }) {
    await tenant.identityTransaction(identity(), (tx) =>
      repository.recordAuthenticationEvent(tx, {
        userId: owner().id,
        action: 'password_sign_in',
        outcome: 'failed',
        reason: 'bad_password',
        ip: input.ip,
        userAgent: input.userAgent,
      }),
    );
    const rows = await events(owner().id);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it('stores the leading 45 characters of a forged address, and does not throw', async () => {
    const row = await record({ ip: 'a'.repeat(300), userAgent: 'vitest' });

    expect(row['ip']).toBe('a'.repeat(45));
    expect(String(row['ip'])).toHaveLength(45);
    // The row survived, which is the whole point: this is the enumeration trace.
    expect(row['reason']).toBe('bad_password');
    expect(row['user_agent']).toBe('vitest');
  });

  it('stores the leading 255 characters of an unbounded user agent', async () => {
    const row = await record({ ip: '203.0.113.9', userAgent: 'b'.repeat(1000) });

    expect(row['user_agent']).toBe('b'.repeat(255));
    expect(String(row['user_agent'])).toHaveLength(255);
    expect(row['ip']).toBe('203.0.113.9');
  });

  /**
   * The widest address the column was sized for: an IPv6 literal with an embedded IPv4
   * suffix. Forty-five characters exactly, so it is the case a clamp off by one would break.
   */
  it('round-trips a full-width IPv6-with-IPv4 address unchanged', async () => {
    const address = '0000:0000:0000:0000:0000:ffff:255.255.255.255';
    expect(address).toHaveLength(45);

    const row = await record({ ip: address, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });

    expect(row['ip']).toBe(address);
    expect(row['user_agent']).toBe('Mozilla/5.0 (X11; Linux x86_64)');
  });

  it('keeps an explicitly null address and agent as NULL', async () => {
    const row = await record({ ip: null, userAgent: null });

    expect(row['ip']).toBeNull();
    expect(row['user_agent']).toBeNull();
  });

  /** The other spelling of absence: the caller passes neither field at all. */
  it('keeps an omitted address and agent as NULL', async () => {
    await tenant.identityTransaction(identity(), (tx) =>
      repository.recordAuthenticationEvent(tx, {
        userId: owner().id,
        action: 'password_sign_in',
        outcome: 'failed',
        reason: 'bad_password',
      }),
    );
    const rows = await events(owner().id);

    expect(rows).toHaveLength(1);
    expect(rows[0]!['ip']).toBeNull();
    expect(rows[0]!['user_agent']).toBeNull();
  });

  /**
   * The engine's own opinion of what a "character" is, which is the reason the clamp counts
   * code points rather than UTF-16 units. Three hundred astral-plane characters are 600
   * UTF-16 units; clamped to 255 *characters* they are 1020 bytes in a `VARCHAR(255)` that
   * the server accepts, and reading the row back yields exactly 255 of them. A UTF-16 slice
   * would have written 255 units — 127 whole characters and half of a 128th — and stored
   * something the request never sent. The case below this one shows exactly what.
   */
  it('measures the bound the way the utf8mb4 column measures it', async () => {
    const agent = '😀'.repeat(300);
    expect(agent).toHaveLength(600);

    const row = await record({ ip: '中'.repeat(60), userAgent: agent });

    expect(row['user_agent']).toBe('😀'.repeat(255));
    expect(Array.from(String(row['user_agent']))).toHaveLength(255);
    expect(row['ip']).toBe('中'.repeat(45));
    expect(Array.from(String(row['ip']))).toHaveLength(45);
  });

  /**
   * What a UTF-16 slice would actually have cost, demonstrated against the real driver and
   * the real server rather than argued in a comment.
   *
   * The input here is not what the clamp produces — it is what `slice(0, 45)` produces from
   * the same source string: two ASCII characters, 21 whole emoji, and then a lone high
   * surrogate where the 22nd was cut in half. It is 45 UTF-16 units and short enough that
   * `clampToColumnCharacters` returns it untouched, so what this case exercises is purely the
   * path from a JavaScript string to a `utf8mb4` column.
   *
   * Nothing raises. mysql2 maps `utf8mb4` to Node's `'utf8'` encoding and encodes parameters
   * with `Buffer.from`, which substitutes U+FFFD for an unpaired surrogate before any byte
   * reaches the socket, so the server is handed valid text and stores it. The row that comes
   * back is therefore both wrong and short: a replacement character the client never sent
   * standing in for the character the slice destroyed, and 24 characters in a column the
   * slice was aiming to fill to 45. That silent rewrite is what the code-point clamp exists
   * to avoid — not an `Incorrect string value` this stack never produces.
   */
  it('would have stored U+FFFD for a character a UTF-16 slice cut in half', async () => {
    const source = `ab${'😀'.repeat(60)}`;
    const sliced = source.slice(0, 45);
    expect(sliced).toBe(`ab${'😀'.repeat(21)}\uD83D`);
    expect(sliced).toHaveLength(45);

    const row = await record({ ip: sliced, userAgent: 'vitest' });

    // The insert succeeded, and the boundary character came back as the replacement one.
    expect(row['ip']).toBe(`ab${'😀'.repeat(21)}�`);
    expect(Array.from(String(row['ip']))).toHaveLength(24);
    // Nothing unpaired survived the trip — a plain substring search would not show this,
    // because `\uD83D` is also the leading unit of every whole `😀` still in the value.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(String(row['ip']))).toBe(false);
    // The row itself is intact, so nothing about this is an insert failure.
    expect(row['reason']).toBe('bad_password');
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
 * environment, and the cases below are the five things that has to mean in a real database
 * rather than in a unit test: the column no longer holds the seed; editing it breaks it;
 * moving it between rows breaks it; a row nobody has swept yet refuses rather than works;
 * and refusing a sign-in is *all* it refuses — the screens that list and remove a factor
 * never open the envelope, so they still work on the row that will not open. Cases (g) and
 * (h) add the sixth: a broken row costs its owner that factor and no more, unless it is the
 * only one they have, in which case the door stays shut.
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
      sessionId: SESSION,
      accountName: user.email,
      label,
      reauthToken: proofFor(user.id),
      context: context(),
    });
    await service.confirmTotpFactor({
      userId: user.id,
      sessionId: SESSION,
      factorId: begun.factorId,
      code: codeFor(begun.secret, clockMs),
      reauthToken: proofFor(user.id),
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
      sessionId: SESSION,
      accountName: owner().email,
      label: 'Test phone',
      reauthToken: proofFor(owner().id),
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

  /**
   * (f) The other half of (e): the row refuses a *sign-in*, and refuses nothing else.
   *
   * The security screen shows labels, not seeds, and the "remove this factor" route needs
   * only to know who owns the row. If either of them opened the envelope, an unopenable row
   * would take down the two screens a person would use to get out of the situation — and
   * every row in the window between deploying D07 and running the backfill is unopenable.
   * So neither reads `secret`, and this case is what says so from outside.
   */
  it('still lists and still removes a row the cipher cannot open', async () => {
    await givePassword(owner().id);
    const factorId = uuidv7();
    await db.admin.query(
      `insert into user_mfa_factors (id, user_id, kind, label, secret, confirmed_at, created_at)
       values (?, ?, 'totp', 'Legacy phone', ?, current_timestamp(3), current_timestamp(3))`,
      [factorId, owner().id, LEGACY_SEED],
    );

    const factors = await service.listFactors({ userId: owner().id, correlationId: uuidv7() });
    expect(factors.map((factor) => factor.label)).toEqual(['Legacy phone']);
    // Not merely "no seed in the field": no such field, on any row the screen returns.
    expect(factors.every((factor) => !('secret' in factor))).toBe(true);
    expect(JSON.stringify(factors)).not.toContain(LEGACY_SEED);

    expect(
      await service.disableFactor({
        userId: owner().id,
        sessionId: SESSION,
        factorId,
        reauthToken: proofFor(owner().id),
        context: context(),
      }),
    ).toBe(true);

    // Gone from the screen, and the sign-in it was blocking is offered again.
    expect(await service.listFactors({ userId: owner().id, correlationId: uuidv7() })).toHaveLength(
      0,
    );
    const outcome = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    expect(outcome.status).toBe('authenticated');
  });

  /**
   * (g) One broken row is not everybody's problem — D07 review, issue 2.
   *
   * Somebody with a phone and a tablet, whose tablet row was left behind by a backfill or
   * altered in the column, used to be refused outright: the listing opened every row eagerly
   * and the first refusal propagated. The rows that open are now collected instead, so the
   * phone still signs them in and the tablet is simply not among the factors offered.
   */
  it('signs in on the working factor when another of the person’s rows will not open', async () => {
    await givePassword(owner().id);
    const phone = await enrolTotpFor(owner(), 'Phone');
    const tablet = await enrolTotpFor(owner(), 'Tablet');

    await setRawSecret(tablet.factorId, tamper(await rawSecret(tablet.factorId)));

    clockMs += 30_000;
    const challenge = await service.signInWithPassword({
      email: owner().email,
      password: PASSWORD,
      context: context(),
    });
    // Still asked for a code: the broken row did not quietly turn MFA off either.
    if (challenge.status !== 'mfa_required') throw new Error('expected a challenge');
    const completed = await service.completeMfaChallenge({
      challengeToken: challenge.challengeToken,
      code: codeFor(phone.secret, clockMs),
      context: context(),
    });
    expect(completed).toEqual({ status: 'authenticated', userId: owner().id });
  });

  /**
   * (h) The other side of (g), and the reason it is a partition rather than a skip: with no
   * row left that opens, the refusal stands. Returning "no factors" here would let anyone
   * able to write one column reduce an account to password-only, which is the bypass the
   * lockout was protecting against.
   */
  it('refuses the sign-in when none of the person’s rows will open', async () => {
    await givePassword(owner().id);
    const phone = await enrolTotpFor(owner(), 'Phone');
    const tablet = await enrolTotpFor(owner(), 'Tablet');

    await setRawSecret(phone.factorId, tamper(await rawSecret(phone.factorId)));
    await setRawSecret(tablet.factorId, tamper(await rawSecret(tablet.factorId)));

    clockMs += 30_000;
    const error = await refusal(
      service.signInWithPassword({
        email: owner().email,
        password: PASSWORD,
        context: context(),
      }),
    );
    expect(error.reason).toBe('authentication_failed');
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
