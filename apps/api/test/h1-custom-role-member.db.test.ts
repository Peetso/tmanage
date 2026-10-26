import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import WebSocket from 'ws';
import { outboxAggregateTypeFor, uuidv7 } from '@tmanage/domain';
import { signRealtimeTicket } from '@tmanage/domain/realtime-ticket';
import {
  WORKER_OUTBOX_HANDLERS,
  createMessageFanOut,
  createRealtimeServer,
  createWorkerDatabase,
  runOutboxBatch,
} from '@tmanage/worker';
import type { RealtimeServer, WorkerDatabase } from '@tmanage/worker';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { bootHttpHarness, reseed, signIn, stopHarness } from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * H1 proof (audit 2026-10-26 gap 3) — a member holding a **custom role** is a full member, over
 * the real API, the real worker relay and a real socket, against a real local MySQL.
 *
 * a223bf43 resolved a custom role id wherever a raw `memberships.role` was read (worker
 * `principal-role.ts`, People `roleName`); until now only unit tests covered it. Every role and
 * assignment here goes through the product's own routes: the owner creates two roles in Control >
 * Roles (`POST admin/roles`) and gives one to each of two Atlas project members
 * (`PATCH members/:userId/role` with `customRoleId`). Then:
 *
 * 1. **Realtime.** Rania ("Delivery lead": `conversation.read` among others) mints a ticket,
 *    subscribes to the project channel and receives a live message frame relayed by the real
 *    dispatcher. Lina ("Work viewer": no `conversation.read`) is refused the ticket mint, and a
 *    validly signed ticket still gets her subscribe refused — the worker judges her role's own set.
 * 2. **Direct messages.** The owner messages Rania; the relay writes her in-app notice, and her
 *    socket may subscribe to the direct conversation.
 * 3. **Approval notices.** An `approval.decided.v1` for the Atlas project tells Rania (her role
 *    holds `deliverable.create`) and not Lina (hers does not), though both are on the project.
 * 4. **People.** `GET people` names each custom role by its own name, for an owner and for the
 *    two custom-role members themselves; built-in roles keep `roleName: null`.
 *
 * Known trap honoured: the admin pool clock is SYSTEM, so the one event this suite writes through
 * the admin pool is dated from bound `Date`s, never `current_timestamp`.
 */

const SECRET_TAG = 'the_h1_custom_role_member_suite';
/** The harness's session secret for {@link SECRET_TAG} — the realtime server must share it. */
const SESSION_SECRET = `local_dev_only_session_secret_for_${SECRET_TAG}`.padEnd(48, 'x');
const ORG = '/v1/organizations/northstar-studio';
const OPTIONS = { batchSize: 50, maxAttempts: 3, backoffBaseMs: 60_000, backoffCapMs: 900_000 };

const DELIVERY_LEAD = 'Delivery lead';
const DELIVERY_LEAD_CAPABILITIES = [
  'conversation.read',
  'conversation.write',
  'work.read',
  'client_projection.read',
  'deliverable.create',
] as const;
const WORK_VIEWER = 'Work viewer';
const WORK_VIEWER_CAPABILITIES = ['work.read', 'client_projection.read'] as const;

let app: NestFastifyApplication;
let db: TestDatabase;
let world: SeedWorld;
let workerDb: WorkerDatabase;
let realtime: RealtimeServer;

let ownerSession: Session;
let leadSession: Session;
let viewerSession: Session;
let leadRoleId: string;
let viewerRoleId: string;
let channelId: string;

/** Rania — the Atlas project member who gets the wide custom role. */
const lead = () => world.northstar.offboardee;
/** Lina — the Atlas project member who gets the narrow custom role. */
const viewer = () => world.northstar.designer;

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function call(
  session: Session,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url,
    headers: {
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload }),
  })) as unknown as InjectedResponse;
}

async function createRole(name: string, capabilities: readonly string[]): Promise<string> {
  const response = await call(ownerSession, 'POST', `${ORG}/admin/roles`, {
    name,
    capabilities: [...capabilities],
  });
  expect(response.statusCode, response.body).toBe(201);
  const view = response.json<{ roles: { id: string; name: string }[] }>();
  const found = view.roles.find((role) => role.name === name);
  if (!found) throw new Error(`expected a role named ${name} in the view`);
  return found.id;
}

