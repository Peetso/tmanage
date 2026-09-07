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
 * CHAT-002 over real HTTP — sanitized rich text and the edit history.
 *
 * CHAT-001 stored plain text and named the reason: rich text stored before anything can
 * sanitise it is rich text nobody can safely render. The sanitiser now exists, and this suite
 * proves the three decisions that ticket left open, where only a real database can:
 *
 * 1. **The allowlist holds at the write boundary.** An inadmissible document — a
 *    `javascript:` link, an unknown node, a body over the ceiling — is refused with a 422
 *    naming the offending path, and *nothing is stored*: no message row, no sequence number
 *    consumed. The unit suite proves the grammar; this proves the refusal reaches storage.
 * 2. **`body` and `body_rich` cannot disagree**, because the plain body of a rich message is
 *    derived from the sanitised document, never accepted from the caller.
 * 3. **The edit history is the engine's, not the application's.** A direct SQL UPDATE that
 *    changes a message body — no service, no repository — still leaves a revision row and a
 *    forced `edited_at`, because `trg_messages_record_revision` writes them with its
 *    definer's privileges. The application's own edit path is just one more caller of that
 *    rule. Revisions themselves refuse UPDATE for every credential.
 *
 * And the interaction CHAT-001's moderation model forces: a taken-down message's *history*
 * bodies are withheld exactly as its current body is — a removal that left every earlier
 * version readable would not have removed anything — while the revisions' count and times
 * survive, because "edited twice, then removed" is part of the record.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_rich_text_suite_xxxxx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_rich_text_suite_xxxxx';

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

interface MessageClient {
  id: string;
  conversationId: string;
  authorUserId: string;
  sequenceNo: number;
  parentMessageId: string | null;
  body: string | null;
  bodyRich: unknown;
  editedAt: string | null;
  deletedAt: string | null;
  deletedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RevisionClient {
  revisionNo: number;
  body: string | null;
  bodyRich: unknown;
  writtenAt: string;
  replacedAt: string;
}

const owner = () => world.northstar.owner;
const manager = () => world.northstar.manager;
const designer = () => world.northstar.designer;

/** A sanitisable document: one bold word, one link, nothing exotic. */
function richDoc(): unknown {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'The plan ships ' },
          { type: 'text', text: 'Friday', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' per ' },
          {
            type: 'text',
            text: 'the brief',
            marks: [{ type: 'link', href: 'https://example.com/brief' }],
          },
        ],
      },
    ],
  };
}

const RICH_DOC_PLAIN = 'The plan ships Friday per the brief';

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

async function editMessage(
  session: Session,
  conversationId: string,
  messageId: string,
  body: Record<string, unknown>,
): Promise<InjectedResponse> {
  return send('PATCH', `/conversations/${conversationId}/messages/${messageId}`, session, body);
}

async function revisionsOf(
  session: Session,
  conversationId: string,
  messageId: string,
): Promise<InjectedResponse> {
  return send('GET', `/conversations/${conversationId}/messages/${messageId}/revisions`, session);
}

