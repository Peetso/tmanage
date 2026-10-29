import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2/promise';
import { IdentityScopeViolation, TenantDatabase } from '../src/common/database/tenant-context.js';
import { mintCsrfToken } from '../src/common/http/csrf.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import {
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from '../src/modules/identity/session-token.js';
import {
  REUSE_REVOCATION_REASON,
  RefreshRejectedError,
  SessionNotAuthenticatedError,
  SessionService,
} from '../src/modules/identity/session.service.js';
import type { SessionServiceOptions } from '../src/modules/identity/session.service.js';
import { SessionsRepository } from '../src/modules/identity/sessions.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * ID-001 against a real server — session authentication, refresh rotation, reuse detection.
 *
 * This is spec §3 **step 1**, and the suite is written around the three claims that matter:
 *
 * 1. **A refusal never says why.** "No such session", "revoked", "expired" and "replayed" are
 *    four audit entries and one caller-facing answer, exactly as in the membership resolver.
 * 2. **A rotated token is single-use, and replaying it kills the session.** The ledger is
 *    what makes a replay distinguishable from noise, and the revocation must survive the
 *    refusal — a rollback would leave the compromised session live.
 * 3. **The identity path can never reach tenant data.** It runs before any organization is
 *    resolved, so ADR-0001 layer 3 has nothing to bind to; what stands in its place is that
 *    the path refuses tenant tables outright, in `observe` mode as well as `enforce`.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let observing: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let service: SessionService;

const repository = new SessionsRepository();

const SECRET = 'local_dev_only_session_secret_for_the_database_suite';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_database_suite';

const OPTIONS: SessionServiceOptions = {
  cookieName: 'tmanage_session',
  sessionSecret: SECRET,
  accessTtlSeconds: 900,
  refreshTtlSeconds: 1_209_600,
  refreshCookiePath: '/api/auth/refresh',
  secureCookies: true,
  csrfSecret: CSRF_SECRET,
  csrfCookieName: 'tmanage_session_csrf',
};

/**
 * The CSRF token bound to a session — ADR-0004.
 *
 * `SessionService.refresh()` verifies it rather than `CsrfGuard`, because a refresh request
 * carries no access cookie and so has no session id to bind against until the refresh token
 * has been looked up. These cases are about rotation and reuse detection rather than about
 * CSRF, so the correctly-bound token is derived here instead of being restated twenty times.
 * The control itself is covered by its own cases at the end of this file, and end to end in
 * `http-pipeline.db.test.ts`.
 */
const csrf = (session: { readonly sessionId: string }): string =>
  mintCsrfToken(session.sessionId, CSRF_SECRET);

/** Unguarded observation of what actually landed, exactly as the isolation corpus does it. */
async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

const identity = { correlationId: uuidv7(), tables: ['sessions', 'session_refresh_tokens'] };

const userId = () => world.northstar.owner.id;
const otherUserId = () => world.northstar.designer.id;

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  guardEvents = [];
  tenant = new TenantDatabase(db.runtime, {
    guardMode: 'enforce',
    onGuardEvent: (event) => guardEvents.push(event),
  });
  observing = new TenantDatabase(db.runtime, { guardMode: 'observe' });
  service = new SessionService(tenant, OPTIONS);
});

beforeEach(() => {
  guardEvents.length = 0;
});

