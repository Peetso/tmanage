import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { parseSeedKeys } from '@tmanage/config';
import type { RowDataPacket } from 'mysql2/promise';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { mintCsrfToken } from '../src/common/http/csrf.js';
import {
  AuthenticationService,
  USER_SESSION_REVOCATION_REASON,
} from '../src/modules/identity/authentication.service.js';
import type { AuthenticationOptions } from '../src/modules/identity/authentication.service.js';
import { CredentialsRepository } from '../src/modules/identity/credentials.repository.js';
import { createSeedCipher } from '../src/modules/identity/seed-cipher.js';
import { createSignInAbuseControl } from '../src/modules/identity/sign-in-abuse-control.js';
import { signReauthToken } from '../src/modules/identity/reauth-token.js';
import { SessionService } from '../src/modules/identity/session.service.js';
import type {
  EstablishedSession,
  SessionServiceOptions,
} from '../src/modules/identity/session.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * `I-1` against a real server — the session-revoke route and, the assertion that matters, the
 * **refresh-token invalidation** it produces.
 *
 * The audit's finding was that a stolen refresh cookie survives up to fourteen days because no
 * route ends a named session. This suite drives the new path end to end: it starts real
 * sessions (each with a live refresh token), revokes one — and all-but-one — behind fresh
 * proof, and then proves the revoked session's refresh token is refused where it used to
 * rotate, while the session that pressed the lever keeps working. That refresh-token
 * invalidation is the thing only a real server shows; the refusals that keep the lever safe
 * (no proof, and one person's session vs another's) are decided without a database and are
 * proved by `authentication.session-revoke.test.ts`, not duplicated here.
 *
 * Written but **not executed** in this slice — the database/e2e lock is held by another job.
 * Run it with: `pnpm --filter @tmanage/api test -- --project database id-002-session-revoke`.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let sessionService: SessionService;
let authService: AuthenticationService;

const SECRET = 'local_dev_only_session_secret_for_the_session_revoke_db_suite';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_session_revoke_db_suite';

const SESSION_OPTIONS: SessionServiceOptions = {
  cookieName: 'tmanage_session',
  sessionSecret: SECRET,
  accessTtlSeconds: 900,
  refreshTtlSeconds: 1_209_600,
  refreshCookiePath: '/v1/sessions/refresh',
  secureCookies: true,
  csrfSecret: CSRF_SECRET,
  csrfCookieName: 'tmanage_session_csrf',
};

/** Obviously fake: a byte repeated thirty-two times. Nothing here is a real key. */
const seedCipher = createSeedCipher(
  parseSeedKeys(`1:${Buffer.alloc(32, 0x11).toString('base64url')}`),
);
const credentials = new CredentialsRepository(seedCipher);

const AUTH_OPTIONS: AuthenticationOptions = {
  sessionSecret: SECRET,
  maxFailuresInWindow: 5,
  failureWindowSeconds: 900,
  totpIssuer: 'TManage',
  abuseControl: createSignInAbuseControl({
    windowMs: 300_000,
    maxPerSource: 10_000,
    maxPerSourceAccount: 10_000,
    maxGlobal: 100_000,
    now: () => Date.now(),
  }),
};

const owner = () => world.northstar.owner.id;

const context = () => ({ correlationId: uuidv7(), ip: '203.0.113.9', userAgent: 'vitest' });

/** The CSRF token bound to a session — ADR-0004; refresh verifies it inside the service. */
const csrf = (session: { readonly sessionId: string }): string =>
  mintCsrfToken(session.sessionId, CSRF_SECRET);

/** Fresh proof for a person, bound to the session that will present it. */
const proofFor = (userId: string, sessionId: string): string =>
  signReauthToken({ userId, sessionId, expiresAt: new Date(Date.now() + 60_000) }, SECRET);

/** Rotate a session's refresh token, the operation a revoked session must no longer allow. */
const refresh = (session: EstablishedSession): Promise<EstablishedSession> =>
  sessionService.refresh({
    refreshToken: session.refreshToken,
    csrfToken: csrf(session),
    correlationId: uuidv7(),
  });

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  sessionService = new SessionService(tenant, SESSION_OPTIONS);
  authService = new AuthenticationService(tenant, AUTH_OPTIONS, credentials);
});

beforeEach(async () => {
  // Append-only `authentication_events` refuses DELETE by trigger; TRUNCATE is DDL and does
  // not fire it. Sessions and the ledger are cleared so each case starts from nothing.
  await db.admin.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of ['authentication_events', 'session_refresh_tokens', 'sessions']) {
      await db.admin.query(`TRUNCATE TABLE \`${table}\``);
    }
  } finally {
    await db.admin.query('SET FOREIGN_KEY_CHECKS = 1');
  }
});

afterAll(async () => {
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('revoking one named session invalidates its refresh token', () => {
  it('refuses the revoked session’s refresh token where it used to rotate, and keeps the caller’s', async () => {
    const current = await sessionService.start({ userId: owner(), correlationId: uuidv7() });
    const victim = await sessionService.start({ userId: owner(), correlationId: uuidv7() });

    // Before the revoke, the victim's refresh token rotates — it is a live credential.
    const rotated = await refresh(victim);

    const ctx = context();
    const revoked = await authService.revokeSession({
      userId: owner(),
      sessionId: current.sessionId,
      targetSessionId: victim.sessionId,
      reauthToken: proofFor(owner(), current.sessionId),
      context: ctx,
    });
    expect(revoked).toBe(true);

    // The invalidation: the victim's current (rotated) refresh token is now refused.
    await expect(
      sessionService.refresh({
        refreshToken: rotated.refreshToken,
        csrfToken: csrf(victim),
        correlationId: uuidv7(),
      }),
    ).rejects.toMatchObject({ name: 'RefreshRejectedError', code: 'session_revoked' });

    // The session that pressed the lever is untouched and still rotates.
    await expect(refresh(current)).resolves.toMatchObject({ sessionId: current.sessionId });

    // The row carries the deliberate, holder-chosen reason.
    const rows = await observe('select revoked_reason from sessions where id = ?', [
      victim.sessionId,
    ]);
    expect(rows[0]!['revoked_reason']).toBe(USER_SESSION_REVOCATION_REASON);

    // Exactly one success row in the security log, naming the person and this correlation.
    const events = await observe(
      'select action, outcome, user_id from authentication_events where correlation_id = ?',
      [ctx.correlationId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!['action']).toBe('session_revoked');
    expect(events[0]!['outcome']).toBe('succeeded');
    expect(events[0]!['user_id']).toBe(owner());
  });
});

describe('revoking every other session', () => {
  it('invalidates every other refresh token and keeps only the caller’s', async () => {
    const current = await sessionService.start({ userId: owner(), correlationId: uuidv7() });
    const second = await sessionService.start({ userId: owner(), correlationId: uuidv7() });
    const third = await sessionService.start({ userId: owner(), correlationId: uuidv7() });

    const ended = await authService.revokeOtherSessions({
      userId: owner(),
      sessionId: current.sessionId,
      reauthToken: proofFor(owner(), current.sessionId),
      context: context(),
    });
    expect(ended).toBe(2);

    for (const session of [second, third]) {
      await expect(refresh(session)).rejects.toMatchObject({
        name: 'RefreshRejectedError',
        code: 'session_revoked',
      });
    }
    await expect(refresh(current)).resolves.toMatchObject({ sessionId: current.sessionId });
  });
});