/** The stored `body_rich`, as a parsed value on both engines (MariaDB returns it as text). */
async function storedBodyRich(messageId: string): Promise<unknown> {
  const rows = await observe('select body_rich from messages where id = ?', [messageId]);
  const raw = rows[0]?.['body_rich'];
  if (raw === null || raw === undefined) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
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

describe('posting rich text', () => {
  it('stores the sanitised document with the plain body derived from it', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel, { bodyRich: richDoc() });

    expect(message.bodyRich).toEqual(richDoc());
    expect(message.body).toBe(RICH_DOC_PLAIN);

    // The row agrees with the projection: both columns written, from one source.
    const rows = await observe('select body from messages where id = ?', [message.id]);
    expect(rows[0]?.['body']).toBe(RICH_DOC_PLAIN);
    expect(await storedBodyRich(message.id)).toEqual(richDoc());
  });

  it('still takes plain text, with no document', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel, { body: 'Just words' });
    expect(message.body).toBe('Just words');
    expect(message.bodyRich).toBeNull();
  });

  it('refuses a body and a document together — two versions free to disagree', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const response = await post(session, channel, { body: 'plain', bodyRich: richDoc() });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('not both');
  });

  it('refuses neither', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const response = await post(session, channel, {});
    expect(response.statusCode).toBe(400);
  });

  it('refuses a document that is not an object', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const response = await post(session, channel, { bodyRich: '<b>hi</b>' });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('bodyRich');
  });

  it('refuses a javascript: link with the path to it, and stores nothing', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const response = await post(session, channel, {
      bodyRich: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'click',
                marks: [{ type: 'link', href: 'javascript:alert(1)' }],
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('doc.content[0].content[0].marks[0].href');

    // Nothing reached storage — no row, and no sequence number consumed.
    const messages = await observe('select id from messages where conversation_id = ?', [channel]);
    expect(messages).toHaveLength(0);
    const allocator = await observe('select next_sequence_no from conversations where id = ?', [
      channel,
    ]);
    expect(Number(allocator[0]?.['next_sequence_no'])).toBe(1);
  });

  it('refuses a node type outside the allowlist', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const response = await post(session, channel, {
      bodyRich: { type: 'doc', content: [{ type: 'iframe', content: [] }] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('unknown block');
  });

  it('dedupes a rich retry on the client-generated id, returning the original', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const clientGeneratedId = '01890000-0000-7000-8000-00000000c1de';

    const first = await post(session, channel, { bodyRich: richDoc(), clientGeneratedId });
    expect(first.statusCode).toBe(201);
    const retry = await post(session, channel, { bodyRich: richDoc(), clientGeneratedId });
    expect(retry.statusCode).toBe(200);
    expect(retry.json<MessageClient>().id).toBe(first.json<MessageClient>().id);
  });

  it('lists rich and plain messages with their own documents', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    await postOrThrow(session, channel, { body: 'plain first' });
    await postOrThrow(session, channel, { bodyRich: richDoc() });

    const listed = await send('GET', `/conversations/${channel}/messages`, session);
    const messages = listed.json<{ messages: MessageClient[] }>().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.bodyRich).toBeNull();
    expect(messages[1]?.bodyRich).toEqual(richDoc());
  });
});

