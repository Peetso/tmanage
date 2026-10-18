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
 * CHAT-003 over real HTTP — the message-to-work conversion, and INT-07.
 *
 * FR-02: an authorized user converts a message into work; the source link is immutable;
 * title, owner, date and audience are confirmed at conversion; external sharing never
 * inherits internal visibility. What only a real database can prove:
 *
 * 1. **INT-07 under concurrency.** "Message conversion creates one linked work item on
 *    retry" is a property of `uq_message_work_links_message`, and the interesting case is
 *    two conversions arriving at once: the loser's whole transaction — second work item
 *    included — rolls back, and the loser is handed the winner's conversion.
 * 2. **The conversion is spent, not leased.** A second conversion after the first — even
 *    after the work item is soft-deleted — returns the original. One linked work item ever,
 *    not one at a time.
 * 3. **The link is immutable at the engine**, refused by trigger for any credential, and the
 *    runtime credential holds INSERT alone (the least-privilege file carries that half).
 * 4. **The audit row can name the source without naming it `source_message_id`** — `message`
 *    is a forbidden segment in `assertSafeAuditMetadata`, the hazard CHAT-001 recorded, so
 *    the key is `converted_from_id` and this suite asserts the row actually lands.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_msg_to_work_xxxxxxxxx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_msg_to_work_xxxxxxxxx';

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

const NORTHSTAR = 'northstar-studio';

async function sendTo(
  slug: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  session: Session,
  payload?: unknown,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url: `/v1/organizations/${slug}${path}`,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

async function send(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  session: Session,
  payload?: unknown,
): Promise<InjectedResponse> {
  return sendTo(NORTHSTAR, method, path, session, payload);
}

interface WorkItemClient {
  id: string;
  projectId: string;
  type: string;
  title: string;
  state: string;
  ownerUserId: string | null;
  audience: string;
  dueAt: string | null;
  deletedAt: string | null;
}

interface ConversionClient {
  workItem: WorkItemClient;
  messageId: string;
  convertedAt: string;
  created: boolean;
}

const owner = () => world.northstar.owner;
const manager = () => world.northstar.manager;
const designer = () => world.northstar.designer;

async function createChannel(session: Session): Promise<string> {
  const response = await send('POST', '/conversations', session, {
    projectId: world.northstar.projectId,
    name: 'atlas-relaunch',
  });
  if (response.statusCode !== 201) {
    throw new Error(`create channel failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<{ id: string }>().id;
}

async function postMessage(
  session: Session,
  conversationId: string,
  body: Record<string, unknown> = { body: 'Redo the hero image before Friday' },
): Promise<{ id: string; body: string | null }> {
  const response = await send('POST', `/conversations/${conversationId}/messages`, session, body);
  if (response.statusCode !== 201) {
    throw new Error(`post failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<{ id: string; body: string | null }>();
}

async function convert(
  session: Session,
  conversationId: string,
  messageId: string,
  body: Record<string, unknown> = {},
): Promise<InjectedResponse> {
  return send(
    'POST',
    `/conversations/${conversationId}/messages/${messageId}/work-items`,
    session,
    body,
  );
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

describe('converting a message into work', () => {
  it('creates the work item on the conversation’s project, titled by the message', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postMessage(session, channel);

    const response = await convert(session, channel, message.id);
    expect(response.statusCode).toBe(201);
    const conversion = response.json<ConversionClient>();

    expect(conversion.created).toBe(true);
    expect(conversion.messageId).toBe(message.id);
    expect(conversion.workItem.projectId).toBe(world.northstar.projectId);
    expect(conversion.workItem.title).toBe('Redo the hero image before Friday');
    expect(conversion.workItem.type).toBe('task');
    // FR-02: external sharing never inherits internal visibility automatically.
    expect(conversion.workItem.audience).toBe('internal');

    const links = await observe(
      'select message_id, work_item_id, created_by_user_id from message_work_links where message_id = ?',
      [message.id],
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.['work_item_id']).toBe(conversion.workItem.id);
    expect(links[0]?.['created_by_user_id']).toBe(manager().id);
  });

  it('confirms title, owner, audience and due date when the caller supplies them', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postMessage(session, channel);

    const response = await convert(session, channel, message.id, {
      title: 'Hero image redo',
      ownerUserId: designer().id,
      audience: 'client_visible',
      dueAt: '2026-09-04T17:00:00.000Z',
    });
    expect(response.statusCode).toBe(201);
    const conversion = response.json<ConversionClient>();
    expect(conversion.workItem.title).toBe('Hero image redo');
    expect(conversion.workItem.ownerUserId).toBe(designer().id);
    expect(conversion.workItem.audience).toBe('client_visible');
    expect(conversion.workItem.dueAt).toBe('2026-09-04T17:00:00.000Z');
  });

  it('titles from the first line only, and from the derived body of a rich message', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const rich = await postMessage(session, channel, {
      bodyRich: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Ship the ' },
              { type: 'text', text: 'banner', marks: [{ type: 'bold' }] },
            ],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'and then the rest' }] },
        ],
      },
    });

    const response = await convert(session, channel, rich.id);
    expect(response.statusCode).toBe(201);
    expect(response.json<ConversionClient>().workItem.title).toBe('Ship the banner');
  });

  it('writes the audit row with converted_from_id — not a key the metadata gate refuses', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postMessage(session, channel);

    const response = await convert(session, channel, message.id);
    expect(response.statusCode).toBe(201);
    const workItemId = response.json<ConversionClient>().workItem.id;

    const rows = await observe(
      `select metadata_json from audit_events where action = 'work_item.created' and object_id = ?`,
      [workItemId],
    );
    expect(rows).toHaveLength(1);
    const raw = rows[0]?.['metadata_json'];
    const metadata = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    expect(metadata['converted_from_id']).toBe(message.id);
    expect(metadata['conversation_id']).toBe(channel);
    expect(metadata['source_message_id']).toBeUndefined();
  });

  it('converts a reply as readily as a root message', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const root = await postMessage(session, channel);
    const reply = await postMessage(session, channel, {
      body: 'Actually just the mobile crop',
      parentMessageId: root.id,
    });

    const response = await convert(session, channel, reply.id);
    expect(response.statusCode).toBe(201);
    expect(response.json<ConversionClient>().workItem.title).toBe('Actually just the mobile crop');
  });
});

