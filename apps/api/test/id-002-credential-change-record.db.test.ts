import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { parseSeedKeys } from '@tmanage/config';
import type { RowDataPacket } from 'mysql2/promise';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import {
  AuthenticationService,
  CREDENTIAL_CHANGE_ACTIONS,
} from '../src/modules/identity/authentication.service.js';
import type { AuthenticationOptions } from '../src/modules/identity/authentication.service.js';
import { CredentialsRepository } from '../src/modules/identity/credentials.repository.js';
import { createSignInAbuseControl } from '../src/modules/identity/sign-in-abuse-control.js';
import { createSeedCipher } from '../src/modules/identity/seed-cipher.js';
import { signReauthToken } from '../src/modules/identity/reauth-token.js';
import { hashPassword } from '../src/modules/identity/password.js';
import { base32Decode, hotpCode, totpCounterAt } from '../src/modules/identity/totp.js';
import type { IdentityQueryRunner } from '../src/common/database/tenant-context.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * D05d — the durable record of a credential change, against a real server.
 *
 * `id-002-credentials.db.test.ts` proves what each credential route *does*. This file proves
 * the one thing that lets the account owner ever find out it was done, and it is deliberately
 * a separate file rather than four more cases in that one: the claims here are about the
 * transaction boundary and about a read path, and the fault-injection case needs a repository
 * subclass that suite has no other use for.
 *
 * Four claims:
 *
 * 1. **Every credential-changing route leaves a row.** Setting a password, confirming a
 *    factor, removing one, regenerating recovery codes.
 * 2. **Confirming a factor records the recovery codes it replaced**, not only the enrolment.
 *    That is the `D05c` route: an attacker with a live session destroys the owner's codes
 *    through `/factors/totp/confirm`, and a log that recorded only `mfa_factor_enrolled`
 *    would answer "when were my recovery codes last replaced" with the wrong moment or with
 *    nothing at all.
 * 3. **The row and the change share one transaction.** Proved by injection rather than by
 *    inspection: a repository whose `recordAuthenticationEvent` writes its row and then
 *    throws must leave *neither* the row nor the credential change behind. A record written
 *    in a transaction of its own — which is exactly what the refusal path's `record()` does,
 *    correctly, for a failure that has no change to join — would survive this and the
 *    password would too.
 * 4. **The read returns credential changes and nothing else.** No sign-in, no challenge, no
 *    re-authentication row, and never the `reason` column that migration 0004 says is
 *    "recorded here and NEVER returned to the caller".
 * 5. **Every credential change also queues the notice that tells its owner**, on
 *    `credential_change_notices` (`0020`), from the same transaction — undelivered,
 *    immediately deliverable, and carrying no address, no agent and no secret.
 * 6. **A refused change queues nothing.** The refusal still leaves its row, because a
 *    failure has no change to roll back with; it must not put mail in anyone's inbox,
 *    or a caller who can make a route refuse can send the owner as much of it as they like.
 *
 * NOT EXECUTED as of 2026-09-12: the shared database lock was held by a long verification for
 * the whole of this session, so these cases were written and typechecked but never run. They
 * are recorded as unexecuted in `x10-report.md` and in the status entry.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let service: AuthenticationService;
let clockMs: number;

const SECRET_KEY = 'local_dev_only_session_secret_for_the_credential_change_record_suite';

/** Obviously fake: a byte repeated thirty-two times. Nothing here is a real key. */
const seedCipher = createSeedCipher(
  parseSeedKeys(`1:${Buffer.alloc(32, 0x11).toString('base64url')}`),
);

const repository = new CredentialsRepository(seedCipher);

