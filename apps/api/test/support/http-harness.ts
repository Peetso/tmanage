import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../../src/app.module.js';
import { DatabaseModule } from '../../src/common/database/database.module.js';
import { apiConfigFrom } from '../../src/common/http/api-config.js';
import type { ApiConfig } from '../../src/common/http/api-config.js';
import { startTestDatabase, truncateAll } from './test-database.js';
import type { TestDatabase } from './test-database.js';
import { seedTwoTenants } from '../seed-two-tenants.js';
import type { SeedWorld } from '../seed-two-tenants.js';

/**
 * The bootstrap every `*.db.test.ts` that drives the API over real HTTP shares: an injected
 * response shape, the two cookie helpers, the test `ApiConfig`, and the boot / sign-in /
 * reseed / teardown steps. Extracted verbatim from those suites — no behaviour is added here,
 * only the duplication removed. What differs per suite (route wrappers, `describe` bodies, the
 * `observe` reader) stays in the suite.
 */

/** The shape `app.inject()` returns, as the suites consume it. */
export interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
  json<T = unknown>(): T;
}

/** A signed-in principal: the cookie header to send and the CSRF token to echo. */
export interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

/** The `set-cookie` header, always as an array. */
export function setCookies(response: InjectedResponse): readonly string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

/** Fold `set-cookie` values into a single `Cookie` request header, dropping cleared cookies. */
export function cookieHeader(cookies: readonly string[]): string {
  return cookies
    .map((c) => c.split(';')[0] ?? '')
    .filter((pair) => pair.split('=').slice(1).join('=').length > 0)
    .join('; ');
}

/**
 * The `ApiConfig` the HTTP suites boot with. Identical across suites except the two secrets,
 * which only have to be present, long enough, and distinct — so they are derived from a
 * per-suite tag rather than repeated as literals.
 */
export function testApiConfig(secretTag: string): ApiConfig {
  return apiConfigFrom({
    NODE_ENV: 'test',
    ALLOW_DEV_SIGN_IN: true,
    SESSION_COOKIE_NAME: 'tmanage_session',
    SESSION_SECRET: `local_dev_only_session_secret_for_${secretTag}`.padEnd(48, 'x'),
    SESSION_TTL_SECONDS: 900,
    REFRESH_TTL_SECONDS: 1_209_600,
    CSRF_SECRET: `local_dev_only_csrf_secret_for_${secretTag}`.padEnd(48, 'x'),
    AUTH_MFA_SEED_KEYS: '1:local_dev_only_mfa_seed_key_change_me_00000',
    API_PUBLIC_URL: 'http://localhost:4000',
    AUTH_MAX_FAILURES_IN_WINDOW: 50,
    AUTH_FAILURE_WINDOW_SECONDS: 900,
    AUTH_TOTP_ISSUER: 'TManage',
    CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
  });
}

/**
 * Start a real database and a fully-initialised Nest+Fastify app over it, exactly as each
 * suite's `beforeAll` did: `startTestDatabase` → `NestFactory.create` → `init` → `ready`.
 */
export async function bootHttpHarness(opts: {
  secretTag: string;
  guardMode?: 'enforce' | 'observe';
}): Promise<{ app: NestFastifyApplication; db: TestDatabase }> {
  const db = await startTestDatabase();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: testApiConfig(opts.secretTag),
      database: DatabaseModule.forPool({
        pool: db.runtime,
        guardMode: opts.guardMode ?? 'enforce',
      }),
    }),
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, db };
}

/**
 * Sign in through the dev-only session route. `csrf` (the default) reads the CSRF token from
 * the response for suites that echo it on writes; suites that only need the cookie pass
 * `{ csrf: false }` and ignore the empty token.
 */
export async function signIn(
  app: NestFastifyApplication,
  userId: string,
  opts?: { csrf?: boolean },
): Promise<Session> {
  const response = (await app.inject({
    method: 'POST',
    url: '/v1/dev/sessions',
    headers: { 'content-type': 'application/json' },
    payload: { userId },
  })) as unknown as InjectedResponse;
  const cookie = cookieHeader(setCookies(response));
  const csrfToken = (opts?.csrf ?? true) ? response.json<{ csrfToken: string }>().csrfToken : '';
  return { cookie, csrfToken };
}

/** The suites' `beforeEach`: truncate everything, then seed the two-tenant world afresh. */
export async function reseed(db: TestDatabase): Promise<SeedWorld> {
  await truncateAll(db.admin);
  return seedTwoTenants(db.admin);
}

/** The suites' `afterAll`: close the app and stop the database, tolerating a failed boot. */
export async function stopHarness(handle: {
  app?: NestFastifyApplication;
  db?: TestDatabase;
}): Promise<void> {
  await handle.app?.close();
  await handle.db?.stop();
}
