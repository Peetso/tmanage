import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import WebSocket from 'ws';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { verifyRealtimeTicket } from '@tmanage/domain/realtime-ticket';
import {
  WORKER_OUTBOX_HANDLERS,
  createMessageFanOut,
  createRealtimeServer,
  createWorkerDatabase,
  runOutboxBatch,
} from '@tmanage/worker';
import type { RealtimeServer, WorkerDatabase } from '@tmanage/worker';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { OutboxEventsRepository } from '../src/modules/platform/outbox-events.repository.js';
import { ProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { ProjectMembershipsRepository } from '../src/modules/projects/project-memberships.repository.js';
import { WorkItemsRepository } from '../src/modules/work/work-items.repository.js';
import { ConversationsRepository } from '../src/modules/conversations/conversations.repository.js';
import { ConversationsService } from '../src/modules/conversations/conversations.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * RT-001's first half against a real server AND a real socket — `13-ENGINEERING` §6, each
 * sentence exercised:
 *
 * 1. **"Socket authenticates short-lived ticket."** The API mints one over a session the
 *    guards proved (a client principal, holding no conversation capability, is refused the
 *    mint itself); the socket refuses a bad or absent ticket with 4401 and no detail.
 * 2. **"Subscription request names authorized resource."** A channel member subscribes and
 *    is answered; an internal non-member is refused; another tenant's conversation id is
 *    refused indistinguishably; and a non-org-wide member of the channel is refused the
 *    moment their `project_memberships` row goes, stale channel row and all (x33's gate).
 * 3. **"Server returns current cursor."** The cursor is the allocator's last handed-out
 *    sequence, asserted against the number of messages actually posted.
 * 4. **Broadcasts are safe projections.** A message posted through the ordinary service,
 *    relayed by the real dispatcher through the real fan-out, arrives as ids and a
 *    sequence — and the author's words are nowhere in the frame, asserted at the byte
 *    level.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;
let tenant: TenantDatabase;
let workerDb: WorkerDatabase;
let realtime: RealtimeServer;
let conversations: ConversationsService;
let ownerCtx: TenantContext;
let owner: Principal;
let conversationId: string;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_realtime_suite_xx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_realtime_suite_xxxxx';

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

const OPTIONS = { batchSize: 50, maxAttempts: 3, backoffBaseMs: 60_000, backoffCapMs: 900_000 };

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

async function signIn(userId: string): Promise<Session> {
  const response = (await app.inject({
    method: 'POST',
    url: '/v1/dev/sessions',
    headers: { 'content-type': 'application/json' },
    payload: { userId },
  })) as unknown as InjectedResponse;
  return {
    cookie: cookieHeader(setCookies(response)),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
  };
}

async function mintTicket(session: Session): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'POST',
    url: '/v1/organizations/northstar-studio/realtime/tickets',
    headers: {
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
    },
  })) as unknown as InjectedResponse;
}

