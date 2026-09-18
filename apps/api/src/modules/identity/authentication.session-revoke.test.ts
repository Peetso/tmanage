import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import {
  AuthenticationService,
  ReauthenticationRequiredError,
  USER_SESSION_REVOCATION_REASON,
} from './authentication.service.js';
import { CredentialsRepository } from './credentials.repository.js';
import { SessionsRepository } from './sessions.repository.js';
import type { SessionState } from './sessions.repository.js';
import { createSeedCipher } from './seed-cipher.js';
import { createSignInAbuseControl } from './sign-in-abuse-control.js';
import { REAUTH_TTL_SECONDS, signReauthToken } from './reauth-token.js';
import type { SessionRow } from '../../common/database/schema.js';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * `I-1`. The session-revoke path — a locked-out or compromised holder's lever.
 *
 * The database suite (`id-002-session-revoke.db.test.ts`) proves the refresh-token
 * invalidation over a real server: after a revoke the session's refresh cookie is refused.
 * What a fake here proves instead is the shape the database cannot show cheaply — that the
 * fresh-proof gate runs **before** any session row is read or written, that ownership is
 * checked before a revoke, and that the security-log row is written only when a change
 * actually happened. Those are statements about *which calls are issued*, decidable without a
 * database, exactly as `authentication.enrolment-reauth.test.ts` argues.
 */

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_session_revoke_test';
const USER = '0198f0aa-0000-7000-8000-000000000001';
const OTHER_USER = '0198f0aa-0000-7000-8000-000000000002';
const SESSION = '0198f0aa-0000-7000-8000-0000000000a1';
const OTHER_SESSION = '0198f0aa-0000-7000-8000-0000000000a2';
const TARGET = '0198f0aa-0000-7000-8000-0000000000b1';

const NOW = 1_757_000_000_000;

const CONTEXT = {
  correlationId: '0198f0aa-0000-7000-8000-0000000000c1',
  ip: '203.0.113.9',
  userAgent: 'vitest',
};