afterAll(async () => {
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('starting a session', () => {
  it('stores the hash of the refresh token and never the token', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });

    const rows = await observe('select * from sessions where id = ?', [started.sessionId]);
    expect(rows).toHaveLength(1);
    const row = rows[0] as RowDataPacket;
    expect(row['refresh_token_hash']).toBe(hashRefreshToken(started.refreshToken));
    // The credential itself must appear nowhere in the row, under any column.
    expect(JSON.stringify(row)).not.toContain(started.refreshToken);
    expect(row['revoked_at']).toBeNull();
    expect(row['rotated_at']).toBeNull();
  });

  it('sets an absolute deadline from the refresh TTL', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    const remaining = (started.expiresAt.getTime() - Date.now()) / 1000;
    expect(remaining).toBeGreaterThan(OPTIONS.refreshTtlSeconds - 60);
    expect(remaining).toBeLessThanOrEqual(OPTIONS.refreshTtlSeconds + 1);
  });

  it('records the user agent for the device list, and tolerates its absence', async () => {
    const withAgent = await service.start({
      userId: userId(),
      userAgent: 'Mozilla/5.0 (test)',
      correlationId: uuidv7(),
    });
    const withoutAgent = await service.start({ userId: userId(), correlationId: uuidv7() });

    const rows = await observe('select id, user_agent from sessions where id in (?, ?)', [
      withAgent.sessionId,
      withoutAgent.sessionId,
    ]);
    const byId = new Map(rows.map((r) => [String(r['id']), r['user_agent']]));
    expect(byId.get(withAgent.sessionId)).toBe('Mozilla/5.0 (test)');
    expect(byId.get(withoutAgent.sessionId)).toBeNull();
  });

  it('issues both cookies, each scoped to what it is for', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    const [access, refresh] = started.cookies as [string, string];

    // The access cookie travels everywhere, so it must survive a top-level navigation from
    // an emailed link — Lax, not Strict.
    expect(access).toContain('tmanage_session=');
    expect(access).toContain('Path=/');
    expect(access).toContain('SameSite=Lax');
    expect(access).toContain('HttpOnly');
    expect(access).toContain('Secure');

    // The long-lived credential is absent from every request except the one that rotates it.
    expect(refresh).toContain('tmanage_session_refresh=');
    expect(refresh).toContain('Path=/api/auth/refresh');
    expect(refresh).toContain('SameSite=Strict');
    expect(refresh).toContain('HttpOnly');
  });

  it('never lets the access token outlive the session', async () => {
    // A session in its last seconds must not hand out a fifteen-minute access token, or the
    // absolute deadline means nothing for the length of one access window.
    const brief = new SessionService(tenant, { ...OPTIONS, refreshTtlSeconds: 30 });
    const started = await brief.start({ userId: userId(), correlationId: uuidv7() });

    const verified = verifyAccessToken(started.accessToken, SECRET);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims.expiresAt.getTime()).toBeLessThanOrEqual(started.expiresAt.getTime());
    expect((verified.claims.expiresAt.getTime() - Date.now()) / 1000).toBeLessThan(31);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('authenticating a request', () => {
  it('accepts a freshly issued access token and reports who it belongs to', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    const authenticated = await service.authenticate({
      accessToken: started.accessToken,
      correlationId: uuidv7(),
    });
    // Exactly what MembershipResolver.resolve() needs, and nothing more.
    // PA-06 (0247) adds whether the operator asked for two-step at the next sign-in.
    expect(authenticated).toEqual({
      sessionId: started.sessionId,
      userId: userId(),
      twoStepRequired: false,
    });
  });

  it('refuses a request with no cookie', async () => {
    await expect(
      service.authenticate({ accessToken: undefined, correlationId: uuidv7() }),
    ).rejects.toMatchObject({ name: 'SessionNotAuthenticatedError', code: 'no_cookie' });
  });

  it('refuses a forged signature', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    const foreign = new SessionService(tenant, { ...OPTIONS, sessionSecret: `${SECRET}-other` });
    const forged = await foreign.start({ userId: userId(), correlationId: uuidv7() });

    await expect(
      service.authenticate({ accessToken: forged.accessToken, correlationId: uuidv7() }),
    ).rejects.toMatchObject({ code: 'bad_signature' });
    // The genuine one still works, so the refusal above is about the signature and not about
    // the session having been damaged.
    await expect(
      service.authenticate({ accessToken: started.accessToken, correlationId: uuidv7() }),
    ).resolves.toBeDefined();
  });

  it('refuses an access token whose window has closed, while the session is still live', async () => {
    // The two clocks are independent by design: the access token is short-lived so a stolen
    // one dies quickly; the session outlives it and is renewed by rotation.
    const brief = new SessionService(tenant, { ...OPTIONS, accessTtlSeconds: 1 });
    const started = await brief.start({ userId: userId(), correlationId: uuidv7() });
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    await expect(
      brief.authenticate({ accessToken: started.accessToken, correlationId: uuidv7() }),
    ).rejects.toMatchObject({ code: 'access_expired' });

    // The refresh token is unaffected — this is precisely the case rotation exists for.
    await expect(
      brief.refresh({
        refreshToken: started.refreshToken,
        csrfToken: csrf(started),
        correlationId: uuidv7(),
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a well-signed token for a session that does not exist', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    await db.admin.query('DELETE FROM sessions WHERE id = ?', [started.sessionId]);

    await expect(
      service.authenticate({ accessToken: started.accessToken, correlationId: uuidv7() }),
    ).rejects.toMatchObject({ code: 'session_unknown' });
  });

  it('refuses immediately after revocation, not when the access token expires', async () => {
    // "Immediate server-side revocation" (04 §3) is only true because this path reads the
    // row. A signature-only check would keep serving for the rest of the access window.
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    await service.revoke({
      sessionId: started.sessionId,
      reason: 'signed_out',
      correlationId: uuidv7(),
    });

    await expect(
      service.authenticate({ accessToken: started.accessToken, correlationId: uuidv7() }),
    ).rejects.toMatchObject({ code: 'session_revoked' });
  });

  it('refuses a session past its absolute deadline, however valid the access token', async () => {
    const expired = await tenant.identityTransaction(identity, (tx) =>
      repository.create(tx, {
        userId: userId(),
        refreshTokenHash: hashRefreshToken(`expired-access-${uuidv7()}`),
        ttlSeconds: -5,
      }),
    );

    // A genuine, unexpired, correctly-signed access token for a session whose own deadline
    // has passed. The session row is what ends access, not the token.
    const accessToken = signAccessToken(
      { sessionId: expired.id, expiresAt: new Date(Date.now() + 900_000) },
      SECRET,
    );

    await expect(
      service.authenticate({ accessToken, correlationId: uuidv7() }),
    ).rejects.toMatchObject({ code: 'session_expired' });
  });

  it('gives every refusal the same message, so nothing is enumerable', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    await service.revoke({
      sessionId: started.sessionId,
      reason: 'signed_out',
      correlationId: uuidv7(),
    });

    const messages = new Set<string>();
    const codes = new Set<string>();
    for (const accessToken of [undefined, 'nonsense', started.accessToken]) {
      try {
        await service.authenticate({ accessToken, correlationId: uuidv7() });
        expect.unreachable('authentication should have been refused');
      } catch (error) {
        expect(error).toBeInstanceOf(SessionNotAuthenticatedError);
        messages.add((error as Error).message);
        codes.add((error as SessionNotAuthenticatedError).code);
      }
    }
    // One message for a missing cookie, a malformed one, and a revoked session.
    expect(messages.size).toBe(1);
    // Three different causes recorded for the audit trail behind it.
    expect(codes.size).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('rotating the refresh token', () => {
  it('issues a new token, retires the old one, and keeps the deadline', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    const rotated = await service.refresh({
      refreshToken: started.refreshToken,
      csrfToken: csrf(started),
      correlationId: uuidv7(),
    });

    expect(rotated.sessionId).toBe(started.sessionId);
    expect(rotated.refreshToken).not.toBe(started.refreshToken);
    // The absolute deadline does not move. A refresh token that slides its own expiry
    // produces a session that never ends, and a stolen one that never ends either.
    expect(rotated.expiresAt.getTime()).toBe(started.expiresAt.getTime());

    const rows = await observe(
      'select refresh_token_hash, rotated_at, expires_at from sessions where id = ?',
      [started.sessionId],
    );
    expect(rows[0]?.['refresh_token_hash']).toBe(hashRefreshToken(rotated.refreshToken));
    expect(rows[0]?.['rotated_at']).not.toBeNull();
  });

  it('moves the superseded hash into the ledger, and only the hash', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    await service.refresh({
      refreshToken: started.refreshToken,
      csrfToken: csrf(started),
      correlationId: uuidv7(),
    });

    const ledger = await observe('select * from session_refresh_tokens where session_id = ?', [
      started.sessionId,
    ]);
    expect(ledger).toHaveLength(1);
    const row = ledger[0] as RowDataPacket;
    expect(row['token_hash']).toBe(hashRefreshToken(started.refreshToken));
    expect(JSON.stringify(row)).not.toContain(started.refreshToken);
    // The first token has been live since the session began.
    expect(row['issued_at']).not.toBeNull();
  });

  it('chains: each rotation retires exactly one more token', async () => {
    let current = await service.start({ userId: userId(), correlationId: uuidv7() });
    const retired = [hashRefreshToken(current.refreshToken)];
    for (let i = 0; i < 3; i += 1) {
      current = await service.refresh({
        refreshToken: current.refreshToken,
        csrfToken: csrf(current),
        correlationId: uuidv7(),
      });
      retired.push(hashRefreshToken(current.refreshToken));
    }

    const ledger = await observe(
      'select token_hash from session_refresh_tokens where session_id = ? order by superseded_at',
      [current.sessionId],
    );
    // Three rotations retire the first three tokens; the fourth is still live.
    expect(ledger.map((r) => String(r['token_hash']))).toEqual(retired.slice(0, 3));
  });

  it('refuses a token nothing has ever issued, and revokes nothing', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    await expect(
      service.refresh({
        refreshToken: 'a token that was never issued',
        csrfToken: csrf(started),
        correlationId: uuidv7(),
      }),
    ).rejects.toMatchObject({ name: 'RefreshRejectedError', code: 'unknown_token' });

    const rows = await observe('select revoked_at from sessions where id = ?', [started.sessionId]);
    expect(rows[0]?.['revoked_at']).toBeNull();
  });

  it('refuses a missing cookie without touching the database', async () => {
    await expect(
      // No session, so nothing to bind a token to. `no_cookie` is decided before the
      // database is touched, and therefore before CSRF is consulted at all.
      service.refresh({ refreshToken: undefined, csrfToken: undefined, correlationId: uuidv7() }),
    ).rejects.toMatchObject({ code: 'no_cookie' });
  });

  it('refuses to rotate a revoked session', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    await service.revoke({
      sessionId: started.sessionId,
      reason: 'signed_out',
      correlationId: uuidv7(),
    });
    await expect(
      service.refresh({
        refreshToken: started.refreshToken,
        csrfToken: csrf(started),
        correlationId: uuidv7(),
      }),
    ).rejects.toMatchObject({ code: 'session_revoked' });
  });

  it('refuses to rotate an expired session', async () => {
    const token = `expired-refresh-token-${uuidv7()}`;
    await tenant.identityTransaction(identity, (tx) =>
      repository.create(tx, {
        userId: userId(),
        refreshTokenHash: hashRefreshToken(token),
        ttlSeconds: -5,
      }),
    );

    await expect(
      // The session exists but has already expired. Expiry is decided before CSRF: a session
      // that is over is not one there is anything left to forge a request against.
      service.refresh({ refreshToken: token, csrfToken: undefined, correlationId: uuidv7() }),
    ).rejects.toMatchObject({ code: 'session_expired' });
  });

  it('gives every refusal the same message', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    await service.revoke({
      sessionId: started.sessionId,
      reason: 'signed_out',
      correlationId: uuidv7(),
    });

    const messages = new Set<string>();
    for (const refreshToken of [undefined, 'never issued', started.refreshToken]) {
      await service
        .refresh({ refreshToken, csrfToken: csrf(started), correlationId: uuidv7() })
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(RefreshRejectedError);
          messages.add((error as Error).message);
        });
    }
    expect(messages.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('reuse detection', () => {
  it('treats a replayed token as a compromise and revokes the whole session', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    const rotated = await service.refresh({
      refreshToken: started.refreshToken,
      csrfToken: csrf(started),
      correlationId: uuidv7(),
    });

    // The thief replays the token the legitimate client already spent.
    await expect(
      service.refresh({
        refreshToken: started.refreshToken,
        csrfToken: csrf(started),
        correlationId: uuidv7(),
      }),
    ).rejects.toMatchObject({ code: 'reuse_detected', revokedSessionId: started.sessionId });

    // The revocation is committed, not rolled back with the refusal. This is the assertion
    // the whole ordering in SessionService.refresh() exists for.
    const rows = await observe('select revoked_at, revoked_reason from sessions where id = ?', [
      started.sessionId,
    ]);
    expect(rows[0]?.['revoked_at']).not.toBeNull();
    expect(rows[0]?.['revoked_reason']).toBe(REUSE_REVOCATION_REASON);

    // And the *legitimate* holder is locked out too, which is the intended outcome: the
    // server cannot tell which of the two parties is the thief.
    await expect(
      service.refresh({
        refreshToken: rotated.refreshToken,
        csrfToken: csrf(rotated),
        correlationId: uuidv7(),
      }),
    ).rejects.toMatchObject({ code: 'session_revoked' });
    await expect(
      service.authenticate({ accessToken: rotated.accessToken, correlationId: uuidv7() }),
    ).rejects.toMatchObject({ code: 'session_revoked' });
  });

  it('detects a replay from several generations back, not only the previous one', async () => {
    const first = await service.start({ userId: userId(), correlationId: uuidv7() });
    let current = first;
    for (let i = 0; i < 4; i += 1) {
      current = await service.refresh({
        refreshToken: current.refreshToken,
        csrfToken: csrf(current),
        correlationId: uuidv7(),
      });
    }

    // A ledger that only remembered the last token would report this as `unknown_token` and
    // the compromise would read as a stale tab.
    await expect(
      service.refresh({
        refreshToken: first.refreshToken,
        csrfToken: csrf(first),
        correlationId: uuidv7(),
      }),
    ).rejects.toMatchObject({ code: 'reuse_detected' });
  });

  it('does not overwrite the reuse finding with a later routine sign-out', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    await service.refresh({
      refreshToken: started.refreshToken,
      csrfToken: csrf(started),
      correlationId: uuidv7(),
    });
    await service
      .refresh({
        refreshToken: started.refreshToken,
        csrfToken: csrf(started),
        correlationId: uuidv7(),
      })
      .catch(() => undefined);

    await service.revoke({
      sessionId: started.sessionId,
      reason: 'signed_out',
      correlationId: uuidv7(),
    });

    const rows = await observe('select revoked_reason from sessions where id = ?', [
      started.sessionId,
    ]);
    // A security finding must not be erased by an ordinary lifecycle event arriving later.
    expect(rows[0]?.['revoked_reason']).toBe(REUSE_REVOCATION_REASON);
  });

  it('rotates exactly once when the same token is presented twice at the storage layer', async () => {
    // The compare-and-swap, tested where it is deterministic. Two tabs refreshing at the same
    // instant both read the same live hash; the second `UPDATE` matches nothing and is told
    // it lost, rather than being handed a second live token for the same session.
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    const currentHash = hashRefreshToken(started.refreshToken);

    const outcomes = await tenant.identityTransaction(identity, async (tx) => {
      const first = await repository.rotate(tx, {
        sessionId: started.sessionId,
        currentHash,
        nextHash: hashRefreshToken(`next-a-${uuidv7()}`),
        issuedAt: new Date(),
      });
      const second = await repository.rotate(tx, {
        sessionId: started.sessionId,
        currentHash,
        nextHash: hashRefreshToken(`next-b-${uuidv7()}`),
        issuedAt: new Date(),
      });
      return [first, second];
    });

    expect(outcomes).toEqual([true, false]);
    const ledger = await observe(
      'select count(*) as n from session_refresh_tokens where session_id = ?',
      [started.sessionId],
    );
    expect(Number(ledger[0]?.['n'])).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the superseded-token ledger is append-only', () => {
  it('rejects an UPDATE, for every credential including the admin one', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    await service.refresh({
      refreshToken: started.refreshToken,
      csrfToken: csrf(started),
      correlationId: uuidv7(),
    });

    // The trigger, not the grant: this connection holds every privilege on the database.
    // An attacker who could rewrite their replayed hash would make a compromise look like a
    // typo, so the evidence has to be immutable rather than merely unwritable.
    await expect(
      db.admin.query('UPDATE session_refresh_tokens SET token_hash = ? WHERE session_id = ?', [
        'f'.repeat(64),
        started.sessionId,
      ]),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects a DELETE', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    await service.refresh({
      refreshToken: started.refreshToken,
      csrfToken: csrf(started),
      correlationId: uuidv7(),
    });

    await expect(
      db.admin.query('DELETE FROM session_refresh_tokens WHERE session_id = ?', [
        started.sessionId,
      ]),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses to record the same hash twice, whichever session claims it', async () => {
    const a = await service.start({ userId: userId(), correlationId: uuidv7() });
    await service.refresh({
      refreshToken: a.refreshToken,
      csrfToken: csrf(a),
      correlationId: uuidv7(),
    });

    await expect(
      db.admin.query(
        'INSERT INTO session_refresh_tokens (id, session_id, token_hash, issued_at, superseded_at)' +
          ' VALUES (?, ?, ?, now(3), now(3))',
        [uuidv7(), a.sessionId, hashRefreshToken(a.refreshToken)],
      ),
    ).rejects.toThrow(/duplicate/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('revocation and the device list', () => {
  it('ends every live session one person holds, and nobody else’s', async () => {
    const mine = [
      await service.start({ userId: userId(), correlationId: uuidv7() }),
      await service.start({ userId: userId(), correlationId: uuidv7() }),
    ];
    const theirs = await service.start({ userId: otherUserId(), correlationId: uuidv7() });

    const ended = await service.revokeAllForUser({
      userId: userId(),
      reason: 'offboarded',
      correlationId: uuidv7(),
    });
    expect(ended).toBeGreaterThanOrEqual(2);

    for (const session of mine) {
      await expect(
        service.authenticate({ accessToken: session.accessToken, correlationId: uuidv7() }),
      ).rejects.toMatchObject({ code: 'session_revoked' });
    }
    await expect(
      service.authenticate({ accessToken: theirs.accessToken, correlationId: uuidv7() }),
    ).resolves.toMatchObject({ userId: otherUserId() });
  });

  it('lists live sessions only, and carries no credential material', async () => {
    await service.revokeAllForUser({
      userId: userId(),
      reason: 'test_reset',
      correlationId: uuidv7(),
    });
    const live = await service.start({ userId: userId(), correlationId: uuidv7() });
    const dead = await service.start({ userId: userId(), correlationId: uuidv7() });
    await service.revoke({
      sessionId: dead.sessionId,
      reason: 'signed_out',
      correlationId: uuidv7(),
    });

    const listed = await service.listForUser({ userId: userId(), correlationId: uuidv7() });
    expect(listed.map((s) => s.id)).toEqual([live.sessionId]);
    // A device list that leaked a token hash would hand an XSS the material for offline
    // work against every session the victim holds.
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'rotatedAt',
      'userAgent',
    ]);
  });

  it('clears both cookies with the scoping they were set with', () => {
    const [access, refresh] = service.clearedCookies() as [string, string];
    expect(access).toBe('tmanage_session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure');
    // Path and SameSite must match or the browser leaves the original refresh cookie in
    // place — a sign-out that looks like it worked and did not.
    expect(refresh).toBe(
      'tmanage_session_refresh=; Path=/api/auth/refresh; Max-Age=0; SameSite=Strict; HttpOnly; Secure',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the identity path cannot reach tenant data', () => {
  it('refuses a statement that touches a tenant table', async () => {
    await expect(
      tenant.identityRead(identity, (tx) => tx.query('select id from organizations limit 1')),
    ).rejects.toBeInstanceOf(IdentityScopeViolation);
  });

  it('refuses it in observe mode too, where the guard would only record', async () => {
    // `TENANT_GUARD_MODE=observe` is set for a documented incident (ADR-0001 layer 3). It
    // must not turn the pre-authentication path into a route to every tenant's rows.
    await expect(
      observing.identityRead(identity, (tx) => tx.query('select id from projects limit 1')),
    ).rejects.toBeInstanceOf(IdentityScopeViolation);
  });

  it('refuses a write to a tenant table', async () => {
    await expect(
      tenant.identityTransaction(identity, (tx) =>
        tx.query('update work_items set title = ? where id = ?', ['x', 'y']),
      ),
    ).rejects.toBeInstanceOf(IdentityScopeViolation);
  });

  it('counts a tenant table the analyser cannot place', async () => {
    // The same fail-closed rule the bootstrap read uses: a name the guard could not
    // interpret is exactly the one that must not slip through.
    await expect(
      tenant.identityRead(identity, (tx) =>
        tx.query('select 1 from (select id from work_items) as t limit 1'),
      ),
    ).rejects.toBeInstanceOf(IdentityScopeViolation);
  });

  it('refuses to be declared over a table that is not registered as global', async () => {
    await expect(
      tenant.identityRead({ correlationId: uuidv7(), tables: ['projects'] }, async () => undefined),
    ).rejects.toBeInstanceOf(IdentityScopeViolation);
  });

  it('emits no guard event across a whole sign-in, authenticate and refresh cycle', async () => {
    guardEvents.length = 0;
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });
    await service.authenticate({ accessToken: started.accessToken, correlationId: uuidv7() });
    const rotated = await service.refresh({
      refreshToken: started.refreshToken,
      csrfToken: csrf(started),
      correlationId: uuidv7(),
    });
    await service.listForUser({ userId: userId(), correlationId: uuidv7() });
    await service.revoke({
      sessionId: rotated.sessionId,
      reason: 'signed_out',
      correlationId: uuidv7(),
    });

    // Not "no violations" — no events at all. The identity path is not an audited escape
    // hatch like the bootstrap read; it is ordinary guarded execution over tables the guard
    // has nothing to say about.
    expect(guardEvents).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * CSRF on the refresh path — ADR-0004.
 *
 * `CsrfGuard` cannot cover this route: a refresh request carries no access cookie, so there is
 * no session id to bind a token against until the refresh token has been looked up.
 * Verification therefore happens inside `SessionService.refresh()`, after the session is
 * resolved and **before** the rotation commits. These cases are what make that claim checkable
 * rather than a comment.
 */
describe('refresh verifies the CSRF token', () => {
  it('refuses a refresh with no CSRF token, and does not rotate', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });

    await expect(
      service.refresh({
        refreshToken: started.refreshToken,
        csrfToken: undefined,
        correlationId: uuidv7(),
      }),
    ).rejects.toMatchObject({ name: 'RefreshRejectedError', code: 'csrf_failed' });

    // The refusal must leave the credential usable: a CSRF failure is a rejected request, not
    // a compromised session. Rotating anyway would log the legitimate holder out.
    const rows = await observe(
      'select refresh_token_hash, rotated_at, revoked_at from sessions where id = ?',
      [started.sessionId],
    );
    expect(rows[0]?.['refresh_token_hash']).toBe(hashRefreshToken(started.refreshToken));
    expect(rows[0]?.['rotated_at']).toBeNull();
    expect(rows[0]?.['revoked_at']).toBeNull();
  });

  it('refuses a CSRF token minted for a different session', async () => {
    const mine = await service.start({ userId: userId(), correlationId: uuidv7() });
    const theirs = await service.start({ userId: otherUserId(), correlationId: uuidv7() });

    // This is the cookie-tossing case: the attacker holds a genuine, correctly-signed token —
    // their own. Binding it to a session id is what makes it useless against another one.
    await expect(
      service.refresh({
        refreshToken: mine.refreshToken,
        csrfToken: csrf(theirs),
        correlationId: uuidv7(),
      }),
    ).rejects.toMatchObject({ code: 'csrf_failed' });
  });

  it('refuses a CSRF token signed with the wrong secret', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });

    await expect(
      service.refresh({
        refreshToken: started.refreshToken,
        csrfToken: mintCsrfToken(started.sessionId, 'a different secret entirely'),
        correlationId: uuidv7(),
      }),
    ).rejects.toMatchObject({ code: 'csrf_failed' });
  });

  it('gives a CSRF failure the same message as every other refresh refusal', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });

    const messages = new Set<string>();
    for (const attempt of [
      { refreshToken: started.refreshToken, csrfToken: undefined },
      { refreshToken: undefined, csrfToken: undefined },
      { refreshToken: 'never issued', csrfToken: csrf(started) },
    ]) {
      await service.refresh({ ...attempt, correlationId: uuidv7() }).catch((error: unknown) => {
        expect(error).toBeInstanceOf(RefreshRejectedError);
        messages.add((error as Error).message);
      });
    }
    // A caller who can tell "your token is stale" from "your CSRF header is wrong" learns
    // which half of the pair they got right.
    expect(messages.size).toBe(1);
  });

  it('issues a CSRF token bound to the session, in a cookie the client can read', async () => {
    const started = await service.start({ userId: userId(), correlationId: uuidv7() });

    expect(started.csrfToken).toBe(mintCsrfToken(started.sessionId, CSRF_SECRET));

    const csrfCookie = started.cookies.find((c) => c.startsWith('tmanage_session_csrf='));
    expect(csrfCookie).toBeDefined();
    // The one cookie without HttpOnly, deliberately — the client has to echo it in a header.
    expect(csrfCookie).not.toMatch(/HttpOnly/);
    // Every other cookie keeps it.
    for (const cookie of started.cookies.filter((c) => !c.startsWith('tmanage_session_csrf='))) {
      expect(cookie).toMatch(/HttpOnly/);
    }
  });

  it('clears the CSRF cookie on sign-out alongside the credentials', async () => {
    const cleared = service.clearedCookies();
    expect(cleared).toHaveLength(3);
    expect(cleared.some((c) => c.startsWith('tmanage_session_csrf=') && /Max-Age=0/.test(c))).toBe(
      true,
    );
  });
});
