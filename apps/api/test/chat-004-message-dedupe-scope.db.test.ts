import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * R03 / F4 over real HTTP — message idempotency must be bound to the conversation.
 *
 * `uq_messages_client_generated` is `(organization_id, author_user_id, client_generated_id)` and
 * does **not** include the conversation, so an author's client id is unique across every channel
 * they can write to. The review reproduced the leak with a probe: an author replays a client id
 * from a message they posted to one channel — even one they have since lost access to — through a
 * *different* channel, and the dedupe read, scoped only by author and key, returns the old
 * message body.
 *
 * The only place this can be proven end to end is here, against the real unique key and the real
 * repository read. The two assertions this suite exists for:
 *
 * 1. **A retry to the same channel still dedupes** — the fix must not break the happy path: the
 *    same client id twice in one channel yields one message and a 200.
 * 2. **A replay through another channel is refused, not served from the first** — the same client
 *    id in a different channel returns a 409 and never the first channel's body, and no second
 *    row is written.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_dedupe_suite_xxxx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_dedupe_suite_xxxxxxxx';

const CONFIG: ApiConfig = apiConfigFrom({
  NODE_ENV: 'test',
  ALLOW_DEV_SIGN_IN: true,
  SESSION_COOKIE_NAME: 'tmanage_session',
  SESSION_SECRET,
  SESSION_TTL_SECONDS: 900,
  REFRESH_TTL_SECONDS: 1_209_600,
  CSRF_SECRET,
  AUTH_MFA_SEED_KEYS: '1:local_dev_only_mfa_seed_key_change_me_00000',
  API_PUBLIC_URL: 'http://localhost:4000',
  AUTH_MAX_FAILURES_IN_WINDOW: 50,
  AUTH_FAILURE_WINDOW_SECONDS: 900,
  AUTH_TOTP_ISSUER: 'TManage',
  CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
});

const NORTHSTAR = 'northstar-studio';
const KEY = '00000000-0000-7000-8000-0000000000d1';

interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
  json<T = unknown>(): T;
}

interface Session {
  readonly cookie: string;
  readonly csrfToken: string;
}

interface ConversationClient {
  id: string;
  projectId: string;
  name: string;
  version: number;
}

interface MessageClient {
  id: string;
  conversationId: string;
  body: string | null;
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

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function signIn(userId: string): Promise<Session> {
  const response = (await app.inject({
    method: 'POST',
    url: '/v1/dev/sessions',
    headers: { 'content-type': 'application/json' },
    payload: { userId },
  })) as unknown as InjectedResponse;
  const cookies = setCookies(response);
  return {
    cookie: cookieHeader(cookies),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
  };
}

async function send(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  session: Session,
  payload?: unknown,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url: `/v1/organizations/${NORTHSTAR}${path}`,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

async function createChannel(
  session: Session,
  name: string,
  projectId: string,
): Promise<ConversationClient> {
  const response = await send('POST', '/conversations', session, { projectId, name });
  if (response.statusCode !== 201) {
    throw new Error(`create channel failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<ConversationClient>();
}

async function post(
  session: Session,
  conversationId: string,
  body: Record<string, unknown>,
): Promise<InjectedResponse> {
  return send('POST', `/conversations/${conversationId}/messages`, session, body);
}

const manager = () => world.northstar.manager;

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

describe('message idempotency is bound to the conversation', () => {
  it('still dedupes a retry to the same channel', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session, 'atlas-relaunch', world.northstar.projectId);

    const first = await post(session, channel.id, { body: 'Sent once', clientGeneratedId: KEY });
    const retry = await post(session, channel.id, { body: 'Sent once', clientGeneratedId: KEY });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json<MessageClient>().id).toBe(first.json<MessageClient>().id);

    const [row] = await observe('select count(*) as c from messages where organization_id = ?', [
      world.northstar.organizationId,
    ]);
    expect(Number(row?.['c'])).toBe(1);
  });

  it('refuses a key replayed through another channel and never returns the first body', async () => {
    const session = await signIn(manager().id);
    // Two channels on the same project; the manager is a member of both (creation adds the creator).
    const first = await createChannel(session, 'atlas-relaunch', world.northstar.projectId);
    const second = await createChannel(session, 'atlas-launch', world.northstar.projectId);

    const original = await post(session, first.id, {
      body: 'Only in the first',
      clientGeneratedId: KEY,
    });
    expect(original.statusCode).toBe(201);
    const originalId = original.json<MessageClient>().id;

    // The same client id, a different channel. Before the fix this returned the first channel's
    // message body with a 200; now the dedupe read is scoped to the destination, misses, and the
    // append collides on `uq_messages_client_generated`, which surfaces as a 409.
    const replay = await post(session, second.id, {
      body: 'Replayed into the second',
      clientGeneratedId: KEY,
    });

    expect(replay.statusCode).toBe(409);
    // The decisive assertion: the first channel's body did not come back through the second.
    expect(replay.body).not.toContain('Only in the first');
    expect(replay.body).not.toContain(originalId);

    // No second row was written; the replay changed nothing.
    const [row] = await observe('select count(*) as c from messages where organization_id = ?', [
      world.northstar.organizationId,
    ]);
    expect(Number(row?.['c'])).toBe(1);
    const stored = await observe('select conversation_id from messages where organization_id = ?', [
      world.northstar.organizationId,
    ]);
    expect(stored[0]?.['conversation_id']).toBe(first.id);
  });
});
