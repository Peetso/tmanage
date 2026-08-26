import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
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
 * REQ-001 and REQ-002 over real HTTP — the client request aggregate, its API, its projection,
 * and the transaction that turns an acceptance into committed work.
 *
 * One file for two tickets, and the file keeps REQ-001's name. They share the whole fixture —
 * a client organization, a shared project, a submitted request — and splitting them would mean
 * two suites building the same world and then disagreeing about it. REQ-002's cases are in
 * their own `describe` blocks at the end, so what each ticket proves is still legible.
 *
 * CLIENT-002 gave a client a portal to read. `client_request.submit` is in **every** client
 * role's ceiling — the one capability all four of them share — and until this ticket there was
 * nothing to submit to: a client could be shown work and could not answer.
 *
 * Six things only this suite can prove:
 *
 * 1. **A client can write.** The first and, today, only write a client principal makes anywhere
 *    in this system, and the studio sees it in a triage queue.
 * 2. **The lifecycle is `23-ERD` §6's, not a hand-written one.** An illegal move and a legal
 *    move missing its required facts are both refused by `clientRequestStateMachine`, and the
 *    refusal names the fields.
 * 3. **The two dates are different things.** `desiredAt` is what the client asked for;
 *    `committedAt` can only be written by an acceptance. That is US-B01's "date is requested,
 *    not committed" as a fact about the row rather than a caption on a screen.
 * 4. **The client projection is a projection.** No linked work item, no person, no internal
 *    state — CL-06's seven-word vocabulary instead.
 * 5. **Atlas cannot read, answer or withdraw Meridian's request**, the boundary
 *    `04-SECURITY-PRIVACY` §5 is most emphatic about.
 * 6. **§6's division of the machine holds from both sides.** Only an internal manager accepts,
 *    defers or declines; only the client withdraws.
 *
 * And what only REQ-002's blocks can prove:
 *
 * 7. **An acceptance and its work are one transaction.** A refused acceptance leaves no task in
 *    the plan describing work nobody agreed to — the property the two-write version could not
 *    have had, and the whole content of the ticket.
 * 8. **There is one door onto `accepted`.** The generic transitions route refuses it and says
 *    where to go, so the guarantee above survives a second author.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_requests_suite_x';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_requests_suite_xxxxx';