async function assignRole(userId: string, customRoleId: string): Promise<void> {
  const response = await call(ownerSession, 'PATCH', `${ORG}/members/${userId}/role`, {
    customRoleId,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<{ role: string; changed: boolean }>()).toMatchObject({
    role: customRoleId,
    changed: true,
  });
}

async function drain(handlers = WORKER_OUTBOX_HANDLERS): Promise<void> {
  for (;;) {
    const report = await runOutboxBatch(workerDb, handlers, OPTIONS);
    expect(report.failed, JSON.stringify(report.failures)).toBe(0);
    if (report.claimed === 0) return;
  }
}

/** A socket whose frames land in an awaitable queue — no sleeps, no races (rt-001's shape). */
function connect(ticket: string): {
  socket: WebSocket;
  next: () => Promise<Record<string, unknown>>;
} {
  const socket = new WebSocket(`ws://127.0.0.1:${realtime.port}/?ticket=${ticket}`);
  const frames: Record<string, unknown>[] = [];
  const waiters: ((frame: Record<string, unknown>) => void)[] = [];
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  return {
    socket,
    next: () =>
      new Promise((resolve, reject) => {
        const queued = frames.shift();
        if (queued) return resolve(queued);
        waiters.push(resolve);
        setTimeout(() => reject(new Error('no frame within 5s')), 5_000);
      }),
  };
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

async function connectWithTicket(ticket: string): Promise<ReturnType<typeof connect>> {
  const client = connect(ticket);
  await opened(client.socket);
  return client;
}

async function mintTicket(session: Session): Promise<InjectedResponse> {
  return call(session, 'POST', `${ORG}/realtime/tickets`);
}

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: SECRET_TAG, guardMode: 'enforce' }));
  world = await reseed(db);
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });
  realtime = await createRealtimeServer({
    database: workerDb,
    sessionSecret: SESSION_SECRET,
    port: 0,
  });

  ownerSession = await signIn(app, world.northstar.owner.id);
  leadRoleId = await createRole(DELIVERY_LEAD, DELIVERY_LEAD_CAPABILITIES);
  viewerRoleId = await createRole(WORK_VIEWER, WORK_VIEWER_CAPABILITIES);
  await assignRole(lead().id, leadRoleId);
  await assignRole(viewer().id, viewerRoleId);

  // Both sign in after the change, so each session is resolved under the custom role.
  leadSession = await signIn(app, lead().id);
  viewerSession = await signIn(app, viewer().id);

  // An Atlas channel: since CQ-12 a project channel holds the whole project team, Rania included.
  const channel = await call(ownerSession, 'POST', `${ORG}/conversations`, {
    projectId: world.northstar.projectId,
    name: 'custom-role-room',
  });
  expect(channel.statusCode, channel.body).toBe(201);
  channelId = channel.json<{ id: string }>().id;
  await drain(); // Leave no backlog for the cases below.
}, 300_000);

afterAll(async () => {
  await realtime?.close();
  await workerDb?.end();
  await stopHarness({ app, db });
});

describe('the stored rows the cases rely on', () => {
  it('each member holds the custom role id, and each role row is in Northstar', async () => {
    const rows = await observe(
      `select m.user_id, m.role, cr.name
         from memberships m
         join custom_roles cr on cr.organization_id = m.organization_id and cr.id = m.role
        where m.organization_id = ? and m.user_id in (?, ?)`,
      [world.northstar.organizationId, lead().id, viewer().id],
    );
    const byUser = new Map(rows.map((row) => [String(row['user_id']), row]));
    expect(byUser.get(lead().id)?.['role']).toBe(leadRoleId);
    expect(byUser.get(lead().id)?.['name']).toBe(DELIVERY_LEAD);
    expect(byUser.get(viewer().id)?.['role']).toBe(viewerRoleId);
    expect(byUser.get(viewer().id)?.['name']).toBe(WORK_VIEWER);
  });
});

describe('realtime for a custom-role member', () => {
  it('a role with conversation.read mints a ticket, subscribes and receives a live frame', async () => {
    const minted = await mintTicket(leadSession);
    expect(minted.statusCode, minted.body).toBe(201);
    const client = await connectWithTicket(minted.json<{ ticket: string }>().ticket);

    client.socket.send(JSON.stringify({ type: 'subscribe', conversationId: channelId }));
    expect(await client.next()).toMatchObject({ type: 'subscribed', conversationId: channelId });

    const posted = await call(ownerSession, 'POST', `${ORG}/conversations/${channelId}/messages`, {
      body: 'Custom roles hear this live',
    });
    expect(posted.statusCode, posted.body).toBe(201);
    const messageId = posted.json<{ id: string }>().id;

    await drain({
      ...WORKER_OUTBOX_HANDLERS,
      'message.created.v1': createMessageFanOut(realtime.hub),
    });

    const frame = await client.next();
    expect(frame['type']).toBe('event');
    expect(frame['eventType']).toBe('message.created.v1');
    expect(frame['conversationId']).toBe(channelId);
    expect(frame['objectId']).toBe(messageId);
    expect(JSON.stringify(frame)).not.toContain('hear this live');
    client.socket.close();
  });

  it('a role without conversation.read is refused the ticket mint', async () => {
    const minted = await mintTicket(viewerSession);
    expect(minted.statusCode).toBe(403);
  });

  it('and with a validly signed ticket the worker still refuses her subscribe', async () => {
    // Signed exactly as the API would, so only the worker's role check stands between her and
    // the channel — the check a223bf43 changed from "skip any non-built-in role".
    const ticket = signRealtimeTicket(
      {
        organizationId: world.northstar.organizationId,
        userId: viewer().id,
        expiresAt: Date.now() + 60_000,
      },
      SESSION_SECRET,
    );
    const client = await connectWithTicket(ticket);
    client.socket.send(JSON.stringify({ type: 'subscribe', conversationId: channelId }));
    expect(await client.next()).toEqual({ type: 'refused', conversationId: channelId });
    client.socket.close();
  });
});