/** A socket whose frames land in an awaitable queue — no sleeps, no races. */
function connect(ticket: string): {
  socket: WebSocket;
  next: () => Promise<Record<string, unknown>>;
  closed: () => Promise<number>;
} {
  const socket = new WebSocket(`ws://127.0.0.1:${realtime.port}/?ticket=${ticket}`);
  const frames: Record<string, unknown>[] = [];
  const waiters: ((frame: Record<string, unknown>) => void)[] = [];
  let closeCode: number | undefined;
  const closeWaiters: ((code: number) => void)[] = [];

  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  socket.on('close', (code) => {
    closeCode = code;
    for (const waiter of closeWaiters.splice(0)) waiter(code);
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
    closed: () =>
      new Promise((resolve, reject) => {
        if (closeCode !== undefined) return resolve(closeCode);
        closeWaiters.push(resolve);
        setTimeout(() => reject(new Error('no close within 5s')), 5_000);
      }),
  };
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });
  realtime = await createRealtimeServer({
    database: workerDb,
    sessionSecret: SESSION_SECRET,
    port: 0,
  });

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

  ownerCtx = createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: world.northstar.owner.id,
    membershipId: world.northstar.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  owner = {
    userId: ownerCtx.userId,
    organizationId: ownerCtx.organizationId,
    kind: 'internal',
    role: 'owner',
    membershipId: ownerCtx.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };

  const audit = new AuditService(tenant, new AuditEventsRepository());
  conversations = new ConversationsService(
    tenant,
    new ConversationsRepository(),
    audit,
    new ProjectsRepository(),
    new ProjectMembershipsRepository(),
    new WorkItemsRepository(),
    new OutboxEventsRepository(),
  );

  const channel = await conversations.create(ownerCtx, owner, {
    projectId: world.northstar.projectId,
    name: 'launch-room',
  });
  conversationId = channel.id;
  await conversations.postMessage(ownerCtx, owner, conversationId, {
    body: 'The first message, before anyone subscribes.',
  });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await realtime?.close();
  await workerDb?.end();
  await db?.stop();
});

describe('the ticket', () => {
  it('mints over a proved session, and the claims verify', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await mintTicket(session);
    expect(response.statusCode).toBe(201);
    const { ticket, expiresAt } = response.json<{ ticket: string; expiresAt: string }>();

    const claims = verifyRealtimeTicket(ticket, SESSION_SECRET, new Date());
    expect(claims).not.toBeNull();
    expect(claims?.organizationId).toBe(world.northstar.organizationId);
    expect(claims?.userId).toBe(world.northstar.owner.id);
    expect(new Date(expiresAt).getTime()).toBe(claims?.expiresAt);
  });

  it('is refused to a client principal at the mint — no conversation capability, no ticket', async () => {
    const session = await signIn(world.atlas.admin.id);
    const response = await mintTicket(session);
    expect(response.statusCode).toBe(403);
  });

  it('a socket with a bad ticket is closed 4401, with nothing else said', async () => {
    const bad = connect('not-a-ticket');
    expect(await bad.closed()).toBe(4401);
  });
});

