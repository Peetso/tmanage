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
import type { ApiConfig, ApiConfigSource } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { REAUTH_HEADER } from '../src/modules/identity/authentication.controller.js';
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

/**
 * The environment both applications in this file are built from. `D08`'s nested describe
 * below builds a second one that differs from this in its abuse budgets and nothing else.
 */
const ENV: ApiConfigSource = {
  NODE_ENV: 'test',
  SESSION_COOKIE_NAME: 'tmanage_session',
  SESSION_SECRET,
  SESSION_TTL_SECONDS: 900,
  REFRESH_TTL_SECONDS: 1_209_600,
  CSRF_SECRET,
  AUTH_MFA_SEED_KEYS: '1:local_dev_only_mfa_seed_key_change_me_00000',
  API_PUBLIC_URL: 'http://localhost:4000',
  AUTH_MAX_FAILURES_IN_WINDOW: 5,
  AUTH_FAILURE_WINDOW_SECONDS: 900,
  AUTH_TOTP_ISSUER: 'TManage',
  CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
  // `D08`, and deliberately far above anything this suite does: it posts to
  // `/v1/auth/password` some thirty times from the one address `light-my-request` invents,
  // and a production-sized budget here would throttle cases that are about factors, recovery
  // codes and re-authentication. The bound itself is proved below, on an application built
  // with a budget small enough to cross.
  RATE_LIMIT_AUTH_WINDOW_SECONDS: 300,
  RATE_LIMIT_AUTH_MAX_PER_SOURCE: 1000,
  RATE_LIMIT_AUTH_MAX_REQUESTS: 1000,
  RATE_LIMIT_AUTH_MAX_GLOBAL: 10_000,
};

const CONFIG: ApiConfig = apiConfigFrom(ENV);

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

/**
 * `D05`. Prove the person again inside `session` and return the header value the three
 * credential-changing routes require. The session must already hold `password`.
 */