const CONFIG: ApiConfig = apiConfigFrom({
  NODE_ENV: 'test',
  SESSION_COOKIE_NAME: 'tmanage_session',
  SESSION_SECRET,
  SESSION_TTL_SECONDS: 900,
  REFRESH_TTL_SECONDS: 1_209_600,
  CSRF_SECRET,
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

interface ClientRequestClient {
  id: string;
  projectId: string;
  title: string;
  category: string;
  description: string;
  urgencyReason: string | null;
  desiredAt: string | null;
  status: string;
  clarificationQuestion: string | null;
  clientVisibleReason: string | null;
  clientSafeScopeSummary: string | null;
  commitment: string | null;
  committedAt: string | null;
  canWithdraw: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface AcceptanceResult {
  request: ClientRequestInternal;
  workItemId: string;
  workItemCreated: boolean;
}

interface ClientRequestInternal extends ClientRequestClient {
  clientOrganizationId: string;
  submittedByUserId: string;
  state: string;
  linkedWorkItemId: string | null;
}

const owner = () => world.northstar.owner;
const manager = () => world.northstar.manager;
const designer = () => world.northstar.designer;

/** Submit as an Atlas client member, the ordinary case every other test starts from. */
async function submit(
  session: Session,
  overrides: Record<string, unknown> = {},
): Promise<ClientRequestClient> {
  const response = await send('POST', '/portal/requests', session, {
    projectId: world.northstar.projectId,
    title: 'Add a careers page',
    description: 'We need a careers page before the recruitment round opens.',
    ...overrides,
  });
  if (response.statusCode !== 201) {
    throw new Error(`submit failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<ClientRequestClient>();
}

/** Move a request internally, as the studio would, returning the fresh internal record. */
async function move(
  session: Session,
  request: { id: string; version: number },
  to: string,
  facts: Record<string, unknown> = {},
): Promise<ClientRequestInternal> {
  const response = await send('POST', `/client-requests/${request.id}/transitions`, session, {
    version: request.version,
    to,
    ...facts,
  });
  if (response.statusCode !== 200) {
    throw new Error(`transition to ${to} failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<ClientRequestInternal>();
}

/**
 * Accept, through REQ-002's route. Returns the whole envelope, not just the request, because
 * what the acceptance *did to the plan* is the half this ticket added.
 */
async function accept(
  session: Session,
  request: { id: string; version: number },
  body: Record<string, unknown> = {},
): Promise<AcceptanceResult> {
  const response = await send('POST', `/client-requests/${request.id}/acceptance`, session, {
    version: request.version,
    clientSafeScopeSummary: 'A careers page with four roles and an application form.',
    commitment: 'unscheduled',
    ...body,
  });
  if (response.statusCode !== 200) {
    throw new Error(`accept failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<AcceptanceResult>();
}

async function countWorkItems(): Promise<number> {
  const [row] = await observe('select count(*) as c from work_items');
  return Number(row?.['c']);
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

describe('a client can finally answer', () => {
  it('submits a request against a project shared with them', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);

    expect(created.status).toBe('submitted');
    expect(created.title).toBe('Add a careers page');
    expect(created.version).toBe(1);

    const [row] = await observe(
      `select state as s, client_organization_id as c, submitted_by_user_id as u
         from client_requests where id = ?`,
      [created.id],
    );
    expect(String(row?.['s'])).toBe('submitted');
    // From the principal. There is no field on the body for either of these.
    expect(String(row?.['c'])).toBe(world.atlas.clientOrganizationId);
    expect(String(row?.['u'])).toBe(world.atlas.reviewer.id);
  });

  it('puts it in the studio’s triage queue', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);

    const studio = await signIn(manager().id);
    const response = await send('GET', '/client-requests', studio);

    expect(response.statusCode).toBe(200);
    const queue = response.json<{ clientRequests: ClientRequestInternal[] }>().clientRequests;
    expect(queue.map((request) => request.id)).toContain(created.id);
    // The internal record names which client asked, which the client's own view does not.
    expect(queue[0]?.clientOrganizationId).toBe(world.atlas.clientOrganizationId);
  });

  it('refuses a project that is not shared with this client, as a 404', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const response = await send('POST', '/portal/requests', client, {
      // A real Northstar project, and Atlas has no share in it.
      projectId: world.northstar.otherProjectId,
      title: 'Something about the brand refresh',
      description: 'A project this client organization cannot see.',
    });

    // 404 rather than 403: a client probing project ids must not learn which are real.
    expect(response.statusCode).toBe(404);
    const [count] = await observe('select count(*) as c from client_requests');
    expect(Number(count?.['c'])).toBe(0);
  });

  it('gives no internal role a way to submit one', async () => {
    // `12-PERMISSION-MATRIX` §2 gives "Submit client request" to no internal role. An agency
    // that could file requests as its own client would have a request log that proves nothing.
    const studio = await signIn(owner().id);
    const response = await send('POST', '/portal/requests', studio, {
      projectId: world.northstar.projectId,
      title: 'Filed on the client’s behalf',
      description: 'Which is exactly what must not be possible.',
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('the desired date is a request, never a commitment', () => {
  it('stores what the client asked for and commits to nothing', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client, { desiredAt: '2026-10-30T17:00:00.000Z' });

    expect(created.desiredAt).toBe('2026-10-30T17:00:00.000Z');
    expect(created.committedAt).toBeNull();
    expect(created.commitment).toBeNull();

    const [row] = await observe(
      'select committed_at as c, commitment as k from client_requests where id = ?',
      [created.id],
    );
    expect(row?.['c']).toBeNull();
    expect(row?.['k']).toBeNull();
  });

  it('refuses a bare calendar date rather than guessing a time of day', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const response = await send('POST', '/portal/requests', client, {
      projectId: world.northstar.projectId,
      title: 'Add a careers page',
      description: 'We need a careers page.',
      desiredAt: '2026-10-30',
    });

    expect(response.statusCode).toBe(400);
    const details = response.json<{ error: { details: { field: string }[] } }>().error.details;
    expect(details.map((d) => d.field)).toContain('desiredAt');
  });
});

describe('the lifecycle is 23-ERD §6’s, and the machine owns it', () => {
  it('refuses a move the diagram does not have', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);

    const studio = await signIn(manager().id);
    const before = await countWorkItems();
    const response = await send('POST', `/client-requests/${created.id}/acceptance`, studio, {
      version: created.version,
      clientSafeScopeSummary: 'A careers page with four roles.',
      commitment: 'unscheduled',
    });

    // §6 routes every acceptance through `triage`. Submitted straight to accepted is not a
    // narrower version of the same move; it is a move that does not exist.
    expect(response.statusCode).toBe(422);
    // REQ-002's property: the refusal took the work item with it.
    expect(await countWorkItems()).toBe(before);
  });

  it('names the facts a legal move arrived without', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');

    const response = await send('POST', `/client-requests/${created.id}/acceptance`, studio, {
      version: triaged.version,
    });

    // 400 rather than the machine's 422, and the difference is REQ-002's: acceptance now names
    // its own required fields, so a manager is told which one is missing before anything is
    // attempted. §6: "Acceptance requires client-safe scope summary, committed date or explicit
    // unscheduled state, and linked work." The third is no longer a field a caller supplies —
    // the route creates it.
    expect(response.statusCode).toBe(400);
    const details = response.json<{ error: { details: { field: string }[] } }>().error.details;
    expect(details.map((d) => d.field).sort()).toEqual(['clientSafeScopeSummary', 'commitment']);
  });

  it('requires a client-safe reason to decline', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');

    const response = await send('POST', `/client-requests/${created.id}/transitions`, studio, {
      version: triaged.version,
      to: 'declined',
    });

    expect(response.statusCode).toBe(422);
    const details = response.json<{ error: { details: { field: string }[] } }>().error.details;
    expect(details.map((d) => d.field)).toEqual(['clientVisibleReason']);
  });

  it('records a commitment as a date, and the client sees it', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);

    const triaged = await move(studio, created, 'triage');
    const { request: accepted, workItemId } = await accept(studio, triaged, {
      commitment: '2026-11-14T17:00:00.000Z',
    });

    expect(accepted.commitment).toBe('committed');
    expect(accepted.committedAt).toBe('2026-11-14T17:00:00.000Z');
    expect(accepted.linkedWorkItemId).toBe(workItemId);

    const seen = (
      await send('GET', `/portal/requests/${created.id}`, client)
    ).json<ClientRequestClient>();
    expect(seen.status).toBe('accepted');
    expect(seen.committedAt).toBe('2026-11-14T17:00:00.000Z');
    // Still what they asked for, unchanged by what was agreed.
    expect(seen.desiredAt).toBeNull();
  });

  it('records an explicit unscheduled acceptance with no date at all', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);

    const triaged = await move(studio, created, 'triage');
    const { request: accepted, workItemId } = await accept(studio, triaged, {
      clientSafeScopeSummary: 'A careers page, scope agreed, not yet scheduled.',
    });

    expect(accepted.commitment).toBe('unscheduled');
    expect(accepted.committedAt).toBeNull();

    // And the work carries no due date either, rather than one invented from today.
    const [row] = await observe('select due_at as d from work_items where id = ?', [workItemId]);
    expect(row?.['d']).toBeNull();
  });

  it('refuses a linked work item that is not in this tenant, as a 422 rather than a 500', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');

    const response = await send('POST', `/client-requests/${created.id}/acceptance`, studio, {
      version: triaged.version,
      clientSafeScopeSummary: 'A careers page.',
      commitment: 'unscheduled',
      // Another tenant's work item. `fk_client_requests_work_item_tenant` would refuse the row,
      // and a foreign-key violation surfaces as a 500 — which is the wrong way to tell a
      // manager they pasted the wrong id.
      linkedWorkItemId: world.twin.workItemId,
    });

    expect(response.statusCode).toBe(422);
    const details = response.json<{ error: { details: { field: string }[] } }>().error.details;
    expect(details.map((d) => d.field)).toEqual(['linkedWorkItemId']);
  });

  it('carries a clarification question through, and back', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);

    const triaged = await move(studio, created, 'triage');
    const asked = await move(studio, triaged, 'needs_clarification', {
      clarificationQuestion: 'How many roles should the page list at launch?',
    });
    expect(asked.state).toBe('needs_clarification');

    const returned = await move(studio, asked, 'triage');
    // Nothing is cleared. "What were they asked" is a question about the past that a later
    // state does not answer.
    expect(returned.clarificationQuestion).toBe('How many roles should the page list at launch?');
  });
});

describe('the client projection is a projection, not the record with fields removed', () => {
  it('carries no linked work item, no person, and no internal state', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');
    await accept(studio, triaged);

    const seen = (
      await send('GET', `/portal/requests/${created.id}`, client)
    ).json<ClientRequestClient>();

    expect(Object.keys(seen).sort()).toEqual([
      'canWithdraw',
      'category',
      'clarificationQuestion',
      'clientSafeScopeSummary',
      'clientVisibleReason',
      'commitment',
      'committedAt',
      'createdAt',
      'description',
      'desiredAt',
      'id',
      'projectId',
      'status',
      'title',
      'updatedAt',
      'urgencyReason',
      'version',
    ]);
  });

  it('says whether withdrawal is still open, which status alone cannot', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    // Fresh: `submitted -> withdrawn` is an arrow §6 draws.
    expect(created.canWithdraw).toBe(true);

    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');

    const underTriage = (
      await send('GET', `/portal/requests/${created.id}`, client)
    ).json<ClientRequestClient>();
    // Same `status` as before — and no longer withdrawable, because §6 has no arrow out of
    // `triage`. A screen working from `status` alone would offer a button that fails.
    expect(underTriage.status).toBe('submitted');
    expect(underTriage.canWithdraw).toBe(false);

    await move(studio, triaged, 'needs_clarification', {
      clarificationQuestion: 'How many roles should the page list at launch?',
    });
    const asked = (
      await send('GET', `/portal/requests/${created.id}`, client)
    ).json<ClientRequestClient>();
    expect(asked.canWithdraw).toBe(true);
  });

  it('shows a request under triage as still submitted', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    await move(studio, created, 'triage');

    const seen = (
      await send('GET', `/portal/requests/${created.id}`, client)
    ).json<ClientRequestClient>();
    // CL-06 lists seven statuses and `triage` is not one of them. "We are thinking about it"
    // is not a status a client should be invited to chase.
    expect(seen.status).toBe('submitted');
  });

  it('shows a request awaiting the client as clarifying, and says what was asked', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');
    await move(studio, triaged, 'needs_clarification', {
      clarificationQuestion: 'How many roles should the page list at launch?',
    });

    const seen = (
      await send('GET', `/portal/requests/${created.id}`, client)
    ).json<ClientRequestClient>();
    expect(seen.status).toBe('clarifying');
    expect(seen.clarificationQuestion).toBe('How many roles should the page list at launch?');
  });

  it('shows a decline with its client-safe reason', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');
    await move(studio, triaged, 'declined', {
      clientVisibleReason: 'This sits outside the current statement of work.',
    });

    const seen = (
      await send('GET', `/portal/requests/${created.id}`, client)
    ).json<ClientRequestClient>();
    expect(seen.status).toBe('declined');
    expect(seen.clientVisibleReason).toBe('This sits outside the current statement of work.');
  });
});

describe('one client of a studio cannot reach another’s requests', () => {
  it('does not list them', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    await submit(atlas);

    const meridian = await signIn(world.meridian.reviewer.id);
    const response = await send('GET', '/portal/requests', meridian);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ requests: ClientRequestClient[] }>().requests).toEqual([]);
  });

  it('answers 404 by id, not 403', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const created = await submit(atlas);

    const meridian = await signIn(world.meridian.reviewer.id);
    const response = await send('GET', `/portal/requests/${created.id}`, meridian);

    // 403 would confirm the request exists, which is the fact `04-SECURITY-PRIVACY` §5 says
    // one client must not be able to learn about another.
    expect(response.statusCode).toBe(404);
  });

  it('cannot withdraw them', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const created = await submit(atlas);

    const meridian = await signIn(world.meridian.reviewer.id);
    const response = await send('POST', `/portal/requests/${created.id}/withdrawal`, meridian, {
      version: created.version,
    });

    expect(response.statusCode).toBe(404);
    const [row] = await observe('select state as s from client_requests where id = ?', [
      created.id,
    ]);
    expect(String(row?.['s'])).toBe('submitted');
  });
});

describe('§6 divides the machine between two kinds of person', () => {
  it('lets the client withdraw their own request', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);

    const response = await send('POST', `/portal/requests/${created.id}/withdrawal`, client, {
      version: created.version,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<ClientRequestClient>().status).toBe('withdrawn');
  });

  it('does not let the client triage it', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);

    const response = await send('POST', `/client-requests/${created.id}/acceptance`, client, {
      version: created.version,
      clientSafeScopeSummary: 'Accepting my own request.',
      commitment: 'unscheduled',
    });

    // `client_request.triage` is in INTERNAL_ONLY_CAPABILITIES, so this is refused at the
    // capability guard before any row is read.
    expect(response.statusCode).toBe(403);
  });

  it('does not let an internal member without the capability triage it', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);

    // Lina is a `member`: work.read, work.update, and no `client_request.triage`. §6's "only
    // internal manager may accept/defer/decline" is a capability, not a convention.
    const lina = await signIn(designer().id);
    const response = await send('POST', `/client-requests/${created.id}/transitions`, lina, {
      version: created.version,
      to: 'triage',
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a withdrawal once the studio has picked the request up', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');

    const response = await send('POST', `/portal/requests/${created.id}/withdrawal`, client, {
      version: triaged.version,
    });

    // Found by this suite rather than by reading the diagram: §6 draws `submitted -> withdrawn`
    // and `needs_clarification -> withdrawn` and **no arrow out of `triage`**. So "the client
    // may withdraw before delivered" is narrower than it sounds — once somebody at the studio
    // has opened the request, withdrawing it is a conversation rather than a button. The
    // machine says so; nothing here restates it.
    expect(response.statusCode).toBe(422);
    const [row] = await observe('select state as s from client_requests where id = ?', [
      created.id,
    ]);
    expect(String(row?.['s'])).toBe('triage');
  });

  it('lets the client withdraw while the studio is waiting on their answer', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');
    const asked = await move(studio, triaged, 'needs_clarification', {
      clarificationQuestion: 'How many roles should the page list at launch?',
    });

    const response = await send('POST', `/portal/requests/${created.id}/withdrawal`, client, {
      version: asked.version,
    });

    // The other arrow §6 draws. A client asked a question they no longer want to answer can
    // close the request themselves.
    expect(response.statusCode).toBe(200);
    expect(response.json<ClientRequestClient>().status).toBe('withdrawn');
  });

  it('refuses a withdrawal once the work has been delivered', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(owner().id);

    const triaged = await move(studio, created, 'triage');
    const { request: accepted } = await accept(studio, triaged);
    const planned = await move(studio, accepted, 'planned');
    const delivered = await move(studio, planned, 'delivered');

    const response = await send('POST', `/portal/requests/${created.id}/withdrawal`, client, {
      version: delivered.version,
    });

    // §6: "Client may withdraw before delivered." The refusal is the machine's, not a check
    // written in the service.
    expect(response.statusCode).toBe(422);
  });
});

describe('concurrency', () => {
  it('refuses a stale version with 409 rather than losing the earlier write', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);

    // Two managers open the same request at version 1. Omar picks it up; Maya, still holding
    // the version she read, tries to decline it.
    const omar = await signIn(manager().id);
    const maya = await signIn(owner().id);
    await move(omar, created, 'triage');

    const response = await send('POST', `/client-requests/${created.id}/transitions`, maya, {
      version: created.version,
      to: 'declined',
      clientVisibleReason: 'This sits outside the current statement of work.',
    });

    // `triage -> declined` is a legal move, so the machine allows it and the **token** is what
    // refuses. 409 rather than 500: a conflict indistinguishable from a server fault is one a
    // caller retries, which is the lost update the token exists to prevent.
    expect(response.statusCode).toBe(409);
    const [row] = await observe('select state as s from client_requests where id = ?', [
      created.id,
    ]);
    expect(String(row?.['s'])).toBe('triage');
  });

  it('requires the token at all, so a caller cannot opt out of it', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);

    const response = await send('POST', `/portal/requests/${created.id}/withdrawal`, client, {});
    expect(response.statusCode).toBe(400);
  });
});

describe('the audit trail records the decision and never the prose', () => {
  it('writes client_request.submitted with identifiers and classifications only', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client, {
      category: 'new-page',
      urgencyReason: 'The recruitment round opens on the first of the month.',
    });

    const [row] = await observe(
      `select action as a, object_type as t, object_id as o, metadata_json as m
         from audit_events where action = 'client_request.submitted'`,
    );
    expect(String(row?.['a'])).toBe('client_request.submitted');
    expect(String(row?.['t'])).toBe('client_request');
    expect(String(row?.['o'])).toBe(created.id);

    const metadata = JSON.parse(
      typeof row?.['m'] === 'string' ? (row['m'] as string) : JSON.stringify(row?.['m']),
    ) as Record<string, unknown>;
    expect(metadata['category']).toBe('new-page');
    expect(metadata['urgency_stated']).toBe(true);
    expect(metadata['client_organization_id']).toBe(world.atlas.clientOrganizationId);
    // The sentence the client wrote is in the row, under the tenant's own access controls.
    // §12's metadata rule is identifiers and classifications, and this is the check that the
    // rule was applied rather than remembered.
    expect(JSON.stringify(metadata)).not.toContain('recruitment');
    expect(JSON.stringify(metadata)).not.toContain('careers');
  });

  it('writes client_request.transitioned naming which facts arrived, not what they said', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');
    await move(studio, triaged, 'declined', {
      clientVisibleReason: 'This sits outside the current statement of work.',
    });

    const rows = await observe(
      `select metadata_json as m from audit_events
        where action = 'client_request.transitioned' order by created_at asc, id asc`,
    );
    expect(rows).toHaveLength(2);

    const last = JSON.parse(
      typeof rows[1]?.['m'] === 'string'
        ? (rows[1]['m'] as string)
        : JSON.stringify(rows[1]?.['m']),
    ) as Record<string, unknown>;
    expect(last['state_before']).toBe('triage');
    expect(last['state_after']).toBe('declined');
    expect(last['facts_supplied']).toEqual(['clientVisibleReason']);
    expect(JSON.stringify(last)).not.toContain('statement of work');
  });

  it('refuses a category that is a sentence, because it would reach the audit trail', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const response = await send('POST', '/portal/requests', client, {
      projectId: world.northstar.projectId,
      title: 'Add a careers page',
      description: 'We need a careers page.',
      category: 'a whole sentence about what kind of request this is',
    });

    // A 400 naming the field, rather than a 500 at the audit write boundary — which is what
    // WORK-001's first suite run produced from the same shape of mistake.
    expect(response.statusCode).toBe(400);
    const details = response.json<{ error: { details: { field: string }[] } }>().error.details;
    expect(details.map((d) => d.field)).toEqual(['category']);
  });
});

describe('the engine holds what the application layer cannot', () => {
  it('refuses to move a request to another client organization, even on the admin connection', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);

    await expect(
      db.admin.execute('update client_requests set client_organization_id = ? where id = ?', [
        world.meridian.clientOrganizationId,
        created.id,
      ]),
    ).rejects.toThrow(/immutable/i);
  });

  it('refuses to move a request to another tenant, even on the admin connection', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);

    await expect(
      db.admin.execute('update client_requests set organization_id = ? where id = ?', [
        world.twin.organizationId,
        created.id,
      ]),
    ).rejects.toThrow(/immutable/i);
  });

  it('refuses a commitment with no date and a date with no commitment', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);

    await expect(
      db.admin.execute('update client_requests set commitment = ? where id = ?', [
        'committed',
        created.id,
      ]),
    ).rejects.toThrow(/committed_at/i);

    await expect(
      db.admin.execute('update client_requests set committed_at = now(3) where id = ?', [
        created.id,
      ]),
    ).rejects.toThrow(/commitment/i);
  });

  // Only meaningful when the runtime pool actually holds `tmanage_app` — otherwise there are
  // no grants to read, and asserting on their absence would prove nothing. Reported as a skip.
  it.skipIf(!usingLeastPrivilegeCredential)(
    'has no DELETE for the runtime credential to reach for',
    async () => {
      // `users.sql` grants INSERT and UPDATE on this table and nothing else. §6 gives the client
      // `withdrawn` and gives the studio no exit at all; a request the agency could erase would
      // be a request log that proves nothing.
      const grants = await observe("show grants for 'tmanage_app'@'%'");
      const line = grants
        .map((row) => String(Object.values(row)[0]))
        .find((text) => text.includes('`client_requests`'));
      expect(line, 'no grant names client_requests').toBeDefined();
      expect(line).not.toMatch(/DELETE/i);
    },
  );

  it('refuses an insert that forgets the state, rather than inventing one', async () => {
    // The column has no DEFAULT, unlike `work_items.state` — whose default names a state from
    // *this* lifecycle. Under STRICT_ALL_TABLES the omission is an error.
    await expect(
      db.admin.execute(
        `insert into client_requests
           (id, organization_id, project_id, client_organization_id, submitted_by_user_id,
            title, description)
         values (?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv7(),
          world.northstar.organizationId,
          world.northstar.projectId,
          world.atlas.clientOrganizationId,
          world.atlas.reviewer.id,
          'No state',
          'An insert that names no state.',
        ],
      ),
    ).rejects.toThrow(/state/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REQ-002 — accepting a request and committing the work as one unit
// ─────────────────────────────────────────────────────────────────────────────

describe('REQ-002: an acceptance and its work are one transaction', () => {
  it('creates the work item, links it, and dates it from the commitment', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');

    const result = await accept(studio, triaged, { commitment: '2026-11-14T17:00:00.000Z' });

    expect(result.workItemCreated).toBe(true);
    expect(result.request.linkedWorkItemId).toBe(result.workItemId);

    const [row] = await observe(
      `select title as t, project_id as p, state as s, audience as a, due_at as d
         from work_items where id = ?`,
      [result.workItemId],
    );
    // The client's own words, so the two stay findable from each other while there is no
    // messaging surface to carry the connection.
    expect(String(row?.['t'])).toBe('Add a careers page');
    expect(String(row?.['p'])).toBe(world.northstar.projectId);
    // The lifecycle's initial state, not something the acceptance chose.
    expect(String(row?.['s'])).toBe('backlog');
    // A committed date is a date the work is due.
    expect(new Date(String(row?.['d'])).toISOString()).toBe('2026-11-14T17:00:00.000Z');
    // `DEFAULT_AUDIENCE`. Accepting a client's request does not publish the studio's task.
    expect(String(row?.['a'])).toBe('internal');
  });

  it('leaves no work behind when the move is refused', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');

    const before = await countWorkItems();

    // A stale token: somebody moved the request between this manager reading it and accepting.
    const response = await send('POST', `/client-requests/${created.id}/acceptance`, studio, {
      version: created.version,
      clientSafeScopeSummary: 'A careers page.',
      commitment: 'unscheduled',
    });

    expect(response.statusCode).toBe(409);
    // The whole of REQ-002. Before this ticket the work item was a separate write that had
    // already succeeded, and a failed acceptance left a task in the plan describing work
    // nobody had agreed to.
    expect(await countWorkItems()).toBe(before);
    const [row] = await observe('select state as s from client_requests where id = ?', [
      created.id,
    ]);
    expect(String(row?.['s'])).toBe(triaged.state);
  });

  it('writes both audit rows, or neither', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');
    await accept(studio, triaged);

    const rows = await observe(
      `select action as a, metadata_json as m from audit_events
        where action in ('work_item.created', 'client_request.transitioned')
        order by created_at asc, id asc`,
    );
    const actions = rows.map((row) => String(row['a']));
    expect(actions).toEqual([
      'client_request.transitioned',
      'work_item.created',
      'client_request.transitioned',
    ]);

    const last = JSON.parse(
      typeof rows[2]?.['m'] === 'string'
        ? (rows[2]['m'] as string)
        : JSON.stringify(rows[2]?.['m']),
    ) as Record<string, unknown>;
    expect(last['state_after']).toBe('accepted');
    expect(last['work_item_created']).toBe(true);
  });

  it('links work that already exists instead of creating more', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');

    const before = await countWorkItems();
    const result = await accept(studio, triaged, {
      linkedWorkItemId: world.northstar.workItemId,
    });

    expect(result.workItemCreated).toBe(false);
    expect(result.workItemId).toBe(world.northstar.workItemId);
    expect(await countWorkItems()).toBe(before);
  });

  it('refuses a body that both names existing work and describes new work', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');

    const response = await send('POST', `/client-requests/${created.id}/acceptance`, studio, {
      version: triaged.version,
      clientSafeScopeSummary: 'A careers page.',
      commitment: 'unscheduled',
      linkedWorkItemId: world.northstar.workItemId,
      work: { title: 'Something else entirely' },
    });

    // Two different pieces of work for one acceptance. Refused rather than silently preferring
    // whichever the implementation happens to read first.
    expect(response.statusCode).toBe(400);
    const details = response.json<{ error: { details: { field: string }[] } }>().error.details;
    expect(details.map((d) => d.field)).toContain('work');
  });

  it('widens the new work item only when asked, and records that it did', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');

    const result = await accept(studio, triaged, {
      work: { audience: 'client_visible', title: 'Build the careers page' },
    });

    const [row] = await observe('select audience as a, title as t from work_items where id = ?', [
      result.workItemId,
    ]);
    expect(String(row?.['a'])).toBe('client_visible');
    expect(String(row?.['t'])).toBe('Build the careers page');

    // And the client can now see it in the portal, which is the point of having asked.
    const seen = (await send('GET', '/portal/work-items', client)).json<{
      workItems: { title: string }[];
    }>().workItems;
    expect(seen.map((item) => item.title)).toContain('Build the careers page');
  });

  it('closes acceptance off the generic transitions route, and says where to go', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');

    const response = await send('POST', `/client-requests/${created.id}/transitions`, studio, {
      version: triaged.version,
      to: 'accepted',
      clientSafeScopeSummary: 'A careers page.',
      commitment: 'unscheduled',
      linkedWorkItemId: world.northstar.workItemId,
    });

    // Leaving this open would leave an acceptance path that links work created anywhere, which
    // is the two-write version REQ-002 exists to remove.
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('acceptance');
  });

  it('refuses a manager who may triage but may not create work', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(manager().id);
    const triaged = await move(studio, created, 'triage');

    // Omar is a `manager` and holds both capabilities, so the refusal has to be produced by
    // taking one away. `work.create` is relation-gated on the project: strip his project
    // membership and he can still triage the request and can no longer file work into it.
    await db.admin.execute(
      'delete from project_memberships where organization_id = ? and project_id = ? and user_id = ?',
      [world.northstar.organizationId, world.northstar.projectId, manager().id],
    );

    const before = await countWorkItems();
    const response = await send('POST', `/client-requests/${created.id}/acceptance`, studio, {
      version: triaged.version,
      clientSafeScopeSummary: 'A careers page.',
      commitment: 'unscheduled',
    });

    expect(response.statusCode).toBe(404);
    expect(await countWorkItems()).toBe(before);
  });
});

