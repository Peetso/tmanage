import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';
import {
  bootHttpHarness,
  reseed,
  signIn as harnessSignIn,
  stopHarness,
} from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';

/**
 * REQ-003 over real HTTP — BG3 (cff0eb3a, migration 0212): the client <-> studio thread on a
 * client request, through its two doors.
 *
 * 1. **Both sides can talk.** A client posts on the portal door, the studio reads it on the team
 *    door, and the studio's reply reaches the client.
 * 2. **A team-only note stays team-only.** The client read never selects it, and the client view
 *    carries no staff identity.
 * 3. **Atlas cannot read or write Meridian's thread**, and the adversarial twin cannot reach
 *    Northstar's — each the same 404, with nothing written.
 * 4. **Each door is one side's.** A client is refused the team door; the studio the portal door;
 *    a member without triage the team door.
 * 5. **Every post lands its outbox event in the same transaction**, ids only.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId);
}

const NORTHSTAR = 'northstar-studio';
const TWIN = 'northstar-studios';

async function send(
  method: 'GET' | 'POST',
  path: string,
  session: Session,
  payload?: unknown,
  slug = NORTHSTAR,
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

interface TeamMessage {
  id: string;
  requestId: string;
  authorMembershipId: string;
  authorKind: 'internal' | 'client';
  body: string;
  clientVisible: boolean;
}

interface ClientMessage {
  id: string;
  requestId: string;
  from: 'studio' | 'client';
  mine: boolean;
  body: string;
}

const manager = () => world.northstar.manager;
const designer = () => world.northstar.designer;

/** A request filed by a client reviewer on a project shared with their company. */
async function fileRequest(session: Session, projectId: string): Promise<string> {
  const response = await send('POST', '/portal/requests', session, {
    projectId,
    title: 'Add a careers page',
    description: 'We need a careers page before the recruitment round opens.',
  });
  if (response.statusCode !== 201) {
    throw new Error(`submit failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<{ id: string }>().id;
}

async function countMessages(requestId: string): Promise<number> {
  const [row] = await observe('select count(*) as c from request_messages where request_id = ?', [
    requestId,
  ]);
  return Number(row?.['c']);
}

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_req_003_suite', guardMode: 'enforce' }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
});

afterAll(async () => {
  await stopHarness({ app, db });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('both sides of the thread', () => {
  it('carries a client message to the team and a reply back to the client', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const requestId = await fileRequest(client, world.northstar.projectId);

    const posted = await send('POST', `/portal/requests/${requestId}/messages`, client, {
      body: 'Can it go live before the 1st?',
    });
    expect(posted.statusCode).toBe(201);
    const clientView = posted.json<ClientMessage>();
    expect(clientView.from).toBe('client');
    expect(clientView.mine).toBe(true);

    const studio = await signIn(manager().id);
    const teamList = await send('GET', `/client-requests/${requestId}/messages`, studio);
    expect(teamList.statusCode).toBe(200);
    const teamMessages = teamList.json<{ messages: TeamMessage[] }>().messages;
    expect(teamMessages).toHaveLength(1);
    expect(teamMessages[0]!.authorKind).toBe('client');
    expect(teamMessages[0]!.authorMembershipId).toBe(world.atlas.reviewer.membershipId);

    const reply = await send('POST', `/client-requests/${requestId}/messages`, studio, {
      body: 'Yes, we can.',
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json<TeamMessage>().clientVisible).toBe(true);

    const clientList = await send('GET', `/portal/requests/${requestId}/messages`, client);
    expect(clientList.statusCode).toBe(200);
    const seen = clientList.json<{ messages: ClientMessage[] }>().messages;
    expect(seen.map((m) => [m.from, m.mine, m.body])).toEqual([
      ['client', true, 'Can it go live before the 1st?'],
      ['studio', false, 'Yes, we can.'],
    ]);
  });

  it('lets another person of the same client company read the thread', async () => {
    const reviewer = await signIn(world.atlas.reviewer.id);
    const requestId = await fileRequest(reviewer, world.northstar.projectId);
    await send('POST', `/portal/requests/${requestId}/messages`, reviewer, { body: 'Hello' });

    const colleague = await signIn(world.atlas.admin.id);
    const response = await send('GET', `/portal/requests/${requestId}/messages`, colleague);
    expect(response.statusCode).toBe(200);
    const messages = response.json<{ messages: ClientMessage[] }>().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.from).toBe('client');
    expect(messages[0]!.mine).toBe(false);
  });
});

describe('a team-only note', () => {
  it('is never shown to the client, and the client view names no staff member', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const requestId = await fileRequest(client, world.northstar.projectId);

    const studio = await signIn(manager().id);
    const note = await send('POST', `/client-requests/${requestId}/messages`, studio, {
      body: 'Internal: budget is tight',
      clientVisible: false,
    });
    expect(note.statusCode).toBe(201);
    await send('POST', `/client-requests/${requestId}/messages`, studio, { body: 'On it.' });

    const team = await send('GET', `/client-requests/${requestId}/messages`, studio);
    expect(team.json<{ messages: TeamMessage[] }>().messages).toHaveLength(2);

    const response = await send('GET', `/portal/requests/${requestId}/messages`, client);
    expect(response.statusCode).toBe(200);
    const messages = response.json<{ messages: ClientMessage[] }>().messages;
    expect(messages.map((m) => m.body)).toEqual(['On it.']);
    expect(response.body).not.toContain('budget is tight');
    expect(response.body).not.toContain(world.northstar.manager.membershipId);
    expect(response.body).not.toContain('authorMembershipId');
  });

  it('cannot be written by a client: the portal door ignores clientVisible', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const requestId = await fileRequest(client, world.northstar.projectId);
    const posted = await send('POST', `/portal/requests/${requestId}/messages`, client, {
      body: 'Try to hide this',
      clientVisible: false,
    });
    expect(posted.statusCode).toBe(201);

    const [row] = await observe(
      'select client_visible from request_messages where request_id = ?',
      [requestId],
    );
    expect(Number(row?.['client_visible'])).toBe(1);
  });
});

describe('the client-to-client boundary', () => {
  it('refuses Meridian Atlas’s thread as a 404, read or write, and writes nothing', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const requestId = await fileRequest(atlas, world.northstar.projectId);
    await send('POST', `/portal/requests/${requestId}/messages`, atlas, { body: 'Atlas only' });

    const meridian = await signIn(world.meridian.reviewer.id);
    const read = await send('GET', `/portal/requests/${requestId}/messages`, meridian);
    const write = await send('POST', `/portal/requests/${requestId}/messages`, meridian, {
      body: 'Meridian intrudes',
    });
    const missing = await send(
      'GET',
      '/portal/requests/00000000-0000-0000-0000-000000000000/messages',
      meridian,
    );

    expect(read.statusCode).toBe(404);
    expect(write.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    const strip = (body: string) => body.replace(/"correlationId":"[^"]+"/, '');
    expect(strip(read.body)).toBe(strip(missing.body));
    expect(read.body).not.toContain('Atlas only');
    expect(await countMessages(requestId)).toBe(1);
  });

  it('keeps Meridian’s own thread working for Meridian', async () => {
    const meridian = await signIn(world.meridian.reviewer.id);
    const requestId = await fileRequest(meridian, world.meridian.projectId);
    const posted = await send('POST', `/portal/requests/${requestId}/messages`, meridian, {
      body: 'Meridian here',
    });
    expect(posted.statusCode).toBe(201);

    const atlas = await signIn(world.atlas.reviewer.id);
    expect((await send('GET', `/portal/requests/${requestId}/messages`, atlas)).statusCode).toBe(
      404,
    );
  });
});

describe('tenant isolation', () => {
  it('gives the adversarial twin a 404 on Northstar’s request, through its own slug', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const requestId = await fileRequest(client, world.northstar.projectId);
    await send('POST', `/portal/requests/${requestId}/messages`, client, {
      body: 'Northstar only',
    });

    const twin = await signIn(world.twin.owner.id);
    const read = await send('GET', `/client-requests/${requestId}/messages`, twin, undefined, TWIN);
    const write = await send(
      'POST',
      `/client-requests/${requestId}/messages`,
      twin,
      { body: 'Twin intrudes' },
      TWIN,
    );

    expect(read.statusCode).toBe(404);
    expect(write.statusCode).toBe(404);
    expect(read.body).not.toContain('Northstar only');
    expect(await countMessages(requestId)).toBe(1);
    const twinRows = await observe('select id from request_messages where organization_id = ?', [
      world.twin.organizationId,
    ]);
    expect(twinRows).toHaveLength(0);
  });

  it('refuses the twin owner on Northstar’s slug, where they have no membership', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const requestId = await fileRequest(client, world.northstar.projectId);

    const twin = await signIn(world.twin.owner.id);
    const response = await send('GET', `/client-requests/${requestId}/messages`, twin);
    expect([403, 404]).toContain(response.statusCode);
  });
});

describe('each door belongs to one side', () => {
  it('refuses a client the team door', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const requestId = await fileRequest(client, world.northstar.projectId);

    expect((await send('GET', `/client-requests/${requestId}/messages`, client)).statusCode).toBe(
      403,
    );
    const write = await send('POST', `/client-requests/${requestId}/messages`, client, {
      body: 'Pretend to be the studio',
      clientVisible: false,
    });
    expect(write.statusCode).toBe(403);
    expect(await countMessages(requestId)).toBe(0);
  });

  it('refuses the studio the portal door', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const requestId = await fileRequest(client, world.northstar.projectId);

    const studio = await signIn(manager().id);
    const write = await send('POST', `/portal/requests/${requestId}/messages`, studio, {
      body: 'Pretend to be the client',
    });
    expect(write.statusCode).toBe(403);
    expect(await countMessages(requestId)).toBe(0);
  });

  it('refuses a member without triage the team door', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const requestId = await fileRequest(client, world.northstar.projectId);

    const member = await signIn(designer().id);
    expect((await send('GET', `/client-requests/${requestId}/messages`, member)).statusCode).toBe(
      403,
    );
  });

  it('refuses an empty body', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const requestId = await fileRequest(client, world.northstar.projectId);
    const response = await send('POST', `/portal/requests/${requestId}/messages`, client, {
      body: '   ',
    });
    expect(response.statusCode).toBe(400);
    expect(await countMessages(requestId)).toBe(0);
  });
});

describe('the outbox', () => {
  it('records one message_posted event per post, ids only', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const requestId = await fileRequest(client, world.northstar.projectId);
    const posted = await send('POST', `/portal/requests/${requestId}/messages`, client, {
      body: 'A secret phrase',
    });
    const messageId = posted.json<ClientMessage>().id;

    const events = await observe(
      `select organization_id, payload_json as p from outbox_events
        where aggregate_id = ? and type = 'client_request.message_posted.v1'`,
      [requestId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!['organization_id']).toBe(world.northstar.organizationId);
    const raw = events[0]!['p'];
    const payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    expect(payload['messageId']).toBe(messageId);
    expect(payload['clientOrganizationId']).toBe(world.atlas.clientOrganizationId);
    expect(payload['authorKind']).toBe('client');
    expect(JSON.stringify(payload)).not.toContain('A secret phrase');
  });
});
