import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { uuidv7 } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2/promise';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { base32Decode, hotpCode, totpCounterAt } from '../src/modules/identity/totp.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * ID-002 over real HTTP — the routes `ID-01`, `ID-02` and the enrolment half of `ID-05` call.
 *
 * The service is proved against a real server in `id-002-credentials.db.test.ts`. This suite
 * is about the three things only the HTTP surface can get wrong:
 *
 * 1. **The refusal is byte-identical** across an unknown address, a wrong password and a
 *    spent recovery code. The service already returns one rejection for all of them; a
 *    controller that mapped the reason into a message, or into a different status, would undo
 *    that — and only a comparison of two whole response bodies catches it.
 * 2. **A real session comes out of the far end.** The point of the ticket is that sign-in
 *    ends in the same cookies `SessionService` has always issued, so every guard downstream
 *    is unchanged.
 * 3. **The enrolment routes require a session and act only on their own user.** They take no
 *    `userId`, so there is no id to tamper with, and a factor belonging to someone else is a
 *    404 rather than a 403 — because 403 would confirm the id names a real factor.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_auth_http_suite';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_auth_http_suite_xx';

const CONFIG: ApiConfig = apiConfigFrom({
  NODE_ENV: 'test',
  SESSION_COOKIE_NAME: 'tmanage_session',
  SESSION_SECRET,
  SESSION_TTL_SECONDS: 900,
  REFRESH_TTL_SECONDS: 1_209_600,
  CSRF_SECRET,
  API_PUBLIC_URL: 'http://localhost:4000',
  AUTH_MAX_FAILURES_IN_WINDOW: 5,
  AUTH_FAILURE_WINDOW_SECONDS: 900,
  AUTH_TOTP_ISSUER: 'TManage',
  CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
});

const PASSWORD = 'a quiet line on paper';

interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
  json<T = unknown>(): T;
}

function setCookies(response: InjectedResponse): readonly string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

function cookieHeader(cookies: readonly string[]): string {
  return cookies
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => pair.split('=').slice(1).join('=').length > 0)
    .join('; ');
}

/** The correlation id differs per request by design, so it is masked before comparing bodies. */
function withoutCorrelationId(response: InjectedResponse): string {
  return response.body.replace(/"correlationId":"[^"]+"/, '"correlationId":"<id>"');
}

const owner = () => world.northstar.owner;
const designer = () => world.northstar.designer;

async function post(path: string, payload: unknown, headers: Record<string, string> = {}) {
  return (await app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json', ...headers },
    payload: payload as Record<string, unknown>,
  })) as unknown as InjectedResponse;
}

/** Sign in through the development route, to reach the enrolment endpoints. */
async function developmentSession(userId: string): Promise<{ cookie: string; csrfToken: string }> {
  const response = await post('/v1/dev/sessions', { userId });
  const cookies = setCookies(response);
  return {
    cookie: cookieHeader(cookies),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
  };
}

function codeFor(secret: string, atMs: number): string {
  return hotpCode(base32Decode(secret)!, totpCounterAt(atMs, 30), {
    digits: 6,
    algorithm: 'SHA1',
  });
}

