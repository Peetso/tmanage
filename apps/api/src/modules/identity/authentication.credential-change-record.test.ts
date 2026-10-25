import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import {
  AUTHENTICATION_ACTIONS,
  AuthenticationService,
  CREDENTIAL_CHANGE_ACTIONS,
  CREDENTIAL_CHANGE_LIMIT,
} from './authentication.service.js';
import {
  CredentialChangeNoticeRequiredError,
  CredentialsRepository,
} from './credentials.repository.js';
import { createSeedCipher } from './seed-cipher.js';
import { createSignInAbuseControl } from './sign-in-abuse-control.js';
import { REAUTH_TTL_SECONDS, signReauthToken } from './reauth-token.js';
import { SessionsRepository } from './sessions.repository.js';
import type { BearerCredentialCutoff } from './bearer-credentials.js';
import { base32Decode, generateTotpSecret, hotpCode, totpCounterAt } from './totp.js';
import type { UserMfaFactorRow, UserPasswordRow } from '../../common/database/schema.js';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * D05d — **the owner is never told that their credentials changed**.
 *
 * The record that would let them find out already exists: `authentication_events`, written by
 * `CredentialsRepository.recordAuthenticationEvent` from inside the same
 * `identityTransaction` as the change it describes. This file is about the two things that
 * were missing from it, and it makes both statements in the only form that is decidable
 * without a server — from *which unit of work* each write was issued on.
 *
 * ## 1. The record shares the change's fate, in both directions
 *
 * A record that can be lost while the change commits is worse than no record at all, because
 * it would be trusted: "nothing happened to my recovery codes" would be a lie the owner acts
 * on. The mirror failure is as bad and easier to write by accident — the refusal path's
 * {@link AuthenticationService.record} opens a transaction *of its own*, correctly, because a
 * failure has no change to join, and a copy-paste of it onto a success path would leave a row
 * claiming a change that rolled back.
 *
 * The fake below is therefore not a pass-through: {@link FakeUnitOfWork} buffers, and
 * {@link FakeIdentityDatabase.identityTransaction} appends the buffer to `committed` only when
 * the callback *and* the commit succeed. So a write issued on the wrong runner — a second
 * transaction, or a read — is not merely visible, it never reaches `committed` at all, and
 * `commitFails` gives us the case no ordering assertion can reach: the change succeeded and
 * the database refused the commit anyway.
 *
 * ## 2. The owner is told, and the notice shares that same fate
 *
 * A record nobody is sent is a record the owner reads only if they already suspect the
 * answer, which is the wrong way round: the person who needs "your recovery codes were
 * replaced on the 12th" is the one who suspects nothing. So the change also queues a notice
 * on `credential_change_notices` — the transactional outbox pattern with the tenant column
 * removed, because a credential belongs to no organization and the identity path may not
 * touch a tenant table at all (`0020_credential_change_notices.sql`).
 *
 * The queue is written by the same repository method that writes the log row, from the same
 * runner, so there is no optional collaborator to omit and no second call to forget. That is
 * deliberate: an outbox held as an optional dependency, silently absent wherever somebody
 * built the service without it, is a shape this repository has already had an incident over.
 *
 * ## 3. Confirming a TOTP factor replaces the recovery codes and must say so
 *
 * `confirmTotpFactor` calls `replaceRecoveryCodes` — it destroys the codes the owner wrote
 * down at enrolment and hands a new set to whoever called — and recorded only
 * `mfa_factor_enrolled`. That is precisely the route `D05c` (2026-09-12) found an attacker
 * could take, so an owner asking the one question that matters, "when were my recovery codes
 * last replaced", would have been answered "never" about the very attack.
 *
 * A fake repository rather than a database, for the reason
 * `authentication.enrolment-reauth.test.ts` gives: what is under test is decidable from which
 * calls are issued, and on which handle. The database suite states the same properties
 * against a real server and real triggers.
 *
 * ## The record and the notice are the *real* repository code — C2
 *
 * The change primitives a route calls (`setPassword`, `confirmFactor`, `replaceRecoveryCodes`,
 * …) are still faked as markers, because the SQL of a password upsert is not what these tests
 * decide. But {@link CredentialsRepository.recordAuthenticationEvent},
 * {@link CredentialsRepository.recordCredentialChange} and the notice insert inside it are
 * **not** overridden here: they run, reach drizzle, and issue their statements through
 * {@link FakeUnitOfWork.query}, which turns each into the `record:`/`notice:` marker the
 * assertions read. So the notice is proved by the production write, not by a re-implementation
 * of it in the fake: delete the `.insert(credentialChangeNotices)` block in
 * `credentials.repository.ts` and no `notice:` marker is ever produced, and the notice cases
 * below fail — which the first draft of this file, an override that emitted the marker itself,
 * did not catch. {@link describe} `the notice is the production write` states that directly,
 * against the real repository with a statement-capturing runner.
 */

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_credential_change_record_test';
const USER = '0198f0bb-0000-7000-8000-000000000001';
const SESSION = '0198f0bb-0000-7000-8000-0000000000a1';
const FACTOR = '0198f0bb-0000-7000-8000-0000000000f1';