describe('REQ-002: the history a triage decision is accounted for by', () => {
  it('returns the request’s own audit trail, newest facts included', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);
    const studio = await signIn(owner().id);
    const triaged = await move(studio, created, 'triage');
    await accept(studio, triaged);

    const response = await send('GET', `/client-requests/${created.id}/history`, studio);
    expect(response.statusCode).toBe(200);

    const history = response.json<{ history: { action: string; objectId: string }[] }>().history;
    // Newest first: `AuditEventsRepository.list` orders by `id` descending, and the ids are
    // UUIDv7, so id order is time order. A history screen reads downwards from what just
    // happened, which is the way anybody investigating a decision actually reads one.
    expect(history.map((row) => row.action)).toEqual([
      'client_request.transitioned',
      'client_request.transitioned',
      'client_request.submitted',
    ]);
    expect(new Set(history.map((row) => row.objectId))).toEqual(new Set([created.id]));
  });

  it('is not a second copy of the trail — the rows cannot be amended', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const created = await submit(client);

    // US-B02: "actor/time/history immutable". It is immutable because `audit_events` is
    // append-only at the engine, not because this endpoint declines to offer a writer.
    await expect(
      db.admin.execute('update audit_events set action = ? where object_id = ?', [
        'client_request.transitioned',
        created.id,
      ]),
    ).rejects.toThrow(/append-only|immutable/i);
  });

  it('answers 404 for a request in another tenant rather than an empty history', async () => {
    const studio = await signIn(manager().id);
    const response = await send('GET', `/client-requests/${world.twin.workItemId}/history`, studio);
    expect(response.statusCode).toBe(404);
  });
});