async function proofFor(
  session: { cookie: string; csrfToken: string },
  password = PASSWORD,
): Promise<string> {
  const response = await post(
    '/v1/auth/reauth',
    { password },
    { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
  );
  if (response.statusCode !== 200) {
    throw new Error(`re-authentication failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<{ reauthToken: string }>().reauthToken;
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

  /**
   * `D08` — the source bound, over HTTP.
   *
   * A second application, because the budget is the thing under test and the one above is
   * deliberately unreachable. It differs from the outer application in three numbers and
   * nothing else: same modules, same pool (the precedent is `http-pipeline.db.test.ts`, which
   * builds a second application on `db.runtime` and closes it mid-suite), same seeded world.
   *
   * The control's map lives for the life of this application and is not truncated between
   * cases the way the tables are, so each case works from its **own** source address.
   */
  describe('the source bound', () => {
    /**
     * Small enough that a handful of posts crosses it; large enough for the lockout case
     * below, which needs `maxFailuresInWindow` failures *and* the attempt that is refused
     * before the source budget would have refused it first.
     *
     * That makes 6 a coupling, not a free choice: it is `AUTH_MAX_FAILURES_IN_WINDOW + 1` for
     * the `ENV` bag above (5 + 1). The lockout case spends five failures and then makes a sixth
     * post that must reach the lockout, so the source budget has to admit exactly six. Move
     * either number without the other and that case stops testing the lockout — but it fails
     * loudly rather than quietly, because the `locked_out` read-back below expects one row and
     * a source refusal writes `source_throttled` instead.
     */
    const MAX_PER_SOURCE = 6;

    const THROTTLED_CONFIG: ApiConfig = apiConfigFrom({
      ...ENV,
      RATE_LIMIT_AUTH_MAX_PER_SOURCE: MAX_PER_SOURCE,
      // Never the narrowest bound here: every case below names distinct accounts, so the
      // source key is the one that must fire and name itself.
      RATE_LIMIT_AUTH_MAX_REQUESTS: 100,
      RATE_LIMIT_AUTH_MAX_GLOBAL: 10_000,
    });

    let throttledApp: NestFastifyApplication;

    beforeAll(async () => {
      throttledApp = await NestFactory.create<NestFastifyApplication>(
        AppModule.register({
          config: THROTTLED_CONFIG,
          database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
        }),
        // Plain, with no `trustProxy`. That is not an oversight — see the proxy case below.
        new FastifyAdapter(),
        { logger: false, abortOnError: false },
      );
      await throttledApp.init();
      await throttledApp.getHttpAdapter().getInstance().ready();
    }, 300_000);

    afterAll(async () => {
      await throttledApp?.close();
    });

    /** A sign-in post from a chosen source address. `remoteAddress` is the socket's. */
    async function signIn(
      email: string,
      password: string,
      options: { from: string; headers?: Record<string, string> },
    ): Promise<InjectedResponse> {
      return (await throttledApp.inject({
        method: 'POST',
        url: '/v1/auth/password',
        remoteAddress: options.from,
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        payload: { email, password },
      })) as unknown as InjectedResponse;
    }

    /** Spend a source's whole budget on addresses no account holds. */
    async function spendBudget(from: string, tag: string): Promise<void> {
      for (let attempt = 0; attempt < MAX_PER_SOURCE; attempt += 1) {
        await signIn(`${tag}-${attempt}@northstar.example`, PASSWORD, { from });
      }
    }

    /**
     * The disclosure question the finding asks: a refusal must not tell an attacker whether
     * the address they typed exists. The lockout's 429 names a real account by definition;
     * the throttle's names nothing at all. If the two bodies differed, the difference would
     * be the oracle.
     */
    it('answers a throttled source exactly as it answers a locked-out account', async () => {
      await setPasswordFor(owner().id);

      for (let attempt = 0; attempt < THROTTLED_CONFIG.maxFailuresInWindow; attempt += 1) {
        await signIn(owner().email, 'wrong', { from: '198.51.100.20' });
      }
      const lockedOut = await signIn(owner().email, PASSWORD, { from: '198.51.100.20' });
      expect(lockedOut.statusCode).toBe(429);
      expect(lockedOut.json<{ error: { code: string } }>().error.code).toBe('rate_limited');

      // The 429 above must be the *lockout's*, not the throttle's, or this case would compare
      // one throttle to another and prove nothing. The reason never reaches the caller, so it
      // is read off the row the way the credentials suite reads it.
      const [lockoutRows] = await db.admin.query<RowDataPacket[]>(
        `select reason from authentication_events
          where user_id = ? and outcome = 'failed' and reason = 'locked_out'`,
        [owner().id],
      );
      expect(lockoutRows).toHaveLength(1);

      await spendBudget('198.51.100.21', 'sprayed');
      const throttled = await signIn(`sprayed-${MAX_PER_SOURCE}@northstar.example`, PASSWORD, {
        from: '198.51.100.21',
      });
      expect(throttled.statusCode).toBe(429);

      // Byte for byte, once the per-request correlation id is masked.
      expect(withoutCorrelationId(throttled)).toBe(withoutCorrelationId(lockedOut));
    });

    /**
     * 429, and never 401. A throttled caller told 401 would learn nothing about the account
     * but would learn that the password was wrong — and would keep trying, which is the cost
     * this finding is about.
     */
    it('refuses with 429 rate_limited, never a 401 and never a different message', async () => {
      const SOURCE = '198.51.100.22';

      const inside: number[] = [];
      for (let attempt = 0; attempt < MAX_PER_SOURCE; attempt += 1) {
        const response = await signIn(`ground-${attempt}@northstar.example`, PASSWORD, {
          from: SOURCE,
        });
        inside.push(response.statusCode);
      }
      // Inside the budget the answer is the ordinary 401 an unknown address has always got.
      expect(inside).toEqual(Array.from({ length: MAX_PER_SOURCE }, () => 401));

      const refused: string[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await signIn(`ground-over-${attempt}@northstar.example`, PASSWORD, {
          from: SOURCE,
        });
        expect(response.statusCode).toBe(429);
        expect(response.json<{ error: { code: string } }>().error.code).toBe('rate_limited');
        refused.push(withoutCorrelationId(response));
      }
      // One message for every refusal, so the number of attempts already made is not itself
      // reported back. Combined with the case above, that is also the lockout's message.
      expect(new Set(refused).size).toBe(1);
    });

    /**
     * The proxy behaviour the finding asks for explicitly.
     *
     * This suite's adapter is `new FastifyAdapter()` with **no** `trustProxy`, so
     * `request.ip` is the socket's address and `x-forwarded-for` is a header like any other.
     * Under `main.ts`'s `trustProxy: true` the third assertion below would flip: a caller
     * setting that header *would* move to a fresh bucket. That is `D09` — proxy headers
     * trusted unconditionally — and it is not D08's to fix; the account and global keys are
     * what hold while it stands.
     */
    it('gives each source its own budget, and does not read x-forwarded-for', async () => {
      const SOURCE = '198.51.100.23';
      await spendBudget(SOURCE, 'proxied');

      expect(
        (await signIn('proxied-over@northstar.example', PASSWORD, { from: SOURCE })).statusCode,
      ).toBe(429);

      // A genuinely different socket is a different bucket, spending none of the first's.
      expect(
        (await signIn('elsewhere@northstar.example', PASSWORD, { from: '198.51.100.24' }))
          .statusCode,
      ).toBe(401);

      // The same socket claiming to be somebody else buys nothing here.
      expect(
        (
          await signIn('spoofed@northstar.example', PASSWORD, {
            from: SOURCE,
            headers: { 'x-forwarded-for': '198.51.100.99' },
          })
        ).statusCode,
      ).toBe(429);
    });
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
      '/v1/auth/reauth',
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

    // `D05`: the designer proves themselves first, so the 404 below is the ownership answer
    // and not the re-authentication one.
    const designerSession = await developmentSession(designer().id);
    await post(
      '/v1/auth/password/set',
      { password: PASSWORD },
      { cookie: designerSession.cookie, [CSRF_HEADER]: designerSession.csrfToken },
    );
    const response = (await app.inject({
      method: 'DELETE',
      url: `/v1/auth/factors/${factorId}`,
      headers: {
        cookie: designerSession.cookie,
        [CSRF_HEADER]: designerSession.csrfToken,
        [REAUTH_HEADER]: await proofFor(designerSession),
      },
    })) as unknown as InjectedResponse;

    expect(response.statusCode).toBe(404);
  });

  it('issue a fresh set of recovery codes on request, behind fresh proof', async () => {
    const session = await developmentSession(owner().id);
    await post(
      '/v1/auth/password/set',
      { password: PASSWORD },
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );
    const response = await post(
      '/v1/auth/recovery-codes',
      {},
      {
        cookie: session.cookie,
        [CSRF_HEADER]: session.csrfToken,
        [REAUTH_HEADER]: await proofFor(session),
      },
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
      {
        cookie: session.cookie,
        [CSRF_HEADER]: session.csrfToken,
        [REAUTH_HEADER]: await proofFor(session),
      },
    );

    const [rows] = await db.admin.query<RowDataPacket[]>(
      'select action from authentication_events where user_id = ? order by occurred_at, id',
      [owner().id],
    );
    expect(rows.map((row) => row['action'])).toEqual([
      'password_set',
      'reauthentication',
      'recovery_codes_issued',
    ]);
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

/**
 * `D05` over HTTP. The three credential-changing routes answer **403 `reauthentication_required`**
 * without the `x-reauth-token` header, the session stays usable, and `POST /v1/auth/reauth`
 * is where the header's value comes from.
 */
describe('re-authentication over HTTP', () => {
  /** A session that already holds a password, so it has something to re-present. */
  async function establishedWithPassword(userId: string) {
    const session = await developmentSession(userId);
    const set = await post(
      '/v1/auth/password/set',
      { password: PASSWORD },
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );
    if (set.statusCode !== 204) throw new Error(`first password: ${set.statusCode} ${set.body}`);
    return session;
  }

  it('refuses an unauthenticated caller', async () => {
    const response = await post('/v1/auth/reauth', { password: PASSWORD });
    expect(response.statusCode).toBe(401);
  });

  it('answers 403 reauthentication_required when a password is changed without proof', async () => {
    const session = await establishedWithPassword(owner().id);
    const [before] = await db.admin.query<RowDataPacket[]>(
      'select password_hash from user_passwords where user_id = ?',
      [owner().id],
    );

    const response = await post(
      '/v1/auth/password/set',
      { password: 'a different quiet line' },
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'reauthentication_required',
    );
    const [after] = await db.admin.query<RowDataPacket[]>(
      'select password_hash from user_passwords where user_id = ?',
      [owner().id],
    );
    expect(after[0]!['password_hash']).toBe(before[0]!['password_hash']);

    // The session itself is untouched: the same cookie still reads the factor list.
    const still = (await app.inject({
      method: 'GET',
      url: '/v1/auth/factors',
      headers: { cookie: session.cookie },
    })) as unknown as InjectedResponse;
    expect(still.statusCode).toBe(200);
  });

  it('answers 403 for removing a factor and reissuing codes without proof', async () => {
    const session = await establishedWithPassword(owner().id);
    const begun = await post(
      '/v1/auth/factors/totp',
      { label: 'Owner phone' },
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );
    const { factorId } = begun.json<{ factorId: string }>();

    const removed = (await app.inject({
      method: 'DELETE',
      url: `/v1/auth/factors/${factorId}`,
      headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    })) as unknown as InjectedResponse;
    expect(removed.statusCode).toBe(403);
    expect(removed.json<{ error: { code: string } }>().error.code).toBe(
      'reauthentication_required',
    );

    const codes = await post(
      '/v1/auth/recovery-codes',
      {},
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );
    expect(codes.statusCode).toBe(403);
    expect(codes.json<{ error: { code: string } }>().error.code).toBe('reauthentication_required');
  });

  it('mints proof from the password, which then authorises the change in that session only', async () => {
    const session = await establishedWithPassword(owner().id);

    const minted = await post(
      '/v1/auth/reauth',
      { password: PASSWORD },
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );
    expect(minted.statusCode).toBe(200);
    const { reauthToken, expiresAt } = minted.json<{ reauthToken: string; expiresAt: string }>();
    expect(typeof reauthToken).toBe('string');
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    const changed = await post(
      '/v1/auth/password/set',
      { password: 'a different quiet line' },
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken, [REAUTH_HEADER]: reauthToken },
    );
    expect(changed.statusCode).toBe(204);

    // The same proof presented from a second session of the same person is refused.
    const other = await developmentSession(owner().id);
    const elsewhere = await post(
      '/v1/auth/recovery-codes',
      {},
      { cookie: other.cookie, [CSRF_HEADER]: other.csrfToken, [REAUTH_HEADER]: reauthToken },
    );
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json<{ error: { code: string } }>().error.code).toBe(
      'reauthentication_required',
    );
  });

  it('refuses a wrong password with the same body a wrong sign-in gets', async () => {
    const session = await establishedWithPassword(owner().id);

    const reauth = await post(
      '/v1/auth/reauth',
      { password: 'not the password' },
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );
    const signIn = await post('/v1/auth/password', {
      email: owner().email,
      password: 'not the password',
    });

    expect(reauth.statusCode).toBe(401);
    expect(withoutCorrelationId(reauth)).toBe(withoutCorrelationId(signIn));
  });

  it('rejects a missing password as a shape error', async () => {
    const session = await establishedWithPassword(owner().id);
    const response = await post(
      '/v1/auth/reauth',
      {},
      { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    );
    expect(response.statusCode).toBe(400);
  });
});

/**
 * `D06` over HTTP, as the review's acceptance reads: signed in on two devices, the password is
 * replaced on one, and the other's access *and* refresh credentials fail at once. The device
 * that proved itself keeps working, and the device list it reads afterwards has one entry.
 */
describe('replacing a password over HTTP ends the other devices', () => {
  async function devices(cookie: string): Promise<InjectedResponse> {
    return (await app.inject({
      method: 'GET',
      url: '/v1/sessions/current/devices',
      headers: { cookie },
    })) as unknown as InjectedResponse;
  }

  async function refresh(session: {
    cookie: string;
    csrfToken: string;
  }): Promise<InjectedResponse> {
    return (await app.inject({
      method: 'POST',
      url: '/v1/sessions/refresh',
      headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken },
    })) as unknown as InjectedResponse;
  }

  it('signs the other device out of access and refresh, and keeps the device in hand', async () => {
    const laptop = await developmentSession(owner().id);
    const phone = await developmentSession(owner().id);

    // The first password ends nothing: both devices still read the list, and it has two rows.
    const first = await post(
      '/v1/auth/password/set',
      { password: PASSWORD },
      { cookie: laptop.cookie, [CSRF_HEADER]: laptop.csrfToken },
    );
    expect(first.statusCode).toBe(204);
    expect((await devices(phone.cookie)).statusCode).toBe(200);
    expect((await devices(laptop.cookie)).json<{ sessions: unknown[] }>().sessions).toHaveLength(2);

    // Replaced from the laptop, with the laptop's own proof.
    const token = await proofFor(laptop);
    const replaced = await post(
      '/v1/auth/password/set',
      { password: 'a different quiet line' },
      { cookie: laptop.cookie, [CSRF_HEADER]: laptop.csrfToken, 'x-reauth-token': token },
    );
    expect(replaced.statusCode).toBe(204);

    // The phone is out — on the access credential and on the refresh credential alike.
    expect((await devices(phone.cookie)).statusCode).toBe(401);
    const refused = await refresh(phone);
    expect(refused.statusCode).toBe(401);
    expect(setCookies(refused).length).toBeGreaterThan(0);

    // The laptop is still in, and it is now the only device.
    const remaining = await devices(laptop.cookie);
    expect(remaining.statusCode).toBe(200);
    expect(remaining.json<{ sessions: unknown[] }>().sessions).toHaveLength(1);
    expect((await refresh(laptop)).statusCode).toBe(200);

    const [rows] = await db.admin.query<RowDataPacket[]>(
      'select revoked_reason from sessions where user_id = ? and revoked_at is not null',
      [owner().id],
    );
    expect(rows.map((row) => row['revoked_reason'])).toEqual(['password_changed']);
  });
});
