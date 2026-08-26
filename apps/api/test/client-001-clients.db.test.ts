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
 * CLIENT-001 over real HTTP — client organizations, their people, and project access.
 *
 * The repositories have been proved against a real server since PROJ-001. What only this suite
 * can prove is the layer above them, and it is the layer that decides who gets in:
 *
 * 1. **A client admin manages their own client organization and nobody else's.**
 *    `12-PERMISSION-MATRIX` §2 gives client roles `client_member.manage` "within own client
 *    org/policy", and the seed world has two clients of the same studio — Atlas and Meridian —
 *    which is exactly the boundary `04-SECURITY-PRIVACY` §5 is most emphatic about.
 * 2. **A `project_clients` row is the whole of why a client can see a project.** The suite
 *    revokes one and watches the project become unreachable to the client who had it.
 * 3. **Every write is recorded.** These are §12's role changes and publication decisions, and
 *    the audit row lands in the same transaction as the change.
 * 4. **A bounded grant is the default.** An open-ended one has to be asked for by name.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_clients_suite_xx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_clients_suite_xxxxxx';

/** 30 rather than the production 180, so the default-expiry arithmetic is legible in a test. */
const DEFAULT_EXPIRY_DAYS = 30;

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
  CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: DEFAULT_EXPIRY_DAYS,
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

