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
import {
  startTestDatabase,
  truncateAll,
  usingLeastPrivilegeCredential,
} from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * CHAT-001 over real HTTP — conversations, messages and the thread sequence model.
 *
 * Five tickets built a client request loop that works at both ends and cannot hold a
 * conversation. `13-ENGINEERING` §5 has named `conversations`, `conversation_memberships` and
 * `messages` since the plan was written and none of them existed.
 *
 * Eight things only this suite can prove:
 *
 * 1. **The sequence is monotonic per conversation** — `23-ERD` §4 and INT-08 — and it holds
 *    under *concurrent* appends, which is the only interesting case and the one an assertion
 *    about a single writer cannot reach.
 * 2. **A thread is exactly one level deep, and InnoDB is what refuses the second level.** The
 *    foreign key is the mechanism; this proves it fires through the whole application.
 * 3. **Conversation membership narrows and never widens.** A person on the project who is not
 *    in the channel cannot read it; an Owner with organization-wide scope can read it without
 *    a membership row; and no membership admits a client principal or another tenant.
 * 4. **A client principal cannot reach any of it**, on the ceiling, before any of this
 *    module's code runs.
 * 5. **Moderation removes the body and keeps the row.** `users.sql` grants no DELETE on
 *    `messages`, and the projection returns `body: null` rather than the text with a flag.
 * 6. **Nobody can rewrite somebody else's words.** A moderator may take a message down; only
 *    its author may edit it.
 * 7. **Retry dedupe.** The same client-generated id twice yields one message and a 200.
 * 8. **A message is not an audit event and a moderation is.** The absence is asserted, because
 *    a row per message is a decision this ticket made deliberately and a later author would
 *    otherwise "fix" it.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_chat_suite_xxxxxx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_chat_suite_xxxxxxxxx';