describe('INT-07 — one linked work item, ever', () => {
  it('a retry returns the existing conversion with a 200', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postMessage(session, channel);

    const first = await convert(session, channel, message.id);
    expect(first.statusCode).toBe(201);
    const retry = await convert(session, channel, message.id, { title: 'A different title' });
    expect(retry.statusCode).toBe(200);

    const original = first.json<ConversionClient>();
    const repeated = retry.json<ConversionClient>();
    expect(repeated.created).toBe(false);
    expect(repeated.workItem.id).toBe(original.workItem.id);
    // The retry's differing title did not rewrite anything: the first conversion is the one
    // that happened.
    expect(repeated.workItem.title).toBe(original.workItem.title);
  });

  it('two concurrent conversions produce one work item, and the loser is told', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postMessage(session, channel);

    const results = await Promise.all([
      convert(session, channel, message.id),
      convert(session, channel, message.id),
    ]);
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 201]);

    const ids = new Set(results.map((r) => r.json<ConversionClient>().workItem.id));
    expect(ids.size).toBe(1);

    // The loser's transaction rolled back whole: one link, and one work item on the project.
    const links = await observe('select 1 from message_work_links where message_id = ?', [
      message.id,
    ]);
    expect(links).toHaveLength(1);
    const items = await observe('select 1 from work_items where project_id = ?', [
      world.northstar.projectId,
    ]);
    expect(items).toHaveLength(2); // the seeded work item, plus exactly one conversion
  });

  it('the conversion is spent: a soft-deleted work item is still the answer', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postMessage(session, channel);

    const first = await convert(session, channel, message.id);
    const workItemId = first.json<ConversionClient>().workItem.id;
    await db.admin.query('update work_items set deleted_at = now(3) where id = ?', [workItemId]);

    const retry = await convert(session, channel, message.id);
    expect(retry.statusCode).toBe(200);
    const repeated = retry.json<ConversionClient>();
    expect(repeated.workItem.id).toBe(workItemId);
    expect(repeated.workItem.deletedAt).not.toBeNull();
  });
});

describe('what cannot be converted', () => {
  it('a taken-down message — its body is withheld and a title would read it back out', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postMessage(session, channel);
    const takedown = await send(
      'DELETE',
      `/conversations/${channel}/messages/${message.id}`,
      session,
    );
    expect(takedown.statusCode).toBe(200);

    const response = await convert(session, channel, message.id);
    expect(response.statusCode).toBe(409);

    const links = await observe('select 1 from message_work_links where message_id = ?', [
      message.id,
    ]);
    expect(links).toHaveLength(0);
  });

  it('a message on an archived project — nothing new is filed into one', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postMessage(session, channel);

    await db.admin.query('update projects set archived_at = now(3) where id = ?', [
      world.northstar.projectId,
    ]);

    const response = await convert(session, channel, message.id);
    expect(response.statusCode).toBe(409);
  });

  it('a message in a channel the caller is not in — the same 404 as the channel itself', async () => {
    const managerSession = await signIn(manager().id);
    const channel = await createChannel(managerSession);
    const message = await postMessage(managerSession, channel);

    // The designer is on the project but not in this channel. (CQ-12: the project team starts
    // in a new channel, so she is taken out first.)
    await send('DELETE', `/conversations/${channel}/members/${designer().id}`, managerSession);
    const designerSession = await signIn(designer().id);
    const response = await convert(designerSession, channel, message.id);
    expect(response.statusCode).toBe(404);
  });

  it('another tenant’s message, even holding every id', async () => {
    const managerSession = await signIn(manager().id);
    const channel = await createChannel(managerSession);
    const message = await postMessage(managerSession, channel);

    const twinSession = await signIn(world.twin.owner.id);
    const response = await sendTo(
      'northstar-studios',
      'POST',
      `/conversations/${channel}/messages/${message.id}/work-items`,
      twinSession,
      {},
    );
    expect(response.statusCode).toBe(404);

    const links = await observe('select 1 from message_work_links where message_id = ?', [
      message.id,
    ]);
    expect(links).toHaveLength(0);
  });

  it('a message id from a different channel is not found under this one', async () => {
    const session = await signIn(owner().id);
    const channel = await createChannel(session);
    const message = await postMessage(session, channel);

    const other = await send('POST', '/conversations', session, {
      projectId: world.northstar.otherProjectId,
      name: 'other-room',
    });
    const otherChannel = other.json<{ id: string }>().id;

    const response = await convert(session, otherChannel, message.id);
    expect(response.statusCode).toBe(404);
  });
});

describe('the source link is immutable', () => {
  it('refuses UPDATE at the engine, for any credential', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postMessage(session, channel);
    await convert(session, channel, message.id);

    await expect(
      db.admin.query('update message_work_links set work_item_id = ? where message_id = ?', [
        world.northstar.workItemId,
        message.id,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});