const OPTIONS: AuthenticationOptions = {
  sessionSecret: SECRET_KEY,
  maxFailuresInWindow: 5,
  failureWindowSeconds: 900,
  totpIssuer: 'TManage',
  // Far above anything this file spends, for the reason `id-002-credentials.db.test.ts`
  // gives at length: the control is built once, the clock is reset to a fixed instant per
  // case, and a fixed window therefore reads the whole file as one window.
  abuseControl: createSignInAbuseControl({
    windowMs: 300_000,
    maxPerSource: 1_000,
    maxPerSourceAccount: 1_000,
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

const owner = () => world.northstar.owner;

const PASSWORD = 'a quiet line on paper';
const REPLACEMENT = 'another quiet line on paper';

const SESSION = '0198f0bb-0000-7000-8000-00000000aaaa';

function proofFor(userId: string, sessionId = SESSION): string {
  return signReauthToken({ userId, sessionId, expiresAt: new Date(clockMs + 60_000) }, SECRET_KEY);
}

function codeFor(secret: string, atMs: number): string {
  return hotpCode(base32Decode(secret)!, totpCounterAt(atMs, 30), {
    digits: 6,
    algorithm: 'SHA1',
  });
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

/** Every row for this person, oldest first, straight from the table. */
async function events(userId: string): Promise<RowDataPacket[]> {
  return observe(
    'select action, outcome, reason, ip, user_agent, correlation_id from authentication_events' +
      ' where user_id = ? order by occurred_at, id',
    [userId],
  );
}

const actionsOf = (rows: readonly RowDataPacket[]): string[] =>
  rows.map((row) => String(row['action']));

/** Every queued notice for this person, oldest first, straight from the table. */
async function notices(userId: string): Promise<RowDataPacket[]> {
  return observe(
    'select id, user_id, action, correlation_id, occurred_at, available_at, published_at,' +
      ' attempts, last_error from credential_change_notices where user_id = ?' +
      ' order by occurred_at, id',
    [userId],
  );
}

async function giveOwnerAPassword(password = PASSWORD): Promise<void> {
  const hash = await hashPassword(password);
  await tenant.identityTransaction(identity(), (tx) =>
    repository.setPassword(tx, owner().id, hash),
  );
}

/** Enrol and confirm a factor, returning its secret. */
async function enrolOwnerTotp(): Promise<{ secret: string; factorId: string }> {
  const begun = await service.beginTotpEnrolment({
    userId: owner().id,
    sessionId: SESSION,
    accountName: owner().email,
    label: 'Test phone',
    reauthToken: proofFor(owner().id),
    context: context(),
  });
  await service.confirmTotpFactor({
    userId: owner().id,
    sessionId: SESSION,
    factorId: begun.factorId,
    code: codeFor(begun.secret, clockMs),
    reauthToken: proofFor(owner().id),
    context: context(),
  });
  return { secret: begun.secret, factorId: begun.factorId };
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  clockMs = Date.UTC(2026, 8, 12, 12, 0, 0);
  service = new AuthenticationService(tenant, OPTIONS, repository, () => clockMs);
});

beforeEach(async () => {
  // TRUNCATE rather than DELETE: `authentication_events` is append-only by trigger, so a
  // DELETE raises SQLSTATE 45000 even for the migrator credential. TRUNCATE is DDL and does
  // not fire row triggers.
  await db.admin.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of [
      'credential_change_notices',
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
  clockMs = Date.UTC(2026, 8, 12, 12, 0, 0);
  // F01 (wave 9): a first password is set only from a session signed in within ten minutes, so
  // every case acts from a live owner session created just now (by the database clock).
  await db.admin.execute(
    `insert into sessions (id, user_id, refresh_token_hash, user_agent, expires_at, created_at)
     values (?, ?, ?, 'vitest', date_add(now(3), interval 1 day), now(3))`,
    [SESSION, owner().id, randomBytes(32).toString('hex')],
  );
});

afterAll(async () => {
  await db?.stop();
});

describe('every credential change leaves a row the owner could be shown', () => {
  it('records a first password, with the address and agent that set it', async () => {
    await service.setPassword({
      userId: owner().id,
      sessionId: SESSION,
      password: PASSWORD,
      context: context(),
    });

    const rows = await events(owner().id);
    expect(actionsOf(rows)).toEqual(['password_set']);
    expect(rows[0]!['outcome']).toBe('succeeded');
    expect(rows[0]!['ip']).toBe('203.0.113.9');
    expect(rows[0]!['user_agent']).toBe('vitest');
    expect(rows[0]!['correlation_id']).not.toBeNull();
  });

  it('records a replaced password', async () => {
    await giveOwnerAPassword();

    await service.setPassword({
      userId: owner().id,
      sessionId: SESSION,
      password: REPLACEMENT,
      reauthToken: proofFor(owner().id),
      context: context(),
    });

    expect(actionsOf(await events(owner().id))).toEqual(['password_set']);
  });

  /**
   * Claim 2, and the reason this file exists. Confirming an enrolment calls
   * `replaceRecoveryCodes` — the owner's written-down codes stop working at that instant —
   * so the log must carry `recovery_codes_issued` as well as the enrolment.
   */
  it('records the recovery codes a confirmed enrolment silently replaced', async () => {
    await giveOwnerAPassword();

    await enrolOwnerTotp();

    const actions = actionsOf(await events(owner().id));
    expect(actions).toContain('mfa_factor_enrolled');
    expect(actions).toContain('recovery_codes_issued');
    // Both from the one confirmation, and the enrolment is recorded first.
    expect(actions.indexOf('mfa_factor_enrolled')).toBeLessThan(
      actions.indexOf('recovery_codes_issued'),
    );
  });

  it('records a regenerated set of recovery codes', async () => {
    await giveOwnerAPassword();
    await enrolOwnerTotp();
    const before = (await events(owner().id)).length;

    await service.regenerateRecoveryCodes({
      userId: owner().id,
      sessionId: SESSION,
      reauthToken: proofFor(owner().id),
      context: context(),
    });

    const rows = await events(owner().id);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)!['action']).toBe('recovery_codes_issued');
  });

  it('records the removal of a second factor', async () => {
    await giveOwnerAPassword();
    const { factorId } = await enrolOwnerTotp();

    await service.disableFactor({
      userId: owner().id,
      sessionId: SESSION,
      factorId,
      reauthToken: proofFor(owner().id),
      context: context(),
    });

    expect(actionsOf(await events(owner().id)).at(-1)).toBe('mfa_factor_disabled');
  });

  /**
   * A begun enrolment writes an unconfirmed factor, which authorises nothing. Deliberately
   * not a credential change; asserted so the omission stays a decision.
   */
  it('records nothing for an enrolment that was only begun', async () => {
    await giveOwnerAPassword();

    await service.beginTotpEnrolment({
      userId: owner().id,
      sessionId: SESSION,
      accountName: owner().email,
      label: 'Test phone',
      reauthToken: proofFor(owner().id),
      context: context(),
    });

    expect(await events(owner().id)).toEqual([]);
  });
});

describe('every credential change also queues the notice that tells its owner', () => {
  /**
   * Claim 5. The record answers a person who already suspects something; the notice reaches
   * the one who does not. `credential_change_notices` is the queue it leaves through — the
   * transactional outbox with the tenant column removed, because a credential belongs to no
   * organization and the identity path may not touch a tenant table at all
   * (`0020_credential_change_notices.sql`).
   *
   * Both routes that replace recovery codes are checked, because `confirmTotpFactor` is the
   * one `D05c` found an attacker can reach and it is the one where a missing notice costs
   * most: an owner whose codes were destroyed through it learned, before this, when their
   * own copies stopped working.
   */
  it('queues one notice per change, for the person whose credential it was', async () => {
    await service.setPassword({
      userId: owner().id,
      sessionId: SESSION,
      password: PASSWORD,
      context: context(),
    });
    clockMs += 60_000;
    await enrolOwnerTotp();
    clockMs += 60_000;
    await service.regenerateRecoveryCodes({
      userId: owner().id,
      sessionId: SESSION,
      reauthToken: proofFor(owner().id),
      context: context(),
    });

    const queued = await notices(owner().id);
    expect(actionsOf(queued)).toEqual([
      'password_set',
      'mfa_factor_enrolled',
      'recovery_codes_issued',
      'recovery_codes_issued',
    ]);
    // The log and the queue saw the same four changes. Neither is ahead of the other.
    expect(actionsOf(await events(owner().id))).toEqual(actionsOf(queued));
    for (const row of queued) expect(row['user_id']).toBe(owner().id);
  });

  /**
   * What the relay will find: nothing delivered, nothing deferred, nothing tried. The
   * `available_at = occurred_at` equality is `outbox_events`' rule — deliverable at once, and
   * only a retry backoff ever moves it later.
   */
  it('queues it undelivered, immediately deliverable, and never attempted', async () => {
    // Bound here and passed as a parameter — never `current_timestamp` from this admin
    // connection, whose clock is the system's and has produced false results in this suite
    // before. This is the window the row must have been stamped inside.
    const before = new Date(Date.now() - 60_000);

    await service.setPassword({
      userId: owner().id,
      sessionId: SESSION,
      password: PASSWORD,
      context: context(),
    });

    const [queued] = await notices(owner().id);
    expect(queued).toBeDefined();
    expect(queued!['published_at']).toBeNull();
    expect(queued!['attempts']).toBe(0);
    expect(queued!['last_error']).toBeNull();
    expect(new Date(String(queued!['available_at'])).getTime()).toBe(
      new Date(String(queued!['occurred_at'])).getTime(),
    );

    // The same window, asked of the server with a bound value rather than its own clock.
    const [recent] = await observe(
      'select count(*) as n from credential_change_notices where user_id = ? and occurred_at >= ?',
      [owner().id, before],
    );
    expect(Number(recent!['n'])).toBe(1);
  });

  /**
   * A notice is delivered to the owner's mailbox, and an intruder reading that mailbox must
   * not be handed the addresses and devices the owner signs in from. The log beside it keeps
   * both for an operator; the queue carries the person, what changed, and when.
   */
  it('carries no address, no agent, no reason and no secret', async () => {
    await service.setPassword({
      userId: owner().id,
      sessionId: SESSION,
      password: PASSWORD,
      context: context(),
    });

    const [row] = await observe('select * from credential_change_notices limit 1');
    expect(row).toBeDefined();
    expect(Object.keys(row!).sort()).toEqual([
      'action',
      'attempts',
      'available_at',
      'correlation_id',
      'id',
      'last_error',
      'occurred_at',
      'published_at',
      'user_id',
    ]);
  });

  it('queues nothing for an enrolment that was only begun', async () => {
    await giveOwnerAPassword();

    await service.beginTotpEnrolment({
      userId: owner().id,
      sessionId: SESSION,
      accountName: owner().email,
      label: 'Test phone',
      reauthToken: proofFor(owner().id),
      context: context(),
    });

    expect(await notices(owner().id)).toEqual([]);
  });

  /**
   * Claim 6. The refusal keeps its row — it has no change to be rolled back with — and puts
   * nothing in the queue. The asymmetry is the whole design: the log is evidence, the queue
   * is mail, and a caller who can make a route refuse must not be able to send any.
   */
  it('queues nothing for a refused change, though the refusal is still recorded', async () => {
    await giveOwnerAPassword();

    await expect(
      service.regenerateRecoveryCodes({
        userId: owner().id,
        sessionId: SESSION,
        reauthToken: undefined,
        context: context(),
      }),
    ).rejects.toThrow();

    const recorded = await events(owner().id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!['outcome']).toBe('failed');
    expect(await notices(owner().id)).toEqual([]);
  });
});

describe('the row and the change commit together or not at all', () => {
  /**
   * Claim 3. A repository whose log write succeeds and then throws stands in for every way a
   * transaction can fail after the record has been issued — a deadlock victim, a lost
   * connection. Both must be gone afterwards.
   *
   * This is the case that would catch the tempting mistake: recording the change the way the
   * refusal path records a refusal, in a transaction of its own. The refusal path is right to
   * do that — a failed attempt has no change to join — and a success path that copied it
   * would leave, here, a `password_set` row and no password. The owner would be told about a
   * change that did not happen, which is a worse lie than silence.
   */
  it('leaves neither the password nor its record nor its notice when the transaction fails after the write', async () => {
    // Overriding `recordCredentialChange` rather than `recordAuthenticationEvent`, so that
    // BOTH rows are genuinely written before the failure: a throw from inside the log write
    // would never reach the notice insert and would prove nothing about it.
    class FailsAfterRecording extends CredentialsRepository {
      override async recordCredentialChange(
        runner: IdentityQueryRunner,
        input: Parameters<CredentialsRepository['recordCredentialChange']>[1],
      ): Promise<void> {
        await super.recordCredentialChange(runner, input);
        throw new Error('injected: the transaction fails after the record was written');
      }
    }

    const brittle = new AuthenticationService(
      tenant,
      OPTIONS,
      new FailsAfterRecording(seedCipher),
      () => clockMs,
    );

    await expect(
      brittle.setPassword({
        userId: owner().id,
        sessionId: SESSION,
        password: PASSWORD,
        context: context(),
      }),
    ).rejects.toThrow('injected');

    expect(
      await observe('select user_id from user_passwords where user_id = ?', [owner().id]),
    ).toEqual([]);
    expect(await events(owner().id)).toEqual([]);
    // The point of the notice sharing the transaction: no mail is queued about a password
    // that is still the old one. A queue written after the commit, or in a transaction of
    // its own, would have a row here.
    expect(await notices(owner().id)).toEqual([]);
  });

  /**
   * The other direction, and the one the refusal path must keep: a *refused* attempt still
   * leaves its row, because it has no change to be rolled back with. The two behaviours look
   * alike in the source and are opposite in effect, so both are asserted.
   */
  it('keeps the row for a refused change, which has no change to roll back with', async () => {
    await giveOwnerAPassword();

    await expect(
      service.regenerateRecoveryCodes({
        userId: owner().id,
        sessionId: SESSION,
        reauthToken: undefined,
        context: context(),
      }),
    ).rejects.toThrow();

    const rows = await events(owner().id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['outcome']).toBe('failed');
    expect(rows[0]!['action']).toBe('recovery_codes_issued');
  });
});

describe('the owner can read their own credential history', () => {
  it('returns the credential changes, newest first', async () => {
    await service.setPassword({
      userId: owner().id,
      sessionId: SESSION,
      password: PASSWORD,
      context: context(),
    });
    clockMs += 60_000;
    await enrolOwnerTotp();

    const changes = await service.listCredentialChanges({
      userId: owner().id,
      correlationId: uuidv7(),
    });

    expect(changes.map((change) => change.action)).toEqual([
      'recovery_codes_issued',
      'mfa_factor_enrolled',
      'password_set',
    ]);
    // Newest first, and every entry carries a time the screen can render.
    for (let i = 1; i < changes.length; i += 1) {
      expect(changes[i - 1]!.occurredAt.getTime()).toBeGreaterThanOrEqual(
        changes[i]!.occurredAt.getTime(),
      );
    }
  });

  /**
   * Claim 4. A wrong password is not a credential change, and its `reason` is the column the
   * migration says is never returned. The read asks for a closed list of actions, so a
   * failure row cannot arrive through it even for the actions that *are* on the list.
   */
  it('returns no sign-in attempt, and no refused change', async () => {
    await giveOwnerAPassword();

    // A wrong password: a `password_sign_in` / `failed` row.
    await expect(
      service.signInWithPassword({
        email: owner().email,
        password: 'not the password',
        context: context(),
      }),
    ).rejects.toThrow();

    // A refused regeneration: a `recovery_codes_issued` / `failed` row — an action that IS on
    // the list, with an outcome that is not.
    await expect(
      service.regenerateRecoveryCodes({
        userId: owner().id,
        sessionId: SESSION,
        reauthToken: undefined,
        context: context(),
      }),
    ).rejects.toThrow();

    const stored = await events(owner().id);
    expect(stored.length).toBeGreaterThanOrEqual(2);

    const changes = await service.listCredentialChanges({
      userId: owner().id,
      correlationId: uuidv7(),
    });
    expect(changes).toEqual([]);
  });

  it('returns no other person’s history', async () => {
    await service.setPassword({
      userId: owner().id,
      sessionId: SESSION,
      password: PASSWORD,
      context: context(),
    });

    const changes = await service.listCredentialChanges({
      userId: world.northstar.designer.id,
      correlationId: uuidv7(),
    });

    expect(changes).toEqual([]);
  });

  /**
   * The shape the owner sees carries no `reason`, no `ip` and no `user_agent`. The first is
   * migration 0004's rule. The other two are a decision recorded in `x10-report.md`: this
   * read is reachable by anybody holding a live session — the very attacker `D05` is about —
   * and the addresses and devices the owner signs in from are not something that attacker
   * should be handed. The date is what raises the alarm; the address is not needed to raise
   * it.
   */
  it('exposes the action and the time, and nothing else', async () => {
    await service.setPassword({
      userId: owner().id,
      sessionId: SESSION,
      password: PASSWORD,
      context: context(),
    });

    const changes = await service.listCredentialChanges({
      userId: owner().id,
      correlationId: uuidv7(),
    });

    expect(changes).toHaveLength(1);
    expect(Object.keys(changes[0]!).sort()).toEqual(['action', 'id', 'occurredAt']);
  });

  it('asks only for the four credential-changing actions', () => {
    expect([...CREDENTIAL_CHANGE_ACTIONS].sort()).toEqual([
      'mfa_factor_disabled',
      'mfa_factor_enrolled',
      'password_set',
      'recovery_codes_issued',
    ]);
  });
});