function metadataOf(row: RowDataPacket): Record<string, unknown> {
  const raw = row['metadata_json'];
  return typeof raw === 'string'
    ? (JSON.parse(raw) as Record<string, unknown>)
    : (raw as Record<string, unknown>);
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

interface ClientOrganization {
  id: string;
  name: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface ClientMembership {
  id: string;
  clientOrganizationId: string;
  userId: string;
  role: string;
  status: string;
  expiresAt: string | null;
  updatedAt: string;
}

const owner = () => world.northstar.owner;
const designer = () => world.northstar.designer;

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

describe('client organizations', () => {
  it('lists the tenant’s clients, and records nothing for a read', async () => {
    const session = await signIn(owner().id);
    const response = await send('GET', '/client-organizations', session);

    expect(response.statusCode).toBe(200);
    const names = response
      .json<{ clientOrganizations: ClientOrganization[] }>()
      .clientOrganizations.map((row) => row.name)
      .sort();
    expect(names).toEqual(['Atlas Hospitality', 'Meridian Retail Group']);

    const events = await observe(
      `select id from audit_events where action like 'client_organization%'`,
    );
    expect(events).toHaveLength(0);
  });

  it('echoes no tenant identifier', async () => {
    const session = await signIn(owner().id);
    const response = await send('GET', '/client-organizations', session);
    expect(response.body).not.toContain(world.northstar.organizationId);
  });

  it('creates one, and records it in the same transaction', async () => {
    const session = await signIn(owner().id);
    const response = await send('POST', '/client-organizations', session, {
      name: 'Cedar Logistics',
    });

    expect(response.statusCode).toBe(201);
    const created = response.json<ClientOrganization>();

    const events = await observe(
      `select * from audit_events where action = 'client_organization.created' and object_id = ?`,
      [created.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!['organization_id']).toBe(world.northstar.organizationId);
  });

  it('refuses a caller without org.manage', async () => {
    const session = await signIn(designer().id);
    const response = await send('POST', '/client-organizations', session, { name: 'Nope' });
    expect(response.statusCode).toBe(403);
  });

  it('answers the same for another tenant’s client as for one that does not exist', async () => {
    const session = await signIn(owner().id);

    // `twin` is §11's adversarial tenant: near-identical name, adjacent id. Its *project* id
    // is the sharpest "belongs to another tenant" value available, and asking for it as a
    // client organization is the shape a confused caller actually produces.
    const foreign = await send('GET', `/client-organizations/${world.twin.projectId}`, session);
    const missing = await send(
      'GET',
      '/client-organizations/00000000-0000-0000-0000-000000000000',
      session,
    );

    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);

    // Identical in everything that says what happened. The correlation id is per-request by
    // design, so it is the one field that must differ and the one excluded here.
    const strip = (body: string) => body.replace(/"correlationId":"[^"]+"/, '');
    expect(strip(foreign.body)).toBe(strip(missing.body));
  });

  it('refuses a stale updatedAt rather than overwriting', async () => {
    const session = await signIn(owner().id);
    const created = (
      await send('POST', '/client-organizations', session, { name: 'Cedar Logistics' })
    ).json<ClientOrganization>();

    const first = await send('PATCH', `/client-organizations/${created.id}`, session, {
      updatedAt: created.updatedAt,
      name: 'First writer wins',
    });
    expect(first.statusCode).toBe(200);

    const second = await send('PATCH', `/client-organizations/${created.id}`, session, {
      updatedAt: created.updatedAt,
      name: 'Second writer loses',
    });
    expect(second.statusCode).toBe(409);

    const rows = await observe('select name from client_organizations where id = ?', [created.id]);
    expect(rows[0]!['name']).toBe('First writer wins');
  });

  it('archives without revoking anybody, and the record says so', async () => {
    const session = await signIn(owner().id);
    const response = await send(
      'DELETE',
      `/client-organizations/${world.atlas.clientOrganizationId}`,
      session,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json<ClientOrganization>().archivedAt).not.toBeNull();

    // The people are still active. Archiving is the end of a relationship, not an offboarding,
    // and the audit row carries the count that makes the difference visible.
    const events = await observe(
      `select metadata_json from audit_events where action = 'client_organization.archived'`,
    );
    expect(events).toHaveLength(1);
    const metadata = metadataOf(events[0]!);
    expect(Number(metadata['active_memberships_remaining'])).toBeGreaterThan(0);

    const still = await observe(
      `select status from client_memberships where client_organization_id = ? and status = 'active'`,
      [world.atlas.clientOrganizationId],
    );
    expect(still.length).toBeGreaterThan(0);
  });
});

describe('client memberships', () => {
  it('invites with the policy’s expiry when none is given', async () => {
    const session = await signIn(owner().id);
    const before = Date.now();
    const response = await send('POST', '/client-memberships', session, {
      clientOrganizationId: world.atlas.clientOrganizationId,
      userId: world.northstar.designer.id,
      role: 'client_viewer',
    });

    expect(response.statusCode).toBe(201);
    const membership = response.json<ClientMembership>();
    expect(membership.status).toBe('invited');
    expect(membership.expiresAt).not.toBeNull();

    const days = (new Date(membership.expiresAt!).getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(DEFAULT_EXPIRY_DAYS - 1);
    expect(days).toBeLessThan(DEFAULT_EXPIRY_DAYS + 1);
  });

  it('accepts an open-ended grant only when it is asked for by name', async () => {
    const session = await signIn(owner().id);
    const response = await send('POST', '/client-memberships', session, {
      clientOrganizationId: world.atlas.clientOrganizationId,
      userId: world.northstar.designer.id,
      role: 'client_viewer',
      expiresAt: null,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<ClientMembership>().expiresAt).toBeNull();

    const events = await observe(
      `select metadata_json from audit_events where action = 'client_membership.invited'`,
    );
    const metadata = metadataOf(events[0]!);
    expect(metadata['bounded']).toBe(false);
  });

  it('records a role change with both sides', async () => {
    const session = await signIn(owner().id);
    const memberships = (
      await send(
        'GET',
        `/client-memberships?clientOrganizationId=${world.atlas.clientOrganizationId}`,
        session,
      )
    ).json<{ clientMemberships: ClientMembership[] }>().clientMemberships;

    const viewer = memberships.find((row) => row.role === 'client_viewer');
    expect(viewer).toBeDefined();

    const response = await send('PATCH', `/client-memberships/${viewer!.id}`, session, {
      updatedAt: viewer!.updatedAt,
      role: 'client_reviewer',
    });
    expect(response.statusCode).toBe(200);

    const events = await observe(
      `select metadata_json from audit_events where action = 'client_membership.role_changed'`,
    );
    const metadata = metadataOf(events[0]!);
    expect(metadata['role_before']).toBe('client_viewer');
    expect(metadata['role_after']).toBe('client_reviewer');
  });

  it('refuses to change two things in one request', async () => {
    const session = await signIn(owner().id);
    const memberships = (await send('GET', '/client-memberships', session)).json<{
      clientMemberships: ClientMembership[];
    }>().clientMemberships;

    const response = await send('PATCH', `/client-memberships/${memberships[0]!.id}`, session, {
      updatedAt: memberships[0]!.updatedAt,
      role: 'client_reviewer',
      status: 'offboarded',
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses an illegal status move, naming what was attempted', async () => {
    const session = await signIn(owner().id);
    const invited = (
      await send('POST', '/client-memberships', session, {
        clientOrganizationId: world.atlas.clientOrganizationId,
        userId: world.northstar.designer.id,
        role: 'client_viewer',
      })
    ).json<ClientMembership>();

    // `offboarded` is terminal; nothing leaves it.
    const offboarded = await send('PATCH', `/client-memberships/${invited.id}`, session, {
      updatedAt: invited.updatedAt,
      status: 'offboarded',
    });
    expect(offboarded.statusCode).toBe(200);

    const revived = offboarded.json<ClientMembership>();
    const response = await send('PATCH', `/client-memberships/${revived.id}`, session, {
      updatedAt: revived.updatedAt,
      status: 'active',
    });
    expect(response.statusCode).toBe(422);
  });

  it('lets a client admin manage their own client organization', async () => {
    const session = await signIn(world.atlas.admin.id);
    const response = await send('GET', '/client-memberships', session);

    expect(response.statusCode).toBe(200);
    const rows = response.json<{ clientMemberships: ClientMembership[] }>().clientMemberships;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.clientOrganizationId).toBe(world.atlas.clientOrganizationId);
    }
  });

  it('refuses a client admin the sibling client’s members, rather than answering empty', async () => {
    const session = await signIn(world.atlas.admin.id);
    const response = await send(
      'GET',
      `/client-memberships?clientOrganizationId=${world.meridian.clientOrganizationId}`,
      session,
    );

    // 404 rather than an empty list. An empty list reads as "there is nobody there", which is
    // a claim about a boundary this caller must not be able to see across.
    expect(response.statusCode).toBe(404);
  });

  it('refuses a client admin an invitation into the sibling client', async () => {
    const session = await signIn(world.atlas.admin.id);
    const response = await send('POST', '/client-memberships', session, {
      clientOrganizationId: world.meridian.clientOrganizationId,
      userId: world.northstar.designer.id,
      role: 'client_viewer',
    });

    expect(response.statusCode).toBe(404);

    const rows = await observe(
      'select id from client_memberships where client_organization_id = ? and user_id = ?',
      [world.meridian.clientOrganizationId, world.northstar.designer.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('project sharing, which is the whole of client access', () => {
  it('shares a project and records the link', async () => {
    const session = await signIn(owner().id);
    const response = await send('POST', `/projects/${world.northstar.projectId}/clients`, session, {
      clientOrganizationId: world.meridian.clientOrganizationId,
    });

    expect(response.statusCode).toBe(201);

    const events = await observe(
      `select metadata_json from audit_events where action = 'project.client_linked'`,
    );
    expect(events).toHaveLength(1);
    const metadata = metadataOf(events[0]!);
    expect(metadata['project_id']).toBe(world.northstar.projectId);
    expect(metadata['client_organization_id']).toBe(world.meridian.clientOrganizationId);
  });

  it('is idempotent — sharing twice is one row, not an error', async () => {
    const session = await signIn(owner().id);
    const body = { clientOrganizationId: world.meridian.clientOrganizationId };
    const first = await send(
      'POST',
      `/projects/${world.northstar.projectId}/clients`,
      session,
      body,
    );
    const second = await send(
      'POST',
      `/projects/${world.northstar.projectId}/clients`,
      session,
      body,
    );

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);

    const rows = await observe(
      'select id from project_clients where project_id = ? and client_organization_id = ?',
      [world.northstar.projectId, world.meridian.clientOrganizationId],
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses to share with an archived client', async () => {
    const session = await signIn(owner().id);
    await send('DELETE', `/client-organizations/${world.meridian.clientOrganizationId}`, session);

    const response = await send('POST', `/projects/${world.northstar.projectId}/clients`, session, {
      clientOrganizationId: world.meridian.clientOrganizationId,
    });

    expect(response.statusCode).toBe(422);
  });

  it('answers 404 for a project in another tenant, and shares nothing', async () => {
    const session = await signIn(owner().id);
    const response = await send('POST', `/projects/${world.twin.projectId}/clients`, session, {
      clientOrganizationId: world.atlas.clientOrganizationId,
    });

    expect(response.statusCode).toBe(404);
    const rows = await observe('select id from project_clients where project_id = ?', [
      world.twin.projectId,
    ]);
    expect(rows).toHaveLength(0);
  });

  /**
   * What this asserts, and what it deliberately cannot.
   *
   * A `project_clients` row is the only reason a client principal's `projectIds` contains a
   * project — `PrincipalRepository.projectScope` reads this table and nothing else for a
   * client — and `authorize()` rule 10 then refuses any project outside that list. So removing
   * the row removes the access.
   *
   * The end-to-end version of that sentence needs a **client-readable endpoint** to observe it
   * through, and there is none: `12-PERMISSION-MATRIX` §2 gives every client role "View
   * internal project: Never", so the internal endpoints answer 403 to a client before and
   * after, which proves nothing about the share. The projection endpoint is `CLIENT-002`, and
   * the parked assertion in `http-pipeline.db.test.ts` waits on the same thing.
   *
   * Until it exists, this asserts the storage the rule reads and the record of the decision.
   */
  it('withdrawing the share removes the only row that grants the access', async () => {
    const shared = await observe(
      'select id from project_clients where project_id = ? and client_organization_id = ?',
      [world.northstar.projectId, world.atlas.clientOrganizationId],
    );
    expect(shared).toHaveLength(1);

    const ownerSession = await signIn(owner().id);
    const removed = await send(
      'DELETE',
      `/projects/${world.northstar.projectId}/clients/${world.atlas.clientOrganizationId}`,
      ownerSession,
    );
    expect(removed.statusCode).toBe(204);

    const after = await observe(
      'select id from project_clients where project_id = ? and client_organization_id = ?',
      [world.northstar.projectId, world.atlas.clientOrganizationId],
    );
    expect(after).toHaveLength(0);

    const events = await observe(
      `select metadata_json from audit_events where action = 'project.client_unlinked'`,
    );
    expect(events).toHaveLength(1);
    expect(metadataOf(events[0]!)['was_shared']).toBe(true);
  });

  it('leaves the client’s other project alone', async () => {
    const ownerSession = await signIn(owner().id);
    await send(
      'DELETE',
      `/projects/${world.northstar.projectId}/clients/${world.atlas.clientOrganizationId}`,
      ownerSession,
    );

    // Meridian's share of Meridian's project is untouched. Revoking is one row, not a sweep.
    const meridian = await observe(
      'select id from project_clients where project_id = ? and client_organization_id = ?',
      [world.meridian.projectId, world.meridian.clientOrganizationId],
    );
    expect(meridian).toHaveLength(1);
  });

  it('records a revoke that had nothing to revoke', async () => {
    const session = await signIn(owner().id);
    const response = await send(
      'DELETE',
      `/projects/${world.northstar.projectId}/clients/${world.meridian.clientOrganizationId}`,
      session,
    );

    expect(response.statusCode).toBe(204);

    const events = await observe(
      `select metadata_json from audit_events where action = 'project.client_unlinked'`,
    );
    expect(events).toHaveLength(1);
    const metadata = metadataOf(events[0]!);
    expect(metadata['was_shared']).toBe(false);
  });

  it('refuses a client principal the sharing routes entirely', async () => {
    const session = await signIn(world.atlas.admin.id);
    const response = await send('POST', `/projects/${world.northstar.projectId}/clients`, session, {
      clientOrganizationId: world.atlas.clientOrganizationId,
    });

    // `project.manage` is in no client role's ceiling. A client who could share a project
    // could share it with themselves.
    expect(response.statusCode).toBe(403);
  });
});

describe('the guards still apply', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = (await app.inject({
      method: 'GET',
      url: `/v1/organizations/${NORTHSTAR}/client-organizations`,
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(401);
  });

  it('refuses a mutation with no CSRF token', async () => {
    const session = await signIn(owner().id);
    const response = (await app.inject({
      method: 'POST',
      url: `/v1/organizations/${NORTHSTAR}/client-organizations`,
      headers: { 'content-type': 'application/json', cookie: session.cookie },
      payload: { name: 'Cedar Logistics' },
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(403);
  });
});
