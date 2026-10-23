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
 * CLIENT-003 over real HTTP — BK1 (245b7365): client companies, the invitations issued into one
 * company, the New project client picker, and "set this project's client".
 *
 * CLIENT-001 proved the company and membership routes. What BK1 added, and only this suite proves:
 *
 * 1. **Only an administrator creates a company.** A manager can pick a client for a project
 *    (`project.create`) without being able to add one (`org.manage`), and a client admin can do
 *    neither.
 * 2. **The picker is this tenant's active clients and nothing else** — id and name, no tenant id,
 *    no archived company, nothing from the adversarial twin.
 * 3. **The per-company invitation list is per company** and 404s across the tenant boundary.
 * 4. **Accepting a client invitation binds the person to the company the invitation named**, and
 *    from then on they reach that company's requests and not the sibling's.
 * 5. **Setting a project's client replaces the share in one move** and refuses a foreign or
 *    archived company.
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

async function raw(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  session: Session,
  payload?: unknown,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

function send(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  session: Session,
  payload?: unknown,
  slug = NORTHSTAR,
): Promise<InjectedResponse> {
  return raw(method, `/v1/organizations/${slug}${path}`, session, payload);
}

interface Option {
  id: string;
  name: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  clientOrganizationId: string | null;
  status: string;
}

interface ProjectClient {
  clientOrganizationId: string;
}

const owner = () => world.northstar.owner;
const manager = () => world.northstar.manager;
const designer = () => world.northstar.designer;
/** Somebody with an account and no membership in Northstar. */
const outsider = () => world.brightops.owner;

async function issue(session: Session, body: Record<string, unknown>): Promise<string> {
  const response = await send('POST', '/invitations', session, body);
  if (response.statusCode !== 201) {
    throw new Error(`issue failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<{ token: string }>().token;
}

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({
    secretTag: 'the_client_003_suite',
    guardMode: 'enforce',
  }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
});

afterAll(async () => {
  await stopHarness({ app, db });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('only an administrator creates a client company', () => {
  it('refuses a manager, and writes nothing', async () => {
    const session = await signIn(manager().id);
    const response = await send('POST', '/client-organizations', session, { name: 'Cedar' });
    expect(response.statusCode).toBe(403);

    const rows = await observe('select id from client_organizations where name = ?', ['Cedar']);
    expect(rows).toHaveLength(0);
  });

  it('refuses a client admin, even for a company that would be theirs', async () => {
    const session = await signIn(world.atlas.admin.id);
    const response = await send('POST', '/client-organizations', session, { name: 'Atlas Two' });
    expect(response.statusCode).toBe(403);

    const rows = await observe('select id from client_organizations where name = ?', ['Atlas Two']);
    expect(rows).toHaveLength(0);
  });

  it('refuses a manager the full client list, which is the admin read', async () => {
    const session = await signIn(manager().id);
    const response = await send('GET', '/client-organizations', session);
    expect(response.statusCode).toBe(403);
  });

  it('lets the owner create one, in the owner’s tenant only', async () => {
    const session = await signIn(owner().id);
    const response = await send('POST', '/client-organizations', session, { name: 'Cedar' });
    expect(response.statusCode).toBe(201);

    const rows = await observe('select organization_id from client_organizations where name = ?', [
      'Cedar',
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['organization_id']).toBe(world.northstar.organizationId);
  });
});

describe('the New project client picker', () => {
  it('gives a manager the active clients by name, id and name only', async () => {
    const session = await signIn(manager().id);
    const response = await send('GET', '/client-organization-options', session);

    expect(response.statusCode).toBe(200);
    const options = response.json<{ clientOrganizations: Option[] }>().clientOrganizations;
    expect(options.map((o) => o.name)).toEqual(['Atlas Hospitality', 'Meridian Retail Group']);
    expect(options.map((o) => o.id).sort()).toEqual(
      [world.atlas.clientOrganizationId, world.meridian.clientOrganizationId].sort(),
    );
    for (const option of options) {
      expect(Object.keys(option).sort()).toEqual(['id', 'name']);
    }
    expect(response.body).not.toContain(world.northstar.organizationId);
  });

  it('leaves out an archived client', async () => {
    const ownerSession = await signIn(owner().id);
    const archived = await send(
      'DELETE',
      `/client-organizations/${world.meridian.clientOrganizationId}`,
      ownerSession,
    );
    expect(archived.statusCode).toBe(200);

    const response = await send('GET', '/client-organization-options', ownerSession);
    const names = response
      .json<{ clientOrganizations: Option[] }>()
      .clientOrganizations.map((o) => o.name);
    expect(names).toEqual(['Atlas Hospitality']);
  });

  it('shows the adversarial twin none of Northstar’s clients', async () => {
    const session = await signIn(world.twin.owner.id);
    const response = await send('GET', '/client-organization-options', session, undefined, TWIN);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ clientOrganizations: Option[] }>().clientOrganizations).toEqual([]);
    expect(response.body).not.toContain(world.atlas.clientOrganizationId);
    expect(response.body).not.toContain(world.meridian.clientOrganizationId);
  });

  it('refuses a member without project.create, and a client', async () => {
    const member = await signIn(designer().id);
    expect((await send('GET', '/client-organization-options', member)).statusCode).toBe(403);

    const client = await signIn(world.atlas.admin.id);
    expect((await send('GET', '/client-organization-options', client)).statusCode).toBe(403);
  });
});

describe('invitations listed per client company', () => {
  it('lists only the invitations issued into that company', async () => {
    const session = await signIn(owner().id);
    await issue(session, {
      email: 'karim@atlas.example',
      role: 'client_viewer',
      clientOrganizationId: world.atlas.clientOrganizationId,
    });
    await issue(session, {
      email: 'laila@meridian.example',
      role: 'client_viewer',
      clientOrganizationId: world.meridian.clientOrganizationId,
    });
    await issue(session, { email: 'staff@northstar.example', role: 'member' });

    const response = await send(
      'GET',
      `/client-organizations/${world.atlas.clientOrganizationId}/invitations`,
      session,
    );
    expect(response.statusCode).toBe(200);
    const invitations = response.json<{ invitations: Invitation[] }>().invitations;
    expect(invitations.map((i) => i.email)).toEqual(['karim@atlas.example']);
    expect(invitations[0]!.clientOrganizationId).toBe(world.atlas.clientOrganizationId);
    expect(invitations[0]!.status).toBe('pending');
  });

  it('answers 404 for a company of another tenant, from either side', async () => {
    const session = await signIn(owner().id);
    await issue(session, {
      email: 'karim@atlas.example',
      role: 'client_viewer',
      clientOrganizationId: world.atlas.clientOrganizationId,
    });

    const foreignId = await send(
      'GET',
      `/client-organizations/${world.twin.projectId}/invitations`,
      session,
    );
    expect(foreignId.statusCode).toBe(404);

    const twin = await signIn(world.twin.owner.id);
    const fromTwin = await send(
      'GET',
      `/client-organizations/${world.atlas.clientOrganizationId}/invitations`,
      twin,
      undefined,
      TWIN,
    );
    expect(fromTwin.statusCode).toBe(404);
    expect(fromTwin.body).not.toContain('karim@atlas.example');
  });

  it('refuses a manager and a client admin', async () => {
    const path = `/client-organizations/${world.atlas.clientOrganizationId}/invitations`;
    expect((await send('GET', path, await signIn(manager().id))).statusCode).toBe(403);
    expect((await send('GET', path, await signIn(world.atlas.admin.id))).statusCode).toBe(403);
  });

  it('refuses an unknown status filter', async () => {
    const session = await signIn(owner().id);
    const response = await send(
      'GET',
      `/client-organizations/${world.atlas.clientOrganizationId}/invitations?status=bogus`,
      session,
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('accepting a client invitation binds to the named company', () => {
  it('creates the membership in Meridian, not Atlas, and the person reaches Meridian’s requests only', async () => {
    const studio = await signIn(owner().id);
    const token = await issue(studio, {
      email: 'tarek.said@brightops.example',
      role: 'client_reviewer',
      clientOrganizationId: world.meridian.clientOrganizationId,
    });

    const invitee = await signIn(outsider().id);
    const accepted = await raw('POST', '/v1/invitations/acceptances', invitee, { token });
    expect(accepted.statusCode).toBe(201);

    const memberships = await observe(
      'select client_organization_id, status, role from client_memberships where user_id = ?',
      [outsider().id],
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!['client_organization_id']).toBe(world.meridian.clientOrganizationId);
    expect(memberships[0]!['status']).toBe('active');
    expect(memberships[0]!['role']).toBe('client_reviewer');

    // One request in each company, filed by each company's own reviewer.
    const atlasClient = await signIn(world.atlas.reviewer.id);
    const atlasRequest = await send('POST', '/portal/requests', atlasClient, {
      projectId: world.northstar.projectId,
      title: 'Atlas request',
      description: 'Filed by Atlas.',
    });
    expect(atlasRequest.statusCode).toBe(201);
    const meridianClient = await signIn(world.meridian.reviewer.id);
    const meridianRequest = await send('POST', '/portal/requests', meridianClient, {
      projectId: world.meridian.projectId,
      title: 'Meridian request',
      description: 'Filed by Meridian.',
    });
    expect(meridianRequest.statusCode).toBe(201);
    const atlasId = atlasRequest.json<{ id: string }>().id;
    const meridianId = meridianRequest.json<{ id: string }>().id;

    // A fresh session after acceptance, so the principal is built from the new membership.
    const member = await signIn(outsider().id);
    const own = await send('GET', `/portal/requests/${meridianId}/messages`, member);
    expect(own.statusCode).toBe(200);
    const sibling = await send('GET', `/portal/requests/${atlasId}/messages`, member);
    expect(sibling.statusCode).toBe(404);
    const write = await send('POST', `/portal/requests/${atlasId}/messages`, member, {
      body: 'Should not land',
    });
    expect(write.statusCode).toBe(404);
    const written = await observe('select id from request_messages where request_id = ?', [
      atlasId,
    ]);
    expect(written).toHaveLength(0);
  });
});

describe('setting a project’s single client', () => {
  it('replaces Atlas with Meridian in one move', async () => {
    const session = await signIn(owner().id);
    const response = await send('PUT', `/projects/${world.northstar.projectId}/client`, session, {
      clientOrganizationId: world.meridian.clientOrganizationId,
    });
    expect(response.statusCode).toBe(200);
    const clients = response.json<{ clients: ProjectClient[] }>().clients;
    expect(clients.map((c) => c.clientOrganizationId)).toEqual([
      world.meridian.clientOrganizationId,
    ]);

    const rows = await observe(
      'select client_organization_id from project_clients where project_id = ?',
      [world.northstar.projectId],
    );
    expect(rows.map((r) => r['client_organization_id'])).toEqual([
      world.meridian.clientOrganizationId,
    ]);
  });

  it('clears the client with null', async () => {
    const session = await signIn(owner().id);
    const response = await send('PUT', `/projects/${world.northstar.projectId}/client`, session, {
      clientOrganizationId: null,
    });
    expect(response.statusCode).toBe(200);
    const rows = await observe('select id from project_clients where project_id = ?', [
      world.northstar.projectId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('refuses a company that is not this tenant’s, and leaves the share as it was', async () => {
    const session = await signIn(owner().id);
    const response = await send('PUT', `/projects/${world.northstar.projectId}/client`, session, {
      clientOrganizationId: world.twin.projectId,
    });
    expect(response.statusCode).toBe(404);

    const rows = await observe(
      'select client_organization_id from project_clients where project_id = ?',
      [world.northstar.projectId],
    );
    expect(rows.map((r) => r['client_organization_id'])).toEqual([
      world.atlas.clientOrganizationId,
    ]);
  });

  it('refuses an archived company with 422', async () => {
    const session = await signIn(owner().id);
    await send('DELETE', `/client-organizations/${world.meridian.clientOrganizationId}`, session);
    const response = await send('PUT', `/projects/${world.northstar.projectId}/client`, session, {
      clientOrganizationId: world.meridian.clientOrganizationId,
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a client principal and a project of another tenant', async () => {
    const client = await signIn(world.atlas.admin.id);
    const byClient = await send('PUT', `/projects/${world.northstar.projectId}/client`, client, {
      clientOrganizationId: world.atlas.clientOrganizationId,
    });
    expect(byClient.statusCode).toBe(403);

    const session = await signIn(owner().id);
    const foreign = await send('PUT', `/projects/${world.twin.projectId}/client`, session, {
      clientOrganizationId: world.atlas.clientOrganizationId,
    });
    expect(foreign.statusCode).toBe(404);
    const rows = await observe('select id from project_clients where project_id = ?', [
      world.twin.projectId,
    ]);
    expect(rows).toHaveLength(0);
  });
});