const NOW = 1_757_000_000_000;

const CONTEXT = {
  correlationId: '0198f0bb-0000-7000-8000-0000000000c1',
  ip: '203.0.113.9',
  userAgent: 'vitest',
};

/** Obviously fake: a byte repeated thirty-two times. Nothing here is a real key. */
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x22).toString('base64url')}`));

/** Long, unlike any identifier passed in, and not in the common list. */
const NEW_PASSWORD = 'correct-horse-battery-staple-42';

// ─────────────────────────────────────────────────────────────────────────────
// A unit of work that can be rolled back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One transaction's buffered writes. Nothing here is durable until the commit says so.
 *
 * It is also the query runner the *real* repository writes through. The faked change methods
 * push readable markers with {@link noteOn}; the real `recordAuthenticationEvent` /
 * `recordCredentialChange` reach drizzle, which calls {@link FakeUnitOfWork.query} — and that
 * turns the one statement each issues into the same kind of marker, in the same buffer, so
 * commit order stays legible. The notice row is therefore genuinely built and issued here, not
 * re-implemented by the fake: remove the production insert and no `notice:` marker appears.
 */
class FakeUnitOfWork {
  readonly writes: string[] = [];

  /**
   * The proxy-driver entry point `tenantDrizzle` calls. It recognises exactly the two inserts
   * the credential path issues and records each as a marker; an insert returns the
   * `ResultSetHeader` shape drizzle's proxy dialect expects. Anything unrecognised throws
   * rather than passing silently, so a new statement on this path cannot slip through untested.
   */
  async query(
    statement: string,
    params: readonly unknown[],
  ): Promise<{ affectedRows: number; insertId: number }> {
    if (statement.includes('`credential_change_notices`')) {
      this.writes.push(`notice:${String(params[2])}`);
    } else if (statement.includes('`authentication_events`')) {
      this.writes.push(`record:${String(params[2])}:${String(params[3])}`);
    } else {
      throw new Error(`an unrecognised statement reached the fake unit of work: ${statement}`);
    }
    return { affectedRows: 1, insertId: 0 };
  }
}

function noteOn(runner: IdentityQueryRunner, entry: string): void {
  const unit = runner as unknown as Partial<FakeUnitOfWork>;
  if (!Array.isArray(unit.writes)) {
    throw new Error(`a write reached a runner that is not a unit of work: ${entry}`);
  }
  unit.writes.push(entry);
}

class FakeIdentityDatabase {
  /** Everything that survived a commit, in commit order. The only durable thing here. */
  readonly committed: string[] = [];
  /** One entry per transaction opened, whether or not it committed. */
  readonly units: FakeUnitOfWork[] = [];
  /** When true, every commit is refused *after* the callback has run to completion. */
  commitFails = false;

  async identityRead<T>(
    _options: unknown,
    work: (db: IdentityQueryRunner) => Promise<T>,
  ): Promise<T> {
    // A distinct handle, deliberately not registered in `units`: a write issued here is
    // buffered into an object nothing ever commits, which is what a read runner is.
    return work(new FakeUnitOfWork() as unknown as IdentityQueryRunner);
  }

  async identityTransaction<T>(
    _options: unknown,
    work: (tx: IdentityQueryRunner) => Promise<T>,
  ): Promise<T> {
    const unit = new FakeUnitOfWork();
    this.units.push(unit);
    // A throw from `work` propagates with the buffer discarded — the rollback.
    const result = await work(unit as unknown as IdentityQueryRunner);
    if (this.commitFails) throw new Error('the commit was refused');
    this.committed.push(...unit.writes);
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The repository, replaced by its own record of what was asked of it
// ─────────────────────────────────────────────────────────────────────────────

const SECRET = generateTotpSecret();

const PENDING_FACTOR: UserMfaFactorRow = {
  id: FACTOR,
  userId: USER,
  kind: 'totp',
  label: 'Owner phone',
  secret: SECRET,
  confirmedAt: null,
  lastAcceptedCounter: null,
  lastUsedAt: null,
  createdAt: new Date(NOW),
  disabledAt: null,
};

const EXISTING_PASSWORD: UserPasswordRow = {
  userId: USER,
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g',
  setAt: new Date(NOW),
  updatedAt: new Date(NOW),
};

interface Change {
  readonly action: string;
  readonly occurredAt: Date;
}

class RecordingCredentials extends CredentialsRepository {
  /** What `findPassword` answers. `null` is the invited person finishing enrolment. */
  password: UserPasswordRow | null = null;
  /** Handed back by `listCredentialChanges`, so the read path can be checked in isolation. */
  changes: readonly Change[] = [];
  /** The last arguments `listCredentialChanges` was called with. */
  listedFor: { userId: string; actions: readonly string[]; limit: number } | null = null;

  constructor() {
    super(CIPHER);
  }

  override async findPassword(): Promise<UserPasswordRow | null> {
    return this.password;
  }

  override async setPassword(runner: IdentityQueryRunner): Promise<void> {
    noteOn(runner, 'change:password');
  }

  override async createFactor(runner: IdentityQueryRunner): Promise<string> {
    noteOn(runner, 'change:factor-created');
    return FACTOR;
  }

  override async findFactor(): Promise<UserMfaFactorRow | null> {
    return PENDING_FACTOR;
  }

  override async findFactorIdentity(): Promise<{ id: string; userId: string }> {
    return { id: FACTOR, userId: USER };
  }

  override async confirmFactor(runner: IdentityQueryRunner): Promise<boolean> {
    noteOn(runner, 'change:factor-confirmed');
    return true;
  }

  override async disableFactor(runner: IdentityQueryRunner): Promise<boolean> {
    noteOn(runner, 'change:factor-disabled');
    return true;
  }

  override async replaceRecoveryCodes(runner: IdentityQueryRunner): Promise<string> {
    noteOn(runner, 'change:recovery-codes-replaced');
    return FACTOR;
  }

  // `recordAuthenticationEvent` and `recordCredentialChange` are deliberately NOT overridden —
  // see the file header, C2. They run as the real repository code and issue their statements
  // through {@link FakeUnitOfWork.query}, so the notice is proved by the production write.

  override async listCredentialChanges(
    _runner: IdentityQueryRunner,
    userId: string,
    actions: readonly string[],
    limit: number,
  ): Promise<readonly { id: string; action: string; occurredAt: Date }[]> {
    this.listedFor = { userId, actions, limit };
    return this.changes.map((change, index) => ({
      id: `0198f0bb-0000-7000-8000-00000000e00${String(index)}`,
      action: change.action,
      occurredAt: change.occurredAt,
    }));
  }
}

/** Sessions never touch a real table here; the cutoff only has to be seen to happen. */
class RecordingSessions extends SessionsRepository {
  override async revokeOthersForUser(runner: IdentityQueryRunner): Promise<number> {
    noteOn(runner, 'change:other-sessions-revoked');
    return 1;
  }

  /** F01 (wave 9): the session that sets a first password has just signed in. */
  override async isEstablishedWithin(): Promise<boolean> {
    return true;
  }
}

/** F19 (wave 9): the bearer cutoff runs outside the identity unit; here it only has to resolve. */
const NO_BEARER_CREDENTIALS: BearerCredentialCutoff = {
  revokeAllForUser: () => Promise.resolve({ personalAccessTokens: 0, grants: 0 }),
};

function build(): {
  service: AuthenticationService;
  credentials: RecordingCredentials;
  database: FakeIdentityDatabase;
} {
  const credentials = new RecordingCredentials();
  const database = new FakeIdentityDatabase();

  const service = new AuthenticationService(
    database as unknown as TenantDatabase,
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
        now: () => NOW,
      }),
    },
    credentials,
    () => NOW,
    new RecordingSessions(),
    NO_BEARER_CREDENTIALS,
  );

  return { service, credentials, database };
}

const proof = (): string =>
  signReauthToken(
    { userId: USER, sessionId: SESSION, expiresAt: new Date(NOW + REAUTH_TTL_SECONDS * 1000) },
    SESSION_SECRET,
  );

const codeNow = (): string =>
  hotpCode(base32Decode(SECRET)!, totpCounterAt(NOW, 30), {
    digits: 6,
    algorithm: 'SHA1',
  });

// ─────────────────────────────────────────────────────────────────────────────

describe('every credential change leaves a record, in the change’s own transaction', () => {
  it('records a first password beside the hash, in one unit of work', async () => {
    const { service, database } = build();

    await service.setPassword({
      userId: USER,
      sessionId: SESSION,
      password: NEW_PASSWORD,
      context: CONTEXT,
    });

    expect(database.units).toHaveLength(1);
    expect(database.committed).toEqual([
      'change:password',
      'record:password_set:succeeded',
      'notice:password_set',
    ]);
  });

  it('records a replaced password beside the hash and the session cutoff', async () => {
    const { service, credentials, database } = build();
    credentials.password = EXISTING_PASSWORD;

    await service.setPassword({
      userId: USER,
      sessionId: SESSION,
      password: NEW_PASSWORD,
      reauthToken: proof(),
      context: CONTEXT,
    });

    // D06's cutoff and D05d's record are in the same unit as the hash: an owner told their
    // password changed and a set of sessions ended together, or neither.
    expect(database.units).toHaveLength(1);
    expect(database.committed).toEqual([
      'change:password',
      'change:other-sessions-revoked',
      'record:password_set:succeeded',
      'notice:password_set',
    ]);
  });

  it('records the removal of a second factor', async () => {
    const { service, database } = build();

    await service.disableFactor({
      userId: USER,
      sessionId: SESSION,
      factorId: FACTOR,
      reauthToken: proof(),
      context: CONTEXT,
    });

    expect(database.units).toHaveLength(1);
    expect(database.committed).toEqual([
      'change:factor-disabled',
      'record:mfa_factor_disabled:succeeded',
      'notice:mfa_factor_disabled',
    ]);
  });

  it('records a regenerated set of recovery codes', async () => {
    const { service, database } = build();

    await service.regenerateRecoveryCodes({
      userId: USER,
      sessionId: SESSION,
      reauthToken: proof(),
      context: CONTEXT,
    });

    expect(database.units).toHaveLength(1);
    expect(database.committed).toEqual([
      'change:recovery-codes-replaced',
      'record:recovery_codes_issued:succeeded',
      'notice:recovery_codes_issued',
    ]);
  });

  /**
   * The gap D05c leaves behind. Confirming a factor replaces the recovery codes, so the log
   * has to answer "when were my recovery codes last replaced" with *this* moment — otherwise
   * the one route the 2026-09-12 finding was about is the one route that leaves no trace of
   * the destruction it performs.
   */
  it('records BOTH the enrolment and the recovery codes it silently replaced', async () => {
    const { service, database } = build();

    const result = await service.confirmTotpFactor({
      userId: USER,
      sessionId: SESSION,
      factorId: FACTOR,
      code: codeNow(),
      reauthToken: proof(),
      context: CONTEXT,
    });

    expect(result.recoveryCodes).toHaveLength(10);
    expect(database.units).toHaveLength(1);
    expect(database.committed).toEqual([
      'change:factor-confirmed',
      'change:recovery-codes-replaced',
      'record:mfa_factor_enrolled:succeeded',
      'notice:mfa_factor_enrolled',
      'record:recovery_codes_issued:succeeded',
      'notice:recovery_codes_issued',
    ]);
  });

  /**
   * Beginning an enrolment writes an *unconfirmed* factor, which authorises nothing and is
   * not counted when deciding whether MFA is required. It is deliberately not a credential
   * change: a row for it would put "a second factor was added" on the owner's screen for
   * something that may never be confirmed, and the refusal path already records the attempt
   * when the gate turns it away. Asserted so the omission is a decision, not a gap.
   */
  it('does not record the pending factor a begun enrolment leaves behind', async () => {
    const { service, database } = build();

    await service.beginTotpEnrolment({
      userId: USER,
      sessionId: SESSION,
      accountName: 'owner@northstar.example',
      label: 'Owner phone',
      reauthToken: proof(),
      context: CONTEXT,
    });

    expect(database.committed).toEqual(['change:factor-created']);
  });
});

describe('the record cannot outlive the change, nor the change the record', () => {
  /**
   * The case no ordering assertion reaches: every statement succeeded and the commit was
   * refused anyway — a deadlock victim, a lost connection, a full disk. If the record were
   * written in a transaction of its own it would survive this and the owner would be told
   * about a change that never happened.
   */
  it('loses the record when the commit is refused, for every credential-changing route', async () => {
    const routes: readonly [string, (service: AuthenticationService) => Promise<unknown>][] = [
      [
        'setPassword',
        (service) =>
          service.setPassword({
            userId: USER,
            sessionId: SESSION,
            password: NEW_PASSWORD,
            context: CONTEXT,
          }),
      ],
      [
        'confirmTotpFactor',
        (service) =>
          service.confirmTotpFactor({
            userId: USER,
            sessionId: SESSION,
            factorId: FACTOR,
            code: codeNow(),
            reauthToken: proof(),
            context: CONTEXT,
          }),
      ],
      [
        'regenerateRecoveryCodes',
        (service) =>
          service.regenerateRecoveryCodes({
            userId: USER,
            sessionId: SESSION,
            reauthToken: proof(),
            context: CONTEXT,
          }),
      ],
      [
        'disableFactor',
        (service) =>
          service.disableFactor({
            userId: USER,
            sessionId: SESSION,
            factorId: FACTOR,
            reauthToken: proof(),
            context: CONTEXT,
          }),
      ],
    ];

    for (const [name, run] of routes) {
      const { service, database } = build();
      database.commitFails = true;

      await expect(run(service), name).rejects.toThrow('the commit was refused');

      // Nothing durable: not the change, and — the point — not the record, and not the
      // notice. A notice that survived this would put "your password was changed" in the
      // owner's mailbox for a password that is still the old one.
      expect(database.committed, name).toEqual([]);
      // The writes were buffered in the change's own unit, which is what makes them
      // recoverable as one thing. A record or a notice issued on a second handle — a second
      // transaction, a queue of its own, an after-commit effect — would be absent here.
      expect(database.units, name).toHaveLength(1);
      expect(
        database.units[0]!.writes.filter((entry) => entry.startsWith('record:')),
        name,
      ).not.toEqual([]);
      expect(
        database.units[0]!.writes.filter((entry) => entry.startsWith('notice:')),
        name,
      ).not.toEqual([]);
    }
  });

  /**
   * The other direction. A change that throws part-way takes its record with it, so a row
   * never claims something that did not happen.
   */
  it('loses the record when the change itself throws', async () => {
    const { service, credentials, database } = build();
    credentials.replaceRecoveryCodes = async (runner: IdentityQueryRunner): Promise<string> => {
      noteOn(runner, 'change:recovery-codes-replaced');
      throw new Error('the update failed');
    };

    await expect(
      service.regenerateRecoveryCodes({
        userId: USER,
        sessionId: SESSION,
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).rejects.toThrow('the update failed');

    expect(database.committed).toEqual([]);
  });
});

/**
 * Every route that changes a credential, with the actions the owner has to be told about.
 * `confirmTotpFactor` carries two because it does two things — see `D05c`.
 */
const SUCCEEDING_ROUTES: readonly [
  string,
  readonly string[],
  (service: AuthenticationService) => Promise<unknown>,
][] = [
  [
    'setPassword',
    [AUTHENTICATION_ACTIONS.passwordSet],
    (service) =>
      service.setPassword({
        userId: USER,
        sessionId: SESSION,
        password: NEW_PASSWORD,
        context: CONTEXT,
      }),
  ],
  [
    'confirmTotpFactor',
    [AUTHENTICATION_ACTIONS.factorEnrolled, AUTHENTICATION_ACTIONS.recoveryCodesIssued],
    (service) =>
      service.confirmTotpFactor({
        userId: USER,
        sessionId: SESSION,
        factorId: FACTOR,
        code: codeNow(),
        reauthToken: proof(),
        context: CONTEXT,
      }),
  ],
  [
    'regenerateRecoveryCodes',
    [AUTHENTICATION_ACTIONS.recoveryCodesIssued],
    (service) =>
      service.regenerateRecoveryCodes({
        userId: USER,
        sessionId: SESSION,
        reauthToken: proof(),
        context: CONTEXT,
      }),
  ],
  [
    'disableFactor',
    [AUTHENTICATION_ACTIONS.factorDisabled],
    (service) =>
      service.disableFactor({
        userId: USER,
        sessionId: SESSION,
        factorId: FACTOR,
        reauthToken: proof(),
        context: CONTEXT,
      }),
  ],
];

/**
 * The second half of `D05d`: the owner is *told*, without opening the screen.
 *
 * A record the owner has to go looking for answers the question "when were my recovery
 * codes replaced" only for somebody who already suspects the answer. The notice is what
 * reaches a person who suspects nothing, and `credential_change_notices` is the queue it
 * leaves through — the transactional outbox pattern with the tenant column removed, for the
 * reason `0020_credential_change_notices.sql` gives at length: a credential belongs to no
 * organization, and the identity path may not touch a tenant table at all.
 *
 * What is asserted here is only the property that pattern exists for. The notice is issued
 * on the runner that changed the credential, so it commits with the change or not at all —
 * never after it, never beside it, never from a second unit of work. The shape this is
 * guarding against is the one this repository has actually been bitten by: an outbox held as
 * an optional collaborator (`private readonly outbox?: OutboxEventsRepository`) that is
 * simply absent wherever somebody built the service without it, and whose absence nothing
 * fails. There is no collaborator to omit here, and no second call to forget — the record
 * and the notice are one repository method — so the assertion below is about the boundary
 * rather than about anybody's discipline.
 */
describe('the owner is told, from the transaction that changed the credential', () => {
  for (const [name, actions, run] of SUCCEEDING_ROUTES) {
    it(`queues a notice for every change ${name} makes, in the change's own unit`, async () => {
      const { service, database } = build();

      await run(service);

      // One transaction for the change, its record and its notice. Not two.
      expect(database.units).toHaveLength(1);
      expect(database.committed.filter((entry) => entry.startsWith('notice:'))).toEqual(
        actions.map((action) => `notice:${action}`),
      );
    });
  }

  /**
   * The failure mode that has no name and no error: a success path that records the change
   * and stops. It is the easy mistake — recording is the line that looks like the important
   * one — and the only symptom is a person who is never told. Stated as a property over
   * every route rather than a count, so a fifth credential-changing action added later fails
   * here unless it tells somebody.
   */
  it('records no credential change without a notice beside it', async () => {
    for (const [name, , run] of SUCCEEDING_ROUTES) {
      const { service, database } = build();

      await run(service);

      const committed = database.committed;
      for (let i = 0; i < committed.length; i += 1) {
        const entry = committed[i]!;
        if (!entry.endsWith(':succeeded')) continue;
        const action = entry.slice('record:'.length, -':succeeded'.length);
        expect(committed[i + 1], `${name}: ${entry}`).toBe(`notice:${action}`);
      }
    }
  });

  /**
   * A refusal is not a change, and the person did nothing to be told about. The refusal path
   * writes its row in a transaction of its own — correctly, because a failed attempt has no
   * change to join — and must not queue mail: an attacker who could make a route refuse
   * could otherwise send the account holder as many messages as they liked.
   */
  it('queues nothing for a refused change', async () => {
    const { service, database } = build();

    await expect(
      service.regenerateRecoveryCodes({
        userId: USER,
        sessionId: SESSION,
        reauthToken: undefined,
        context: CONTEXT,
      }),
    ).rejects.toThrow();

    expect(database.committed.filter((entry) => entry.startsWith('notice:'))).toEqual([]);
    expect(database.committed).toEqual(['record:recovery_codes_issued:failed']);
  });
});