describe('editing and the history', () => {
  it('records what the message said before, and that it changed', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel, { body: 'first draft' });
    expect(message.editedAt).toBeNull();

    const edited = await editMessage(session, channel, message.id, { body: 'second draft' });
    expect(edited.statusCode).toBe(200);
    const after = edited.json<MessageClient>();
    expect(after.body).toBe('second draft');
    // Set by the trigger, not by this application — see the direct-SQL case below.
    expect(after.editedAt).not.toBeNull();

    const history = await revisionsOf(session, channel, message.id);
    expect(history.statusCode).toBe(200);
    const revisions = history.json<{ revisions: RevisionClient[] }>().revisions;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.revisionNo).toBe(1);
    expect(revisions[0]?.body).toBe('first draft');
    expect(revisions[0]?.bodyRich).toBeNull();
    // Revision 1's body was written when the message was created, and stopped being
    // current at the edit.
    expect(revisions[0]?.writtenAt).toBe(message.createdAt);
    expect(revisions[0]?.replacedAt).toBe(after.editedAt);
  });

  it('keeps the whole history across plain and rich forms, in order', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel, { body: 'plain original' });

    const toRich = await editMessage(session, channel, message.id, { bodyRich: richDoc() });
    expect(toRich.statusCode).toBe(200);
    expect(toRich.json<MessageClient>().body).toBe(RICH_DOC_PLAIN);

    // Back to plain: the document is replaced by nothing, not left beside the new text.
    const toPlain = await editMessage(session, channel, message.id, { body: 'plain again' });
    expect(toPlain.statusCode).toBe(200);
    expect(toPlain.json<MessageClient>().bodyRich).toBeNull();

    const history = await revisionsOf(session, channel, message.id);
    const revisions = history.json<{ revisions: RevisionClient[] }>().revisions;
    expect(revisions.map((r) => r.revisionNo)).toEqual([1, 2]);
    expect(revisions[0]?.body).toBe('plain original');
    expect(revisions[0]?.bodyRich).toBeNull();
    expect(revisions[1]?.body).toBe(RICH_DOC_PLAIN);
    expect(revisions[1]?.bodyRich).toEqual(richDoc());
  });

  it('writes no revision for an edit that changes nothing', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel, { body: 'unchanged' });

    const same = await editMessage(session, channel, message.id, { body: 'unchanged' });
    expect(same.statusCode).toBe(200);
    expect(same.json<MessageClient>().editedAt).toBeNull();

    const history = await revisionsOf(session, channel, message.id);
    expect(history.json<{ revisions: RevisionClient[] }>().revisions).toEqual([]);
  });

  it('refuses an inadmissible edit and leaves message and history untouched', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel, { body: 'intact' });

    const response = await editMessage(session, channel, message.id, {
      bodyRich: { type: 'doc', content: [{ type: 'script', content: [] }] },
    });
    expect(response.statusCode).toBe(422);

    const rows = await observe('select body, edited_at from messages where id = ?', [message.id]);
    expect(rows[0]?.['body']).toBe('intact');
    expect(rows[0]?.['edited_at']).toBeNull();
    const history = await revisionsOf(session, channel, message.id);
    expect(history.json<{ revisions: RevisionClient[] }>().revisions).toEqual([]);
  });

  it('returns an empty history for a message never edited', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel, { body: 'as first said' });
    const history = await revisionsOf(session, channel, message.id);
    expect(history.statusCode).toBe(200);
    expect(history.json<{ revisions: RevisionClient[] }>().revisions).toEqual([]);
  });

  it('numbers concurrent edits without losing one', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel, { body: 'v0' });

    const results = await Promise.all([
      editMessage(session, channel, message.id, { body: 'edit a' }),
      editMessage(session, channel, message.id, { body: 'edit b' }),
    ]);
    for (const result of results) expect(result.statusCode).toBe(200);

    const history = await revisionsOf(session, channel, message.id);
    const revisions = history.json<{ revisions: RevisionClient[] }>().revisions;
    expect(revisions.map((r) => r.revisionNo)).toEqual([1, 2]);
    expect(revisions[0]?.body).toBe('v0');
  });
});

