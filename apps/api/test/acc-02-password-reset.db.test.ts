import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import type { MailDelivery, Mailer, MailMessage } from '@tmanage/mail';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { MailerModule } from '../src/common/email/mailer.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * ACC-02 over real HTTP against MariaDB 11.8 (Hostinger's engine): a locked-out person asks
 * for a link, the link arrives, and spending it changes the password once, ends every session,
 * and writes the credential-change notice. The 30-minute expiry is computed and compared by the
 * database on one clock, which is why this suite runs against a real server.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const WEB_URL = 'https://app.tmanage.example';

const CONFIG: ApiConfig = apiConfigFrom({
  NODE_ENV: 'test',
  ALLOW_DEV_SIGN_IN: true,
  SESSION_COOKIE_NAME: 'tmanage_session',
  SESSION_SECRET: 'local_dev_only_session_secret_for_password_reset_xxxx',
  SESSION_TTL_SECONDS: 900,
  REFRESH_TTL_SECONDS: 1_209_600,
  CSRF_SECRET: 'local_dev_only_csrf_secret_for_password_reset_xxxxxxx',
  AUTH_MFA_SEED_KEYS: '1:local_dev_only_mfa_seed_key_change_me_00000',
  API_PUBLIC_URL: 'http://localhost:4000',
  AUTH_MAX_FAILURES_IN_WINDOW: 50,
  AUTH_FAILURE_WINDOW_SECONDS: 900,
  AUTH_TOTP_ISSUER: 'TManage',
  CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
  // Every request here comes from one address; the per-address window is not under test.
  RATE_LIMIT_CONTACT_MAX_REQUESTS: 1000,
});

class RecordingMailer implements Mailer {
  readonly messages: MailMessage[] = [];
  send(message: MailMessage): Promise<MailDelivery> {
    this.messages.push(message);
    return Promise.resolve('sent');
  }
}
const transport = new RecordingMailer();

interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  json<T = unknown>(): T;
}

async function post(url: string, payload: Record<string, unknown>): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload,
  })) as unknown as InjectedResponse;
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

/** The token out of the mailed link, the way the person's browser gets it. */
async function mailedToken(): Promise<string> {
  for (let attempt = 0; attempt < 50 && transport.messages.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const text = transport.messages.at(-1)?.text ?? '';
  const match = /\/recover\/([A-Za-z0-9_-]+)/u.exec(text);
  if (!match?.[1]) throw new Error(`no reset link in: ${text}`);
  return match[1];
}

beforeAll(async () => {
  db = await startTestDatabase();
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
      mailer: MailerModule.forMailer(transport, WEB_URL),
    }),
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 300_000);

beforeEach(async () => {
  transport.messages.length = 0;
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

describe('ACC-02 password reset', () => {
  it('mails a link, and the link sets a new password once and ends every session', async () => {
    const person = world.northstar.owner;
    await app.inject({
      method: 'POST',
      url: '/v1/dev/sessions',
      headers: { 'content-type': 'application/json' },
      payload: { userId: person.id },
    });

    const requested = await post('/v1/password-resets', { email: person.email.toUpperCase() });
    expect(requested.statusCode).toBe(202);
    expect(requested.json()).toEqual({ status: 'requested' });

    const token = await mailedToken();
    expect(transport.messages[0]?.to).toBe(person.email);
    expect(transport.messages[0]?.text).toContain(`${WEB_URL}/recover/${token}`);
    const stored = await observe('select token_hash from password_reset_tokens');
    expect(stored).toHaveLength(1);
    expect(stored[0]!['token_hash']).not.toBe(token);

    const done = await post('/v1/password-resets/completions', {
      token,
      password: 'violet-harbour-lantern-41',
    });
    expect(done.statusCode).toBe(204);

    expect(
      await observe('select user_id from user_passwords where user_id = ?', [person.id]),
    ).toHaveLength(1);
    expect(
      await observe('select id from sessions where user_id = ? and revoked_at is null', [
        person.id,
      ]),
    ).toHaveLength(0);
    expect(
      await observe(
        "select id from credential_change_notices where user_id = ? and action = 'password_set'",
        [person.id],
      ),
    ).toHaveLength(1);

    // Once.
    const again = await post('/v1/password-resets/completions', {
      token,
      password: 'another-harbour-lantern-42',
    });
    expect(again.statusCode).toBe(404);
  });

  it('answers the same for an unknown address and stores and sends nothing', async () => {
    const response = await post('/v1/password-resets', { email: 'nobody@example.test' });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'requested' });
    expect(await observe('select id from password_reset_tokens')).toHaveLength(0);
    expect(transport.messages).toHaveLength(0);
  });

  it('only the newest link works, and an expired one is refused', async () => {
    const person = world.northstar.owner;
    await post('/v1/password-resets', { email: person.email });
    const first = await mailedToken();
    transport.messages.length = 0;
    await post('/v1/password-resets', { email: person.email });
    const second = await mailedToken();

    const stale = await post('/v1/password-resets/completions', {
      token: first,
      password: 'violet-harbour-lantern-41',
    });
    expect(stale.statusCode).toBe(404);

    await db.admin.query(
      'update password_reset_tokens set expires_at = date_sub(current_timestamp(3), interval 1 minute) where used_at is null',
    );
    const expired = await post('/v1/password-resets/completions', {
      token: second,
      password: 'violet-harbour-lantern-41',
    });
    expect(expired.statusCode).toBe(404);
  });
});