const CONFIG: ApiConfig = apiConfigFrom({
  NODE_ENV: 'test',
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

interface ConversationClient {
  id: string;
  projectId: string;
  name: string;
  createdByUserId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface MessageClient {
  id: string;
  conversationId: string;
  authorUserId: string;
  sequenceNo: number;
  parentMessageId: string | null;
  body: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  deletedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * An error body with the one field that is allowed to differ removed.
 *
 * `correlationId` is generated per request, so comparing two whole bodies would fail even
 * where the refusals are genuinely identical — which is the property these comparisons exist
 * to prove.
 */
function indistinguishable(response: InjectedResponse): unknown {
  const body = response.json<{ error: Record<string, unknown> }>();
  const { correlationId: _ignored, ...rest } = body.error;
  return rest;
}

const owner = () => world.northstar.owner;
const manager = () => world.northstar.manager;
const designer = () => world.northstar.designer;

/** Create a channel as the manager, the ordinary case every other test starts from. */
async function createChannel(
  session: Session,
  overrides: Record<string, unknown> = {},
): Promise<ConversationClient> {
  const response = await send('POST', '/conversations', session, {
    projectId: world.northstar.projectId,
    name: 'atlas-relaunch',
    ...overrides,
  });
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

async function postOrThrow(
  session: Session,
  conversationId: string,
  body: Record<string, unknown>,
): Promise<MessageClient> {
  const response = await post(session, conversationId, body);
  if (response.statusCode !== 201) {
    throw new Error(`post failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<MessageClient>();
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

describe('creating a channel', () => {
  it('creates it on the project, and puts its creator in it', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);

    expect(channel.projectId).toBe(world.northstar.projectId);
    expect(channel.name).toBe('atlas-relaunch');
    expect(channel.createdByUserId).toBe(manager().id);
    expect(channel.version).toBe(1);
    expect(channel.archivedAt).toBeNull();

    const members = await send('GET', `/conversations/${channel.id}/members`, session);
    expect(members.json<{ members: { userId: string }[] }>().members).toEqual([
      { userId: manager().id, joinedAt: expect.any(String) },
    ]);
  });

  it('echoes no tenant identifier', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    expect(JSON.stringify(channel)).not.toContain(world.northstar.organizationId);
  });

  it('strips the presentational hash, so #general and general are one channel', async () => {
    const session = await signIn(manager().id);
    const first = await createChannel(session, { name: '#general' });
    expect(first.name).toBe('general');

    const second = await send('POST', '/conversations', session, {
      projectId: world.northstar.projectId,
      name: 'general',
    });
    expect(second.statusCode).toBe(409);
  });

  it('refuses a second channel with the same name on the same project', async () => {
    const session = await signIn(manager().id);
    await createChannel(session);
    const again = await send('POST', '/conversations', session, {
      projectId: world.northstar.projectId,
      name: 'atlas-relaunch',
    });
    expect(again.statusCode).toBe(409);
  });

  it('allows the same name on a different project', async () => {
    const session = await signIn(owner().id);
    await createChannel(session);
    const other = await send('POST', '/conversations', session, {
      projectId: world.northstar.otherProjectId,
      name: 'atlas-relaunch',
    });
    expect(other.statusCode).toBe(201);
  });

  it('refuses a project this principal is not on, with the same 404 as one that does not exist', async () => {
    // Lina is a member of `atlasProject` and not of `otherProjectId`.
    const session = await signIn(designer().id);
    const notMine = await send('POST', '/conversations', session, {
      projectId: world.northstar.otherProjectId,
      name: 'somewhere-else',
    });
    const notReal = await send('POST', '/conversations', session, {
      projectId: world.twin.projectId,
      name: 'somewhere-else',
    });

    expect(notMine.statusCode).toBe(404);
    expect(notReal.statusCode).toBe(404);
    // `correlationId` is per request and is the one field that legitimately differs.
    expect(indistinguishable(notMine)).toEqual(indistinguishable(notReal));
  });

  it('refuses an empty name and a missing project, naming the fields', async () => {
    const session = await signIn(manager().id);
    const response = await send('POST', '/conversations', session, { name: '   ' });
    expect(response.statusCode).toBe(400);
    const fields = response
      .json<{ error: { details: { field: string }[] } }>()
      .error.details.map((d) => d.field)
      .sort();
    expect(fields).toEqual(['name', 'projectId']);
  });

  it('records the creation, in the same transaction', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);

    const rows = await observe(
      `select action, object_id, object_type, result from audit_events
        where organization_id = ? and action = 'conversation.created'`,
      [world.northstar.organizationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['object_id']).toBe(channel.id);
    expect(rows[0]?.['object_type']).toBe('conversation');
    expect(rows[0]?.['result']).toBe('allowed');
  });
});

describe('the sequence number', () => {
  it('starts at 1 and increases by one, per conversation', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);

    const first = await postOrThrow(session, channel.id, { body: 'One' });
    const second = await postOrThrow(session, channel.id, { body: 'Two' });
    const third = await postOrThrow(session, channel.id, { body: 'Three' });

    expect([first.sequenceNo, second.sequenceNo, third.sequenceNo]).toEqual([1, 2, 3]);
  });

  it('is per conversation, not global', async () => {
    const session = await signIn(manager().id);
    const one = await createChannel(session, { name: 'one' });
    const two = await createChannel(session, { name: 'two' });

    await postOrThrow(session, one.id, { body: 'In one' });
    const inTwo = await postOrThrow(session, two.id, { body: 'In two' });

    expect(inTwo.sequenceNo).toBe(1);
  });

  /**
   * INT-08, and the only case worth the machinery. A single writer would pass with
   * `MAX(sequence_no) + 1`; ten concurrent writers are what the conversation's row lock is for.
   */
  it('hands out no number twice under concurrent posting', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => post(session, channel.id, { body: `Message ${i}` })),
    );

    for (const response of responses) expect(response.statusCode).toBe(201);
    const numbers = responses.map((r) => r.json<MessageClient>().sequenceNo).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('is not a field a caller can supply', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel.id, { body: 'Hello', sequenceNo: 99 });
    expect(message.sequenceNo).toBe(1);
  });

  it('reads back in order', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    await postOrThrow(session, channel.id, { body: 'One' });
    await postOrThrow(session, channel.id, { body: 'Two' });

    const listed = await send('GET', `/conversations/${channel.id}/messages`, session);
    const bodies = listed.json<{ messages: MessageClient[] }>().messages.map((m) => m.body);
    expect(bodies).toEqual(['One', 'Two']);
  });
});

describe('threads', () => {
  it('accepts a reply to a top-level message, and keeps it out of the channel view', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const root = await postOrThrow(session, channel.id, { body: 'The question' });
    const reply = await postOrThrow(session, channel.id, {
      body: 'The answer',
      parentMessageId: root.id,
    });

    expect(reply.parentMessageId).toBe(root.id);

    const channelView = await send('GET', `/conversations/${channel.id}/messages`, session);
    expect(channelView.json<{ messages: MessageClient[] }>().messages.map((m) => m.id)).toEqual([
      root.id,
    ]);

    const thread = await send(
      'GET',
      `/conversations/${channel.id}/messages?parentMessageId=${root.id}`,
      session,
    );
    expect(thread.json<{ messages: MessageClient[] }>().messages.map((m) => m.id)).toEqual([
      reply.id,
    ]);
  });

  /** The invariant `fk_messages_parent_is_root` exists for. */
  it('refuses a reply to a reply', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const root = await postOrThrow(session, channel.id, { body: 'The question' });
    const reply = await postOrThrow(session, channel.id, {
      body: 'The answer',
      parentMessageId: root.id,
    });

    const nested = await post(session, channel.id, {
      body: 'A follow-up to the answer',
      parentMessageId: reply.id,
    });

    expect(nested.statusCode).toBe(422);
    expect(nested.json<{ error: { details: { field: string }[] } }>().error.details[0]?.field).toBe(
      'parentMessageId',
    );
  });

  it('refuses a parent that does not exist, with the same answer as a parent that is a reply', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const root = await postOrThrow(session, channel.id, { body: 'The question' });
    const reply = await postOrThrow(session, channel.id, {
      body: 'The answer',
      parentMessageId: root.id,
    });

    const nested = await post(session, channel.id, { body: 'x', parentMessageId: reply.id });
    const absent = await post(session, channel.id, {
      body: 'x',
      parentMessageId: '00000000-0000-7000-8000-000000000000',
    });

    expect(nested.statusCode).toBe(422);
    expect(absent.statusCode).toBe(422);
    expect(indistinguishable(nested)).toEqual(indistinguishable(absent));
  });

  /**
   * The engine, on a direct SQL session. ADR-0001 layers 3 and 4 are application-side, so the
   * rule that matters most is the one InnoDB holds without them.
   */
  it('refuses a nested reply written straight to the database', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const root = await postOrThrow(session, channel.id, { body: 'The question' });
    const reply = await postOrThrow(session, channel.id, {
      body: 'The answer',
      parentMessageId: root.id,
    });

    await expect(
      observe(
        `insert into messages
           (id, organization_id, conversation_id, author_user_id, sequence_no,
            parent_message_id, depth, parent_depth, body, created_at, updated_at)
         values ('00000000-0000-7000-8000-00000000dead', ?, ?, ?, 99, ?, 1, 0, 'nested',
                 current_timestamp(3), current_timestamp(3))`,
        [world.northstar.organizationId, channel.id, manager().id, reply.id],
      ),
    ).rejects.toThrow();
  });

  it('refuses a depth that disagrees with the parent, written straight to the database', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const root = await postOrThrow(session, channel.id, { body: 'The question' });

    // A parent, but claiming depth 0 — the trigger's business, not the foreign key's.
    await expect(
      observe(
        `insert into messages
           (id, organization_id, conversation_id, author_user_id, sequence_no,
            parent_message_id, depth, parent_depth, body, created_at, updated_at)
         values ('00000000-0000-7000-8000-00000000beef', ?, ?, ?, 98, ?, 0, 0, 'incoherent',
                 current_timestamp(3), current_timestamp(3))`,
        [world.northstar.organizationId, channel.id, manager().id, root.id],
      ),
    ).rejects.toThrow(/depth 1 and parent_depth 0/);
  });
});

describe('who can reach a channel', () => {
  it('lets an organization-wide owner read one they were never added to', async () => {
    const managerSession = await signIn(manager().id);
    const channel = await createChannel(managerSession);

    const ownerSession = await signIn(owner().id);
    const read = await send('GET', `/conversations/${channel.id}`, ownerSession);
    expect(read.statusCode).toBe(200);
  });

  /**
   * The narrowing gate. Lina is on the project — `authorize()` says yes — and is not in the
   * channel, so the service says no. A project can hold more than one room.
   */
  it('refuses a project member who is not in the channel', async () => {
    const managerSession = await signIn(manager().id);
    const channel = await createChannel(managerSession);

    const designerSession = await signIn(designer().id);
    const read = await send('GET', `/conversations/${channel.id}`, designerSession);
    expect(read.statusCode).toBe(404);

    const listed = await send('GET', '/conversations', designerSession);
    expect(listed.json<{ conversations: ConversationClient[] }>().conversations).toEqual([]);
  });

  it('lets them in once they are added, and out again when they are removed', async () => {
    const managerSession = await signIn(manager().id);
    const channel = await createChannel(managerSession);
    const designerSession = await signIn(designer().id);

    const added = await send('POST', `/conversations/${channel.id}/members`, managerSession, {
      userId: designer().id,
    });
    expect(added.statusCode).toBe(201);
    expect((await send('GET', `/conversations/${channel.id}`, designerSession)).statusCode).toBe(
      200,
    );

    const removed = await send(
      'DELETE',
      `/conversations/${channel.id}/members/${designer().id}`,
      managerSession,
    );
    expect(removed.statusCode).toBe(204);
    expect((await send('GET', `/conversations/${channel.id}`, designerSession)).statusCode).toBe(
      404,
    );
  });

  /**
   * A channel membership must not be a way to grant project access the evaluator would refuse
   * — `25-AUTH-AND-TENANT-ISOLATION` §4's "may narrow, never silently widen".
   */
  it('refuses to add somebody who is not on the project', async () => {
    const session = await signIn(owner().id);
    const channel = await send('POST', '/conversations', session, {
      projectId: world.northstar.otherProjectId,
      name: 'internal-only',
    });
    const created = channel.json<ConversationClient>();

    const added = await send('POST', `/conversations/${created.id}/members`, session, {
      userId: designer().id,
    });
    expect(added.statusCode).toBe(422);
    expect(added.json<{ error: { details: { field: string }[] } }>().error.details[0]?.field).toBe(
      'userId',
    );
  });

  it('records the grant and the revocation, and nothing for a revocation that removed nothing', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);

    await send('POST', `/conversations/${channel.id}/members`, session, {
      userId: designer().id,
    });
    await send('DELETE', `/conversations/${channel.id}/members/${designer().id}`, session);
    // A second removal takes nothing away.
    await send('DELETE', `/conversations/${channel.id}/members/${designer().id}`, session);

    const rows = await observe(
      `select action from audit_events
        where organization_id = ? and action like 'conversation.member%'
        order by created_at`,
      [world.northstar.organizationId],
    );
    expect(rows.map((r) => r['action'])).toEqual([
      'conversation.member_added',
      'conversation.member_removed',
    ]);
  });

  it('refuses another tenant, even with an identical channel name', async () => {
    const northstarSession = await signIn(manager().id);
    const channel = await createChannel(northstarSession);

    const twinSession = await signIn(world.twin.owner.id);
    const read = await sendTo(
      'northstar-studios',
      'GET',
      `/conversations/${channel.id}`,
      twinSession,
    );
    expect([403, 404]).toContain(read.statusCode);
  });

  /** No client role holds a conversation capability, and the ceiling is checked first. */
  it('refuses a client principal before any of this module runs', async () => {
    const managerSession = await signIn(manager().id);
    const channel = await createChannel(managerSession);

    const clientSession = await signIn(world.atlas.admin.id);
    const list = await send('GET', '/conversations', clientSession);
    const read = await send('GET', `/conversations/${channel.id}`, clientSession);
    const write = await post(clientSession, channel.id, { body: 'Can I?' });

    expect(list.statusCode).toBe(403);
    expect(read.statusCode).toBe(403);
    expect(write.statusCode).toBe(403);
  });
});

describe('posting, editing and taking down', () => {
  it('returns the same message rather than a second one for a repeated client id', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);

    const first = await post(session, channel.id, {
      body: 'Sent once',
      clientGeneratedId: '00000000-0000-7000-8000-0000000000c1',
    });
    const retry = await post(session, channel.id, {
      body: 'Sent once',
      clientGeneratedId: '00000000-0000-7000-8000-0000000000c1',
    });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json<MessageClient>().id).toBe(first.json<MessageClient>().id);

    const [row] = await observe('select count(*) as c from messages where organization_id = ?', [
      world.northstar.organizationId,
    ]);
    expect(Number(row?.['c'])).toBe(1);
  });

  it('lets an author edit their own message and records that it was edited', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel.id, { body: 'Frist' });

    const edited = await send(
      'PATCH',
      `/conversations/${channel.id}/messages/${message.id}`,
      session,
      { body: 'First' },
    );
    expect(edited.statusCode).toBe(200);
    expect(edited.json<MessageClient>().body).toBe('First');
    expect(edited.json<MessageClient>().editedAt).not.toBeNull();
  });

  it('refuses to let anybody edit somebody else’s message', async () => {
    const managerSession = await signIn(manager().id);
    const channel = await createChannel(managerSession);
    const message = await postOrThrow(managerSession, channel.id, { body: 'Mine' });

    await send('POST', `/conversations/${channel.id}/members`, managerSession, {
      userId: designer().id,
    });
    const designerSession = await signIn(designer().id);
    const edit = await send(
      'PATCH',
      `/conversations/${channel.id}/messages/${message.id}`,
      designerSession,
      { body: 'Not mine' },
    );
    expect(edit.statusCode).toBe(403);

    // Not even the Owner, whose scope reaches everything else.
    const ownerSession = await signIn(owner().id);
    const asOwner = await send(
      'PATCH',
      `/conversations/${channel.id}/messages/${message.id}`,
      ownerSession,
      { body: 'Rewritten' },
    );
    expect(asOwner.statusCode).toBe(403);
  });

  it('lets an author take down their own message, and returns it with the body gone', async () => {
    const managerSession = await signIn(manager().id);
    const channel = await createChannel(managerSession);
    await send('POST', `/conversations/${channel.id}/members`, managerSession, {
      userId: designer().id,
    });

    const designerSession = await signIn(designer().id);
    const message = await postOrThrow(designerSession, channel.id, { body: 'Said in haste' });

    const removed = await send(
      'DELETE',
      `/conversations/${channel.id}/messages/${message.id}`,
      designerSession,
    );
    expect(removed.statusCode).toBe(200);
    expect(removed.json<MessageClient>().body).toBeNull();
    expect(removed.json<MessageClient>().deletedAt).not.toBeNull();
    expect(removed.json<MessageClient>().deletedByUserId).toBe(designer().id);
  });

  it('keeps the row, because there is no delete to make', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel.id, { body: 'Taken down' });
    await send('DELETE', `/conversations/${channel.id}/messages/${message.id}`, session);

    const rows = await observe('select body, deleted_at from messages where id = ?', [message.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['deleted_at']).not.toBeNull();
  });

  it('lets a manager take down somebody else’s and refuses a plain member the same thing', async () => {
    const managerSession = await signIn(manager().id);
    const channel = await createChannel(managerSession);
    await send('POST', `/conversations/${channel.id}/members`, managerSession, {
      userId: designer().id,
    });

    const designerSession = await signIn(designer().id);
    const theirs = await postOrThrow(designerSession, channel.id, { body: 'Theirs' });
    const mine = await postOrThrow(managerSession, channel.id, { body: 'The manager’s' });

    // A Member has no `conversation.moderate`, so somebody else's message is not theirs to take
    // down — §2's "Moderate messages: Own only".
    const refused = await send(
      'DELETE',
      `/conversations/${channel.id}/messages/${mine.id}`,
      designerSession,
    );
    expect(refused.statusCode).toBe(403);

    const allowed = await send(
      'DELETE',
      `/conversations/${channel.id}/messages/${theirs.id}`,
      managerSession,
    );
    expect(allowed.statusCode).toBe(200);
  });

  it('refuses to edit a message that was taken down', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel.id, { body: 'Gone' });
    await send('DELETE', `/conversations/${channel.id}/messages/${message.id}`, session);

    const edit = await send(
      'PATCH',
      `/conversations/${channel.id}/messages/${message.id}`,
      session,
      { body: 'Back again' },
    );
    expect(edit.statusCode).toBe(409);
  });

  it('records a moderation and records nothing at all for an ordinary message', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    await postOrThrow(session, channel.id, { body: 'Ordinary' });
    const taken = await postOrThrow(session, channel.id, { body: 'Taken down' });
    await send('DELETE', `/conversations/${channel.id}/messages/${taken.id}`, session);

    const created = await observe(
      `select action from audit_events where organization_id = ? and action like 'message.created%'`,
      [world.northstar.organizationId],
    );
    expect(created).toHaveLength(0);

    const deleted = await observe(
      `select object_id, object_type from audit_events
        where organization_id = ? and action = 'message.deleted'`,
      [world.northstar.organizationId],
    );
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.['object_id']).toBe(taken.id);
    expect(deleted[0]?.['object_type']).toBe('message');
  });

  it('refuses an empty message body, naming the field', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const response = await post(session, channel.id, { body: '   ' });
    expect(response.statusCode).toBe(400);
    expect(
      response.json<{ error: { details: { field: string }[] } }>().error.details[0]?.field,
    ).toBe('body');
  });

  it('refuses a mutation with no CSRF token', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const response = (await app.inject({
      method: 'POST',
      url: `/v1/organizations/${NORTHSTAR}/conversations/${channel.id}/messages`,
      headers: { 'content-type': 'application/json', cookie: session.cookie },
      payload: { body: 'No token' },
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(403);
  });
});

describe('renaming and archiving', () => {
  it('renames against the version that was read', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);

    const renamed = await send('PATCH', `/conversations/${channel.id}`, session, {
      version: channel.version,
      name: 'atlas-launch',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<ConversationClient>().name).toBe('atlas-launch');
    expect(renamed.json<ConversationClient>().version).toBe(2);
  });

  it('refuses a stale version as a conflict rather than a server error', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    await send('PATCH', `/conversations/${channel.id}`, session, {
      version: channel.version,
      name: 'first-rename',
    });

    const stale = await send('PATCH', `/conversations/${channel.id}`, session, {
      version: channel.version,
      name: 'second-rename',
    });
    expect(stale.statusCode).toBe(409);
  });

  /** Posting is not a change to the channel, so it must not move the concurrency token. */
  it('does not move the version when somebody posts', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    await postOrThrow(session, channel.id, { body: 'Hello' });

    const read = await send('GET', `/conversations/${channel.id}`, session);
    expect(read.json<ConversationClient>().version).toBe(channel.version);
  });

  it('archives, hides it from the default list, and refuses a post to it', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);

    const archived = await send(`POST`, `/conversations/${channel.id}/archival`, session, {
      version: channel.version,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<ConversationClient>().archivedAt).not.toBeNull();

    const listed = await send('GET', '/conversations', session);
    expect(listed.json<{ conversations: ConversationClient[] }>().conversations).toEqual([]);

    const withArchived = await send('GET', '/conversations?includeArchived=true', session);
    expect(withArchived.json<{ conversations: ConversationClient[] }>().conversations).toHaveLength(
      1,
    );

    const posted = await post(session, channel.id, { body: 'Anyone there?' });
    // `authorize()` refuses a write against an archived resource, so the channel reads as
    // unwritable before the service's own message gets a chance.
    expect([404, 409]).toContain(posted.statusCode);
  });
});

describe('the engine holds what the application cannot', () => {
  it('refuses to move a message to another channel', async () => {
    const session = await signIn(manager().id);
    const one = await createChannel(session, { name: 'one' });
    const two = await createChannel(session, { name: 'two' });
    const message = await postOrThrow(session, one.id, { body: 'Stays put' });

    await expect(
      observe('update messages set conversation_id = ? where id = ?', [two.id, message.id]),
    ).rejects.toThrow(/conversation_id is immutable/);
  });

  it('refuses to renumber a message', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel.id, { body: 'One' });

    await expect(
      observe('update messages set sequence_no = 99 where id = ?', [message.id]),
    ).rejects.toThrow(/sequence_no is immutable/);
  });

  it('refuses to reattribute a message', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel.id, { body: 'Mine' });

    await expect(
      observe('update messages set author_user_id = ? where id = ?', [designer().id, message.id]),
    ).rejects.toThrow(/author_user_id is immutable/);
  });

  it('refuses to move a channel to another project', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);

    await expect(
      observe('update conversations set project_id = ? where id = ?', [
        world.northstar.otherProjectId,
        channel.id,
      ]),
    ).rejects.toThrow(/project_id is immutable/);
  });

  it('refuses to wind the sequence allocator backwards', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    await postOrThrow(session, channel.id, { body: 'One' });

    await expect(
      observe('update conversations set next_sequence_no = 1 where id = ?', [channel.id]),
    ).rejects.toThrow(/next_sequence_no may not go backwards/);
  });

  it('refuses two messages with the same sequence number in one channel', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    await postOrThrow(session, channel.id, { body: 'One' });

    await expect(
      observe(
        `insert into messages
           (id, organization_id, conversation_id, author_user_id, sequence_no, depth, body,
            created_at, updated_at)
         values ('00000000-0000-7000-8000-00000000c0de', ?, ?, ?, 1, 0, 'Also one',
                 current_timestamp(3), current_timestamp(3))`,
        [world.northstar.organizationId, channel.id, manager().id],
      ),
    ).rejects.toThrow();
  });

  /**
   * ADR-0001 layer 2. Skipped where the runtime credential is the admin one, because there are
   * no grants to check and asserting on their absence would prove nothing.
   */
  it.skipIf(!usingLeastPrivilegeCredential)(
    'gives the runtime credential no way to delete a message',
    async () => {
      const session = await signIn(manager().id);
      const channel = await createChannel(session);
      const message = await postOrThrow(session, channel.id, { body: 'Permanent' });

      await expect(
        db.runtime.query('delete from messages where id = ?', [message.id]),
      ).rejects.toThrow();
    },
  );
});