describe('the owner can read what happened to their own credentials', () => {
  // The title claims only what a fake can decide. "Newest first" is `desc(occurred_at),
  // desc(id)` in the repository SQL and is proved by the DB file, not here — the fake returns
  // whatever array it is handed, so asserting an order would only be asserting the fake. What
  // *is* decidable at this layer is that the read asks for the closed credential-change
  // vocabulary and for the specific bound the module declares, so both are asserted exactly.
  it('asks for the credential-changing actions alone, bounded to CREDENTIAL_CHANGE_LIMIT', async () => {
    const { service, credentials } = build();
    credentials.changes = [
      { action: AUTHENTICATION_ACTIONS.recoveryCodesIssued, occurredAt: new Date(NOW) },
      { action: AUTHENTICATION_ACTIONS.passwordSet, occurredAt: new Date(NOW - 60_000) },
    ];

    const changes = await service.listCredentialChanges({
      userId: USER,
      correlationId: CONTEXT.correlationId,
    });

    expect(credentials.listedFor?.userId).toBe(USER);
    expect(credentials.listedFor?.actions).toEqual([...CREDENTIAL_CHANGE_ACTIONS]);
    expect(credentials.listedFor?.limit).toBe(CREDENTIAL_CHANGE_LIMIT);
    // A pass-through check, not an ordering one: the service hands back exactly the rows the
    // repository returned, in the order it returned them.
    expect(changes.map((change) => change.action)).toEqual([
      'recovery_codes_issued',
      'password_set',
    ]);
  });

  /**
   * A sign-in is not a credential change, and `reason` is the column
   * `migrations/0004_credentials.sql` says is "recorded here and NEVER returned to the
   * caller". The vocabulary this read asks for is therefore a closed list rather than
   * "everything about this user", and the list is exactly the four routes that change
   * something.
   */
  it('asks for no sign-in, challenge or re-authentication row', async () => {
    const { service, credentials } = build();

    await service.listCredentialChanges({
      userId: USER,
      correlationId: CONTEXT.correlationId,
    });

    const asked = credentials.listedFor?.actions ?? [];
    expect(asked).not.toContain(AUTHENTICATION_ACTIONS.passwordSignIn);
    expect(asked).not.toContain(AUTHENTICATION_ACTIONS.mfaChallenge);
    expect(asked).not.toContain(AUTHENTICATION_ACTIONS.recoveryCode);
    expect(asked).not.toContain(AUTHENTICATION_ACTIONS.reauthentication);
    expect([...asked].sort()).toEqual(
      [
        AUTHENTICATION_ACTIONS.factorDisabled,
        AUTHENTICATION_ACTIONS.factorEnrolled,
        AUTHENTICATION_ACTIONS.passwordSet,
        AUTHENTICATION_ACTIONS.recoveryCodesIssued,
      ].sort(),
    );
  });

  /** A read, not a change: it opens no transaction. */
  it('reads without opening a transaction', async () => {
    const { service, database } = build();

    await service.listCredentialChanges({
      userId: USER,
      correlationId: CONTEXT.correlationId,
    });

    expect(database.units).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The record and the notice as the real repository code, against a runner that
// captures the statements drizzle actually issues.
// ─────────────────────────────────────────────────────────────────────────────

/** A runner that records every statement the real repository issues through drizzle. */
function captureRunner(): {
  statements: { sql: string; params: readonly unknown[] }[];
  runner: IdentityQueryRunner;
} {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const runner = {
    async query(sql: string, params?: readonly unknown[]) {
      statements.push({ sql, params: params ?? [] });
      return { affectedRows: 1, insertId: 0 } as never;
    },
  } as unknown as IdentityQueryRunner;
  return { statements, runner };
}

/**
 * C2, stated against the real repository directly. The service-level cases above already fail
 * if the production insert is removed (their `notice:` markers come from
 * {@link FakeUnitOfWork.query} running the real code), but this pins the write on its own,
 * without a service in the way: two statements, and the second is the notice.
 */
describe('the notice is the production write', () => {
  it('records the change and then queues a notice on credential_change_notices', async () => {
    const repo = new CredentialsRepository(CIPHER);
    const { statements, runner } = captureRunner();

    await repo.recordCredentialChange(runner, {
      userId: USER,
      action: AUTHENTICATION_ACTIONS.passwordSet,
      ip: CONTEXT.ip,
      userAgent: CONTEXT.userAgent,
      correlationId: CONTEXT.correlationId,
    });

    // If `.insert(credentialChangeNotices)` is deleted this drops to one statement and both of
    // the last two expectations fail — the revert-proof C2 asks for.
    expect(statements).toHaveLength(2);
    expect(statements[0]!.sql).toContain('`authentication_events`');
    expect(statements[1]!.sql).toContain('`credential_change_notices`');
    expect(statements[1]!.params).toContain(USER);
    expect(statements[1]!.params).toContain(AUTHENTICATION_ACTIONS.passwordSet);
  });
});

/**
 * I1, by construction. The atomicity of "recorded and notified" is now a property of the type
 * of write: `recordAuthenticationEvent` refuses a *succeeded* row for any credential-change
 * action, so the only way to record one is `recordCredentialChange`, which writes the notice
 * with it. Failures and non-credential successes are untouched.
 */
describe('a succeeded credential change cannot be recorded without its notice', () => {
  it('refuses a succeeded row from recordAuthenticationEvent, for every change action', async () => {
    const repo = new CredentialsRepository(CIPHER);

    // Iterating the service's exported list is the anti-drift check: if the repository's own
    // copy dropped one of these, that action's succeeded row would not throw and this fails.
    for (const action of CREDENTIAL_CHANGE_ACTIONS) {
      const { statements, runner } = captureRunner();
      await expect(
        repo.recordAuthenticationEvent(runner, {
          userId: USER,
          action,
          outcome: 'succeeded',
          correlationId: CONTEXT.correlationId,
        }),
        action,
      ).rejects.toBeInstanceOf(CredentialChangeNoticeRequiredError);
      // The refusal is before the insert: no half-recorded change is left behind.
      expect(statements, action).toEqual([]);
    }
  });

  it('still records a refused (failed) credential-change attempt', async () => {
    const repo = new CredentialsRepository(CIPHER);
    const { statements, runner } = captureRunner();

    await repo.recordAuthenticationEvent(runner, {
      userId: USER,
      action: AUTHENTICATION_ACTIONS.recoveryCodesIssued,
      outcome: 'failed',
      reason: 'mfa_bad_code',
      correlationId: CONTEXT.correlationId,
    });

    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toContain('`authentication_events`');
  });

  it('still records a succeeded non-credential event, so the guard is not over-broad', async () => {
    const repo = new CredentialsRepository(CIPHER);
    const { statements, runner } = captureRunner();

    await repo.recordAuthenticationEvent(runner, {
      userId: USER,
      action: AUTHENTICATION_ACTIONS.passwordSignIn,
      outcome: 'succeeded',
      correlationId: CONTEXT.correlationId,
    });

    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toContain('`authentication_events`');
  });
});