describe('subscriptions, against current rows', () => {
  async function connectAs(userId: string): Promise<ReturnType<typeof connect>> {
    const session = await signIn(userId);
    const minted = await mintTicket(session);
    const { ticket } = minted.json<{ ticket: string }>();
    const client = connect(ticket);
    await opened(client.socket);
    return client;
  }

  it('a channel member subscribes and receives the current cursor', async () => {
    const client = await connectAs(world.northstar.owner.id);
    client.socket.send(JSON.stringify({ type: 'subscribe', conversationId }));
    const frame = await client.next();
    expect(frame).toEqual({ type: 'subscribed', conversationId, cursor: 1 });
    client.socket.close();
  });

  it('an internal non-member and a foreign conversation are refused indistinguishably', async () => {
    // Since CQ-12 (c3831f25) a new project channel holds the whole project team, so Omar —
    // on the project, not org-wide — joins it at creation. Take his channel row away so he is
    // an internal non-member again: still on the project, still holding `conversation.read`,
    // and refused only because he is not in the channel. The next case re-adds him.
    await db.admin.execute(
      'delete from conversation_memberships where organization_id = ? and conversation_id = ? and user_id = ?',
      [world.northstar.organizationId, conversationId, world.northstar.manager.id],
    );

    const client = await connectAs(world.northstar.manager.id); // Not in the channel.
    client.socket.send(JSON.stringify({ type: 'subscribe', conversationId }));
    expect(await client.next()).toEqual({ type: 'refused', conversationId });

    const foreign = uuidv7(); // No such conversation in this tenant — same answer.
    client.socket.send(JSON.stringify({ type: 'subscribe', conversationId: foreign }));
    expect(await client.next()).toEqual({ type: 'refused', conversationId: foreign });
    client.socket.close();
  });

  it('a live message arrives as ids and a sequence, never as words', async () => {
    // Publish the backlog first — the pre-subscription message's event has no business in
    // this case, and the hub rightly delivers every event the relay hands it.
    for (;;) {
      const report = await runOutboxBatch(workerDb, WORKER_OUTBOX_HANDLERS, OPTIONS);
      expect(report.failed).toBe(0);
      if (report.claimed === 0) break;
    }

    const client = await connectAs(world.northstar.owner.id);
    client.socket.send(JSON.stringify({ type: 'subscribe', conversationId }));
    await client.next(); // subscribed

    const posted = await conversations.postMessage(ownerCtx, owner, conversationId, {
      body: 'Confidential: the launch moves to Thursday',
    });

    // The real relay, with the real fan-out registered beside the real consumers.
    const handlers = {
      ...WORKER_OUTBOX_HANDLERS,
      'message.created.v1': createMessageFanOut(realtime.hub),
    };
    for (;;) {
      const report = await runOutboxBatch(workerDb, handlers, OPTIONS);
      expect(report.failed, JSON.stringify(report.failures)).toBe(0);
      if (report.claimed === 0) break;
    }

    const frame = await client.next();
    expect(frame['type']).toBe('event');
    expect(frame['eventType']).toBe('message.created.v1');
    expect(frame['conversationId']).toBe(conversationId);
    expect(frame['objectId']).toBe(posted.message.id);
    expect(frame['sequence']).toBe(2);
    expect(JSON.stringify(frame)).not.toContain('Thursday');
    expect(JSON.stringify(frame)).not.toContain('Confidential');
    client.socket.close();
  });

  // The project half of the gate, against real rows. Every case above subscribes as the
  // owner, whose `has_org_wide_scope = 1` short-circuits the check; Omar is a manager with
  // no org-wide scope, so for him the `project_memberships` sub-select decides.
  it('a non-org-wide project member subscribes once they hold the channel row', async () => {
    await conversations.addMember(ownerCtx, owner, conversationId, world.northstar.manager.id);

    const client = await connectAs(world.northstar.manager.id);
    client.socket.send(JSON.stringify({ type: 'subscribe', conversationId }));
    expect(await client.next()).toMatchObject({ type: 'subscribed', conversationId });
    client.socket.close();
  });

  it('and is refused the moment the project row goes, stale channel row and all', async () => {
    // One fact changes from the case above; the channel row stays, which is the point: a
    // stale `conversation_memberships` row must not keep a removed project member on air.
    await db.admin.execute(
      'delete from project_memberships where organization_id = ? and project_id = ? and user_id = ?',
      [world.northstar.organizationId, world.northstar.projectId, world.northstar.manager.id],
    );

    const client = await connectAs(world.northstar.manager.id);
    client.socket.send(JSON.stringify({ type: 'subscribe', conversationId }));
    expect(await client.next()).toEqual({ type: 'refused', conversationId });
    client.socket.close();
  });

  // The channel-membership half of the alignment, against real rows (x41, review-x33 finding
  // I1). Over HTTP an org-wide principal reads a channel with no `conversation_memberships`
  // row; the subscribe check must too. The owner is org-wide and the channel's creator, so it
  // holds a channel row — delete it, leaving only `has_org_wide_scope = 1`, and the subscribe
  // must still be allowed. The unit test fakes the row; only this proves the SQL reads the
  // column. UNEXECUTED here: this file needs mysqld and this slice does not own `db-e2e.lock`.
  it('allows an org-wide principal to subscribe with no channel row', async () => {
    await db.admin.execute(
      'delete from conversation_memberships where organization_id = ? and conversation_id = ? and user_id = ?',
      [world.northstar.organizationId, conversationId, world.northstar.owner.id],
    );

    const client = await connectAs(world.northstar.owner.id);
    client.socket.send(JSON.stringify({ type: 'subscribe', conversationId }));
    expect(await client.next()).toMatchObject({ type: 'subscribed', conversationId });
    client.socket.close();
  });
});