describe('the history is the engine’s, not the application’s', () => {
  it('a direct SQL UPDATE still leaves a revision and a forced edited_at', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel, { body: 'said in the app' });

    // No service, no repository, no HTTP — the path a compromised or careless caller takes.
    await db.admin.query('update messages set body = ? where id = ?', [
      'rewritten at the console',
      message.id,
    ]);

    const rows = await observe('select body, edited_at from messages where id = ?', [message.id]);
    expect(rows[0]?.['body']).toBe('rewritten at the console');
    expect(rows[0]?.['edited_at']).not.toBeNull();

    const revisions = await observe(
      'select revision_no, body from message_revisions where message_id = ? order by revision_no',
      [message.id],
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.['body']).toBe('said in the app');
  });

  it('a direct SQL UPDATE that does not touch the body writes no revision', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel, { body: 'moderatable' });

    await db.admin.query('update messages set deleted_at = now(3) where id = ?', [message.id]);

    const revisions = await observe('select 1 from message_revisions where message_id = ?', [
      message.id,
    ]);
    expect(revisions).toHaveLength(0);
  });

  it('revision rows refuse UPDATE for any credential', async () => {
    const session = await signIn(manager().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel, { body: 'original' });
    await editMessage(session, channel, message.id, { body: 'edited' });

    await expect(
      db.admin.query('update message_revisions set body = ? where message_id = ?', [
        'falsified',
        message.id,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('moderation and the history', () => {
  it('withholds every superseded body once the message is taken down', async () => {
    const managerSession = await signIn(manager().id);
    const channel = await createChannel(managerSession);
    const message = await postOrThrow(managerSession, channel, { bodyRich: richDoc() });
    await editMessage(managerSession, channel, message.id, { body: 'toned down' });

    const takedown = await send(
      'DELETE',
      `/conversations/${channel}/messages/${message.id}`,
      managerSession,
    );
    expect(takedown.statusCode).toBe(200);
    expect(takedown.json<MessageClient>().body).toBeNull();
    expect(takedown.json<MessageClient>().bodyRich).toBeNull();

    const history = await revisionsOf(managerSession, channel, message.id);
    const revisions = history.json<{ revisions: RevisionClient[] }>().revisions;
    // The record that it was edited survives; what it said does not come back out.
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.revisionNo).toBe(1);
    expect(revisions[0]?.body).toBeNull();
    expect(revisions[0]?.bodyRich).toBeNull();
    expect(revisions[0]?.writtenAt).toEqual(expect.any(String));

    // Withheld by the projection, not destroyed: the row still holds the body, because the
    // moderation ledger's whole point is that nothing was erased.
    const stored = await observe('select body from message_revisions where message_id = ?', [
      message.id,
    ]);
    expect(stored[0]?.['body']).toBe(RICH_DOC_PLAIN);
  });
});

describe('who may read the history', () => {
  it('any member of the channel may — an edit is visible to the room', async () => {
    const managerSession = await signIn(manager().id);
    const channel = await createChannel(managerSession);
    const message = await postOrThrow(managerSession, channel, { body: 'before' });
    await editMessage(managerSession, channel, message.id, { body: 'after' });

    await send('POST', `/conversations/${channel}/members`, managerSession, {
      userId: designer().id,
    });
    const designerSession = await signIn(designer().id);
    const history = await revisionsOf(designerSession, channel, message.id);
    expect(history.statusCode).toBe(200);
    expect(history.json<{ revisions: RevisionClient[] }>().revisions).toHaveLength(1);
  });

  it('a project member outside the channel gets the same 404 as for the channel itself', async () => {
    const managerSession = await signIn(manager().id);
    const channel = await createChannel(managerSession);
    const message = await postOrThrow(managerSession, channel, { body: 'before' });
    await editMessage(managerSession, channel, message.id, { body: 'after' });

    const designerSession = await signIn(designer().id);
    const history = await revisionsOf(designerSession, channel, message.id);
    expect(history.statusCode).toBe(404);
  });

  it('another tenant learns nothing, even holding both ids', async () => {
    const managerSession = await signIn(manager().id);
    const channel = await createChannel(managerSession);
    const message = await postOrThrow(managerSession, channel, { body: 'ours' });
    await editMessage(managerSession, channel, message.id, { body: 'still ours' });

    const twinSession = await signIn(world.twin.owner.id);
    const foreign = await sendTo(
      'northstar-studios',
      'GET',
      `/conversations/${channel}/messages/${message.id}/revisions`,
      twinSession,
    );
    expect(foreign.statusCode).toBe(404);
  });

  it('a message id from a different channel is not found under this one', async () => {
    const session = await signIn(owner().id);
    const channel = await createChannel(session);
    const message = await postOrThrow(session, channel, { body: 'here' });
    await editMessage(session, channel, message.id, { body: 'still here' });

    const other = await send('POST', '/conversations', session, {
      projectId: world.northstar.otherProjectId,
      name: 'other-room',
    });
    const otherChannel = other.json<{ id: string }>().id;
    const crossed = await revisionsOf(session, otherChannel, message.id);
    expect(crossed.statusCode).toBe(404);
  });
});