describe('direct messages to a custom-role member', () => {
  it('the owner messages her, the relay writes her notice, and her socket may subscribe', async () => {
    const opened = await call(ownerSession, 'POST', `${ORG}/direct-conversations`, {
      userId: lead().id,
    });
    expect([200, 201], opened.body).toContain(opened.statusCode);
    const directId = opened.json<{ id: string }>().id;

    const sent = await call(
      ownerSession,
      'POST',
      `${ORG}/direct-conversations/${directId}/messages`,
      {
        body: 'A word in private',
      },
    );
    expect(sent.statusCode, sent.body).toBe(201);
    const messageId = sent.json<{ id: string }>().id;

    await drain();

    const notices = await observe(
      'select organization_id, recipient_user_id, type from notifications where dedupe_key = ?',
      [`direct_message:${messageId}`],
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.['recipient_user_id']).toBe(lead().id);
    expect(notices[0]?.['organization_id']).toBe(world.northstar.organizationId);
    expect(notices[0]?.['type']).toBe('direct_message.created.v1');

    const minted = await mintTicket(leadSession);
    expect(minted.statusCode, minted.body).toBe(201);
    const client = await connectWithTicket(minted.json<{ ticket: string }>().ticket);
    client.socket.send(JSON.stringify({ type: 'subscribe', conversationId: directId }));
    expect(await client.next()).toMatchObject({ type: 'subscribed', conversationId: directId });
    client.socket.close();

    // She reads the thread over HTTP too — the API resolves the same role the worker did.
    const listed = await call(
      leadSession,
      'GET',
      `${ORG}/direct-conversations/${directId}/messages`,
    );
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ messages: { id: string }[] }>().messages.map((m) => m.id)).toContain(
      messageId,
    );
  });
});

describe('approval notices for a custom-role member', () => {
  it('approval.decided tells the role with deliverable.create, not the one without', async () => {
    const approvalId = uuidv7();
    const at = new Date(Date.now() - 1_000);
    await db.admin.execute(
      `insert into outbox_events
         (id, organization_id, type, schema_version, aggregate_type, aggregate_id,
          payload_json, occurred_at, available_at)
       values (?, ?, 'approval.decided.v1', 1, ?, ?, ?, ?, ?)`,
      [
        uuidv7(),
        world.northstar.organizationId,
        outboxAggregateTypeFor('approval.decided.v1'),
        approvalId,
        JSON.stringify({
          approvalId,
          deliverableId: uuidv7(),
          deliverableVersionId: uuidv7(),
          projectId: world.northstar.projectId,
          decision: 'approved',
          decidedByUserId: world.atlas.reviewer.id,
          requestedByUserId: world.northstar.owner.id,
        }),
        at,
        at,
      ],
    );

    await drain();

    const rows = await observe(
      'select organization_id, recipient_user_id from notifications where dedupe_key = ?',
      [`approval.decided:${approvalId}`],
    );
    const recipients = rows.map((row) => String(row['recipient_user_id']));
    expect(recipients).toContain(lead().id);
    expect(recipients).not.toContain(viewer().id);
    expect(recipients).toContain(world.northstar.owner.id); // The sender, as before.
    expect(recipients).not.toContain(world.atlas.reviewer.id); // Never the decider.
    for (const row of rows) expect(row['organization_id']).toBe(world.northstar.organizationId);
  });
});

describe('People names a custom role by its own name', () => {
  interface PersonRow {
    readonly userId: string;
    readonly role: string;
    readonly roleName: string | null;
  }

  async function people(session: Session): Promise<Map<string, PersonRow>> {
    const response = await call(session, 'GET', `${ORG}/people`);
    expect(response.statusCode, response.body).toBe(200);
    const rows = response.json<{ people: PersonRow[] }>().people;
    return new Map(rows.map((row) => [row.userId, row]));
  }

  it.each([
    ['the owner', () => ownerSession],
    ['the custom-role member with the wide role', () => leadSession],
    ['the custom-role member with the narrow role', () => viewerSession],
  ])('for %s', async (_label, session) => {
    const byUser = await people(session());
    expect(byUser.get(lead().id)).toMatchObject({ role: leadRoleId, roleName: DELIVERY_LEAD });
    expect(byUser.get(viewer().id)).toMatchObject({ role: viewerRoleId, roleName: WORK_VIEWER });
    expect(byUser.get(world.northstar.owner.id)).toMatchObject({ role: 'owner', roleName: null });
    expect(byUser.get(world.northstar.manager.id)).toMatchObject({
      role: 'manager',
      roleName: null,
    });
  });
});