/** Obviously fake: a byte repeated thirty-two times. Nothing here is a real key. */
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x11).toString('base64url')}`));

interface Event {
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly ip: string | null;
}

/** Captures the security-log write; nothing else on the credentials repository is reached. */
class RecordingCredentials extends CredentialsRepository {
  readonly events: Event[] = [];

  constructor() {
    super(CIPHER);
  }

  override async recordAuthenticationEvent(
    _runner: IdentityQueryRunner,
    input: { action: string; outcome: string; reason?: string | null; ip?: string | null },
  ): Promise<void> {
    this.events.push({
      action: input.action,
      outcome: input.outcome,
      reason: input.reason ?? null,
      ip: input.ip ?? null,
    });
  }
}

/** A session row shell — only the two fields the revoke path reads carry meaning. */
function rowFor(id: string, userId: string): SessionState {
  return {
    session: {
      id,
      userId,
      refreshTokenHash: 'x'.repeat(64),
      userAgent: null,
      expiresAt: new Date(NOW + 1_000_000),
      rotatedAt: null,
      revokedAt: null,
      revokedReason: null,
      createdAt: new Date(NOW),
    } as SessionRow,
    expired: false,
  };
}

/**
 * Records every call the revoke path could make against the session store, and hands back
 * whatever the case configures. Extends the real repository so the service's own default is
 * the thing under test's collaborator, not a hand-rolled interface that could drift from it.
 */
class RecordingSessions extends SessionsRepository {
  readonly calls: string[] = [];
  found: SessionState | null = null;
  revokeResult = true;
  othersEnded = 0;
  lastRevoke: { sessionId: string; reason: string } | null = null;
  lastOthers: { userId: string; keepSessionId: string; reason: string } | null = null;

  override async findById(
    _runner: IdentityQueryRunner,
    sessionId: string,
  ): Promise<SessionState | null> {
    this.calls.push(`findById:${sessionId}`);
    return this.found;
  }

  override async revoke(
    _runner: IdentityQueryRunner,
    sessionId: string,
    reason: string,
  ): Promise<boolean> {
    this.calls.push('revoke');
    this.lastRevoke = { sessionId, reason };
    return this.revokeResult;
  }

  override async revokeOthersForUser(
    _runner: IdentityQueryRunner,
    userId: string,
    keepSessionId: string,
    reason: string,
  ): Promise<number> {
    this.calls.push('revokeOthersForUser');
    this.lastOthers = { userId, keepSessionId, reason };
    return this.othersEnded;
  }
}

/** A runner nothing dereferences: every repository method that would use it is overridden. */
const RUNNER = {} as IdentityQueryRunner;

function build(): {
  service: AuthenticationService;
  credentials: RecordingCredentials;
  sessions: RecordingSessions;
} {
  const credentials = new RecordingCredentials();
  const sessions = new RecordingSessions();
  const database = {
    identityRead: <T>(_options: unknown, work: (db: IdentityQueryRunner) => Promise<T>) =>
      work(RUNNER),
    identityTransaction: <T>(_options: unknown, work: (tx: IdentityQueryRunner) => Promise<T>) =>
      work(RUNNER),
  } as unknown as TenantDatabase;

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
        now: () => NOW,
      }),
    },
    credentials,
    () => NOW,
    sessions,
  );

  return { service, credentials, sessions };
}

const proof = (sessionId = SESSION): string =>
  signReauthToken(
    { userId: USER, sessionId, expiresAt: new Date(NOW + REAUTH_TTL_SECONDS * 1000) },
    SESSION_SECRET,
  );

describe('revoking one named session', () => {
  it('refuses with no proof, before any session row is read', async () => {
    const { service, credentials, sessions } = build();
    sessions.found = rowFor(TARGET, USER);

    await expect(
      service.revokeSession({
        userId: USER,
        sessionId: SESSION,
        targetSessionId: TARGET,
        reauthToken: undefined,
        context: CONTEXT,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    expect(sessions.calls).toEqual([]);
    expect(credentials.events).toEqual([
      {
        action: 'session_revoked',
        outcome: 'failed',
        reason: 'reauth_required',
        ip: '203.0.113.9',
      },
    ]);
  });

  it('refuses proof minted for another session, before any session row is read', async () => {
    const { service, sessions } = build();
    sessions.found = rowFor(TARGET, USER);

    await expect(
      service.revokeSession({
        userId: USER,
        sessionId: SESSION,
        targetSessionId: TARGET,
        reauthToken: proof(OTHER_SESSION),
        context: CONTEXT,
      }),
    ).rejects.toMatchObject({ reason: 'reauth_wrong_session' });

    expect(sessions.calls).toEqual([]);
  });

  it('revokes an owned session with the user-revoked reason and records one success', async () => {
    const { service, credentials, sessions } = build();
    sessions.found = rowFor(TARGET, USER);

    await expect(
      service.revokeSession({
        userId: USER,
        sessionId: SESSION,
        targetSessionId: TARGET,
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).resolves.toBe(true);

    expect(sessions.calls).toEqual([`findById:${TARGET}`, 'revoke']);
    expect(sessions.lastRevoke).toEqual({
      sessionId: TARGET,
      reason: USER_SESSION_REVOCATION_REASON,
    });
    expect(credentials.events).toEqual([
      { action: 'session_revoked', outcome: 'succeeded', reason: null, ip: '203.0.113.9' },
    ]);
  });

  it('does not revoke a session belonging to someone else, and records nothing', async () => {
    const { service, credentials, sessions } = build();
    sessions.found = rowFor(TARGET, OTHER_USER);

    await expect(
      service.revokeSession({
        userId: USER,
        sessionId: SESSION,
        targetSessionId: TARGET,
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).resolves.toBe(false);

    expect(sessions.calls).toEqual([`findById:${TARGET}`]);
    expect(credentials.events).toEqual([]);
  });

  it('answers false for a session that does not exist, and records nothing', async () => {
    const { service, credentials, sessions } = build();
    sessions.found = null;

    await expect(
      service.revokeSession({
        userId: USER,
        sessionId: SESSION,
        targetSessionId: TARGET,
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).resolves.toBe(false);

    expect(sessions.calls).toEqual([`findById:${TARGET}`]);
    expect(credentials.events).toEqual([]);
  });

  it('is idempotent: an already-revoked session records nothing a second time', async () => {
    const { service, credentials, sessions } = build();
    sessions.found = rowFor(TARGET, USER);
    sessions.revokeResult = false;

    await expect(
      service.revokeSession({
        userId: USER,
        sessionId: SESSION,
        targetSessionId: TARGET,
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).resolves.toBe(false);

    expect(sessions.calls).toEqual([`findById:${TARGET}`, 'revoke']);
    expect(credentials.events).toEqual([]);
  });
});

describe('revoking every other session', () => {
  it('refuses with no proof, before any session is ended', async () => {
    const { service, credentials, sessions } = build();

    await expect(
      service.revokeOtherSessions({
        userId: USER,
        sessionId: SESSION,
        reauthToken: undefined,
        context: CONTEXT,
      }),
    ).rejects.toBeInstanceOf(ReauthenticationRequiredError);

    expect(sessions.calls).toEqual([]);
    expect(credentials.events).toEqual([
      {
        action: 'session_revoked',
        outcome: 'failed',
        reason: 'reauth_required',
        ip: '203.0.113.9',
      },
    ]);
  });

  it('keeps the requesting session, ends the rest, and records one success', async () => {
    const { service, credentials, sessions } = build();
    sessions.othersEnded = 3;

    await expect(
      service.revokeOtherSessions({
        userId: USER,
        sessionId: SESSION,
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).resolves.toBe(3);

    expect(sessions.calls).toEqual(['revokeOthersForUser']);
    expect(sessions.lastOthers).toEqual({
      userId: USER,
      keepSessionId: SESSION,
      reason: USER_SESSION_REVOCATION_REASON,
    });
    expect(credentials.events).toEqual([
      { action: 'session_revoked', outcome: 'succeeded', reason: null, ip: '203.0.113.9' },
    ]);
  });

  it('records the pressed lever even when there were no other sessions', async () => {
    const { service, credentials, sessions } = build();
    sessions.othersEnded = 0;

    await expect(
      service.revokeOtherSessions({
        userId: USER,
        sessionId: SESSION,
        reauthToken: proof(),
        context: CONTEXT,
      }),
    ).resolves.toBe(0);

    expect(credentials.events).toEqual([
      { action: 'session_revoked', outcome: 'succeeded', reason: null, ip: '203.0.113.9' },
    ]);
  });
});