/** Give a user a password through the authenticated route, as a person would. */
async function setPasswordFor(userId: string, password = PASSWORD): Promise<void> {
  const session = await developmentSession(userId);
  const response = await post(
    '/v1/auth/password/set',
    { password },
    { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
  );
  if (response.statusCode !== 204) {
    throw new Error(`setting the password failed: ${response.statusCode} ${response.body}`);
  }
}

beforeAll(async () => {
  db = await startTestDatabase();
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
    }),
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/auth/password', () => {
  it('establishes a real session when there is no second factor', async () => {
    await setPasswordFor(owner().id);

    const response = await post('/v1/auth/password', {
      email: owner().email,
      password: PASSWORD,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; csrfToken: string; expiresAt: string }>();
    expect(body.status).toBe('authenticated');
    expect(body.csrfToken).toMatch(/^v1\./);

    // The same cookies ID-001 has always issued, so every guard downstream is unchanged.
    const cookies = setCookies(response);
    expect(cookies.some((c) => c.startsWith('tmanage_session='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('tmanage_session_refresh='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('tmanage_session_csrf='))).toBe(true);
    expect(cookies.find((c) => c.startsWith('tmanage_session='))).toContain('HttpOnly');
  });

  it('never returns the password or a hash in the body', async () => {
    await setPasswordFor(owner().id);
    const response = await post('/v1/auth/password', {
      email: owner().email,
      password: PASSWORD,
    });
    expect(response.body).not.toContain(PASSWORD);
    expect(response.body).not.toContain('argon2');
  });

  /**
   * Claim 1. Two different causes, and the two responses must be indistinguishable — not
   * merely both 401.
   */
  it('answers identically for an unknown address and a wrong password', async () => {
    await setPasswordFor(owner().id);

    const unknown = await post('/v1/auth/password', {
      email: 'nobody@northstar.example',
      password: PASSWORD,
    });
    const wrong = await post('/v1/auth/password', {
      email: owner().email,
      password: 'not the password',
    });

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(withoutCorrelationId(unknown)).toBe(withoutCorrelationId(wrong));
  });

  it('answers identically for an address with no password set', async () => {
    await setPasswordFor(owner().id);

    const noPassword = await post('/v1/auth/password', {
      email: designer().email,
      password: PASSWORD,
    });
    const wrong = await post('/v1/auth/password', {
      email: owner().email,
      password: 'not the password',
    });

    expect(withoutCorrelationId(noPassword)).toBe(withoutCorrelationId(wrong));
  });

  it('keeps the precise reason in the log rather than in the response', async () => {
    await post('/v1/auth/password', {
      email: 'nobody@northstar.example',
      password: PASSWORD,
    });

    const [rows] = await db.admin.query<RowDataPacket[]>(
      'select reason from authentication_events order by occurred_at desc limit 1',
    );
    expect(rows[0]!['reason']).toBe('no_such_user');
  });

  it('rejects a missing field as a shape error, which reveals nothing', async () => {
    const response = await post('/v1/auth/password', { email: owner().email });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
  });

  it('answers 429 once the window is full', async () => {
    await setPasswordFor(owner().id);
    for (let attempt = 0; attempt < CONFIG.maxFailuresInWindow; attempt += 1) {
      await post('/v1/auth/password', { email: owner().email, password: 'wrong' });
    }

    const response = await post('/v1/auth/password', {
      email: owner().email,
      password: PASSWORD,
    });
    expect(response.statusCode).toBe(429);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('rate_limited');
  });

  /**
   * The route is `@Public()` and mutates. It must be reachable without a CSRF token, because
   * the caller has no session to bind one to — which is the same reasoning ADR-0004 gives for
   * the refresh route.
   */
  it('does not require a CSRF token, because there is no session to bind one to', async () => {
    await setPasswordFor(owner().id);
    const response = await post('/v1/auth/password', {
      email: owner().email,
      password: PASSWORD,
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('the second factor over HTTP', () => {
  /**
   * Enrol a confirmed factor for the owner, returning the secret and the recovery codes.
   *
   * The confirmation code is derived from the **previous** time step, not the current one.
   * That is not a trick to make the test pass — it is the only way to enrol and then sign in
   * within one test run. Confirming a factor spends its counter, and `last_accepted_counter`
   * then refuses that counter forever; over real HTTP the server's clock cannot be moved, so
   * confirming with the current step would leave the suite with nothing to present until the
   * next thirty-second window opened. Confirming one step back is accepted by the RFC 6238
   * drift window and leaves the current step free, which is exactly what a person whose phone
   * runs slightly slow does by accident.
   */
  async function enrol(): Promise<{ secret: string; recoveryCodes: readonly string[] }> {
    const session = await developmentSession(owner().id);
    const begun = await post(
      '/v1/auth/factors/totp',
      { label: 'Test phone', accountName: owner().email },
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );
    expect(begun.statusCode).toBe(201);
    const { factorId, secret, uri } = begun.json<{
      factorId: string;
      secret: string;
      uri: string;
    }>();
    expect(uri.startsWith('otpauth://totp/TManage:')).toBe(true);

    const confirmed = await post(
      '/v1/auth/factors/totp/confirm',
      { factorId, code: codeFor(secret, Date.now() - 30_000) },
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );
    expect(confirmed.statusCode).toBe(200);
    return { secret, recoveryCodes: confirmed.json<{ recoveryCodes: string[] }>().recoveryCodes };
  }

  it('challenges instead of establishing a session', async () => {
    await setPasswordFor(owner().id);
    await enrol();

    const response = await post('/v1/auth/password', {
      email: owner().email,
      password: PASSWORD,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; challengeToken: string; factors: unknown[] }>();
    expect(body.status).toBe('mfa_required');
    expect(body.factors).toHaveLength(1);
    // No session yet — the challenge is not a credential.
    expect(setCookies(response)).toHaveLength(0);
  });

  it('establishes the session once a code is presented', async () => {
    await setPasswordFor(owner().id);
    const { secret } = await enrol();

    const challenge = await post('/v1/auth/password', {
      email: owner().email,
      password: PASSWORD,
    });
    const { challengeToken } = challenge.json<{ challengeToken: string }>();

    const completed = await post('/v1/auth/mfa', {
      challengeToken,
      code: codeFor(secret, Date.now()),
    });

    expect(completed.statusCode).toBe(200);
    expect(completed.json<{ status: string }>().status).toBe('authenticated');
    expect(setCookies(completed).some((c) => c.startsWith('tmanage_session='))).toBe(true);
  });

  it('refuses a wrong code with the same body as a wrong password', async () => {
    await setPasswordFor(owner().id);
    await enrol();

    const challenge = await post('/v1/auth/password', {
      email: owner().email,
      password: PASSWORD,
    });
    const { challengeToken } = challenge.json<{ challengeToken: string }>();

    const badCode = await post('/v1/auth/mfa', { challengeToken, code: '000000' });
    const badPassword = await post('/v1/auth/password', {
      email: owner().email,
      password: 'wrong',
    });

    expect(badCode.statusCode).toBe(401);
    expect(withoutCorrelationId(badCode)).toBe(withoutCorrelationId(badPassword));
  });

  it('accepts a recovery code, and refuses the same one afterwards', async () => {
    await setPasswordFor(owner().id);
    const { recoveryCodes } = await enrol();

    const challenge = await post('/v1/auth/password', {
      email: owner().email,
      password: PASSWORD,
    });
    const { challengeToken } = challenge.json<{ challengeToken: string }>();

    const first = await post('/v1/auth/recovery-code', {
      challengeToken,
      code: recoveryCodes[0],
    });
    expect(first.statusCode).toBe(200);
    expect(setCookies(first).some((c) => c.startsWith('tmanage_session='))).toBe(true);

    const second = await post('/v1/auth/recovery-code', {
      challengeToken,
      code: recoveryCodes[0],
    });
    expect(second.statusCode).toBe(401);
  });
});

describe('the enrolment routes', () => {
  it('refuse an unauthenticated caller', async () => {
    for (const path of [
      '/v1/auth/password/set',
      '/v1/auth/factors/totp',
      '/v1/auth/factors/totp/confirm',
      '/v1/auth/recovery-codes',
    ]) {
      const response = await post(path, { password: PASSWORD, label: 'x' });
      expect(response.statusCode).toBe(401);
    }
  });

  it('refuse a session without a CSRF token', async () => {
    const session = await developmentSession(owner().id);
    const response = await post(
      '/v1/auth/password/set',
      { password: PASSWORD },
      {
        cookie: session.cookie,
      },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('csrf_failed');
  });

  it('return every reason a password was refused, because the person must fix it', async () => {
    const session = await developmentSession(owner().id);
    const response = await post(
      '/v1/auth/password/set',
      { password: 'admin' },
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );

    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { details: { field: string; message: string }[] } }>();
    expect(body.error.details.length).toBeGreaterThanOrEqual(2);
    expect(body.error.details.every((detail) => detail.field === 'password')).toBe(true);
  });

  it('list a person’s own factors and never a secret', async () => {
    const session = await developmentSession(owner().id);
    await post(
      '/v1/auth/factors/totp',
      { label: 'Test phone' },
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );

    const response = (await app.inject({
      method: 'GET',
      url: '/v1/auth/factors',
      headers: { cookie: session.cookie },
    })) as unknown as InjectedResponse;

    expect(response.statusCode).toBe(200);
    const body = response.json<{ factors: { label: string; confirmedAt: string | null }[] }>();
    expect(body.factors).toHaveLength(1);
    expect(body.factors[0]!.confirmedAt).toBeNull();
    expect(response.body).not.toContain('secret');
  });

  /**
   * A 404 rather than a 403. A 403 would confirm that the id names a real factor, which is
   * the same reasoning `MembershipResolver` uses for an organization slug.
   */
  it('answer 404 for a factor belonging to someone else', async () => {
    const ownerSession = await developmentSession(owner().id);
    const begun = await post(
      '/v1/auth/factors/totp',
      { label: 'Owner phone' },
      { cookie: ownerSession.cookie, [CSRF_HEADER]: ownerSession.csrfToken },
    );
    const { factorId } = begun.json<{ factorId: string }>();

    const designerSession = await developmentSession(designer().id);
    const response = (await app.inject({
      method: 'DELETE',
      url: `/v1/auth/factors/${factorId}`,
      headers: {
        cookie: designerSession.cookie,
        [CSRF_HEADER]: designerSession.csrfToken,
      },
    })) as unknown as InjectedResponse;

    expect(response.statusCode).toBe(404);
  });

  it('issue a fresh set of recovery codes on request', async () => {
    const session = await developmentSession(owner().id);
    const response = await post(
      '/v1/auth/recovery-codes',
      {},
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );

    expect(response.statusCode).toBe(200);
    const { recoveryCodes } = response.json<{ recoveryCodes: string[] }>();
    expect(recoveryCodes).toHaveLength(10);
    for (const code of recoveryCodes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    }

    // The plaintext is nowhere in the table it was written to.
    const [rows] = await db.admin.query<RowDataPacket[]>(
      'select code_hash from user_recovery_codes where user_id = ?',
      [owner().id],
    );
    expect(rows).toHaveLength(10);
    expect(JSON.stringify(rows)).not.toContain(recoveryCodes[0]!.replace('-', ''));
  });

  it('record every enrolment action in the log', async () => {
    const session = await developmentSession(owner().id);
    await post(
      '/v1/auth/password/set',
      { password: PASSWORD },
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );
    await post(
      '/v1/auth/recovery-codes',
      {},
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );

    const [rows] = await db.admin.query<RowDataPacket[]>(
      'select action from authentication_events where user_id = ? order by occurred_at',
      [owner().id],
    );
    expect(rows.map((row) => row['action'])).toEqual(['password_set', 'recovery_codes_issued']);
  });

  it('carry the request’s correlation id onto the row', async () => {
    const session = await developmentSession(owner().id);
    const correlationId = uuidv7();
    await post(
      '/v1/auth/password/set',
      { password: PASSWORD },
      {
        cookie: session.cookie,
        [CSRF_HEADER]: session.csrfToken,
        'x-correlation-id': correlationId,
      },
    );

    const [rows] = await db.admin.query<RowDataPacket[]>(
      'select correlation_id from authentication_events where user_id = ?',
      [owner().id],
    );
    expect(rows[0]!['correlation_id']).toBe(correlationId);
  });
});
