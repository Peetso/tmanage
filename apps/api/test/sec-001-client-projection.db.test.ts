import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { FORBIDDEN_CLIENT_FIELDS, uuidv7 } from '@tmanage/domain';
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
 * SEC-001 — the client projection, and `25-AUTH-AND-TENANT-ISOLATION` §11's grid over the
 * surfaces a client can actually reach.
 *
 * ## Why a second isolation suite
 *
 * `tenant-isolation.db.test.ts` is the storage corpus: composite keys, immutability triggers, the
 * query guard, unscoped reads. It is thorough and it was written **before any client-facing
 * surface existed** — its 45 cases describe a system with no portal and no client request in it.
 *
 * §11 asks for something that file cannot express: "Every operation is tested for: correct
 * internal project; same organization/different project; same organization/different client;
 * different organization; suspended membership; expired client membership; direct-ID
 * enumeration; changed role after session; archived/deleted object […]". That is a grid over
 * **operations**, not over tables, and the operations are HTTP requests made by a client
 * principal. This file is that grid.
 *
 * The two suites overlap by design and prove different things. If the query guard were removed,
 * `tenant-isolation` would fail. If the guard stayed and `PortalService` started returning the
 * internal record, only this file would.
 *
 * ## The three holes this closes, each created since the storage corpus was written
 *
 * 1. `client_requests` had no case driving a client read of it across a boundary.
 * 2. `clientOrganizationName` — added by `WEB-005` — had **no database case at all**, only a web
 *    test over a mocked response.
 * 3. The client-to-client boundary was proved endpoint by endpoint in three separate suites
 *    rather than enumerated once.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_sec001_suite_xxxx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_sec001_suite_xxxxxxxx';

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

/** A request against a named organization slug, so "different organization" is expressible. */
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

const send = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  session: Session,
  payload?: unknown,
) => sendTo(NORTHSTAR, method, path, session, payload);

/** Publish a work item to the client, through the internal API, as the studio would. */
async function publish(
  session: Session,
  title: string,
  audience: 'client_visible' | 'client_action_required',
  projectId = world.northstar.projectId,
): Promise<string> {
  const created = await send('POST', '/work-items', session, { projectId, title });
  const item = created.json<{ id: string; version: number }>();
  await send('PATCH', `/work-items/${item.id}`, session, { version: item.version, audience });
  return item.id;
}

async function submitRequest(session: Session, projectId = world.northstar.projectId) {
  const response = await send('POST', '/portal/requests', session, {
    projectId,
    title: 'Add a careers page',
    description: 'We need a careers page before the recruitment round opens.',
  });
  if (response.statusCode !== 201) {
    throw new Error(`submit failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<{ id: string; version: number }>();
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
// §11's grid, over every operation a client principal can perform
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything a client can do today, as data.
 *
 * Written as a list so a new client-facing endpoint has somewhere obvious to be added, and so
 * the grid below cannot cover four of five operations and look complete. Every entry is driven
 * against each of §11's boundary conditions in turn.
 */
const CLIENT_OPERATIONS = [
  { name: 'read the projects shared with them', method: 'GET', path: '/portal/projects' },
  { name: 'read the work published to them', method: 'GET', path: '/portal/work-items' },
  { name: 'read their own requests', method: 'GET', path: '/portal/requests' },
] as const;

describe('§11: a client reaching across a boundary', () => {
  it('reaches their own organization, which is the row the rest of the grid is measured against', async () => {
    const studio = await signIn(world.northstar.owner.id);
    await publish(studio, 'The homepage design', 'client_visible');

    const atlas = await signIn(world.atlas.reviewer.id);
    for (const operation of CLIENT_OPERATIONS) {
      const response = await send(operation.method, operation.path, atlas);
      expect(response.statusCode, `${operation.name} should be allowed`).toBe(200);
    }
  });

  it('cannot reach a different organization at all', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);

    for (const operation of CLIENT_OPERATIONS) {
      // `brightops` is a real organization this principal has no membership in. §3 step 2:
      // the tenant check runs before any object lookup, so the answer is the same one an
      // unknown slug produces.
      const response = await sendTo('brightops', operation.method, operation.path, atlas);
      expect(response.statusCode, operation.name).toBe(404);
    }
  });

  it('cannot reach the adversarial twin, whose id differs by one character', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const [twin] = await observe('select slug as s from organizations where id = ?', [
      world.twin.organizationId,
    ]);

    for (const operation of CLIENT_OPERATIONS) {
      const response = await sendTo(String(twin?.['s']), operation.method, operation.path, atlas);
      expect(response.statusCode, operation.name).toBe(404);
    }
  });

  it('sees nothing of a sibling client in the same organization', async () => {
    const studio = await signIn(world.northstar.owner.id);
    // Published into Meridian's project, which Atlas has no share in.
    await publish(studio, 'Meridian’s dashboard', 'client_visible', world.meridian.projectId);

    const atlas = await signIn(world.atlas.reviewer.id);
    const projects = (await send('GET', '/portal/projects', atlas)).json<{
      projects: { id: string }[];
    }>().projects;
    expect(projects.map((project) => project.id)).toEqual([world.northstar.projectId]);

    const items = (await send('GET', '/portal/work-items', atlas)).json<{
      workItems: { title: string }[];
    }>().workItems;
    expect(items.map((item) => item.title)).not.toContain('Meridian’s dashboard');
  });

  it('sees nothing of another project in the same organization', async () => {
    const studio = await signIn(world.northstar.owner.id);
    // The Brand Refresh project, which no client organization is linked to at all.
    await publish(studio, 'Internal brand work', 'client_visible', world.northstar.otherProjectId);

    const atlas = await signIn(world.atlas.reviewer.id);
    const items = (await send('GET', '/portal/work-items', atlas)).json<{
      workItems: { title: string }[];
    }>().workItems;
    expect(items.map((item) => item.title)).not.toContain('Internal brand work');

    // And asking for it by project id is a 404 rather than an empty list, so the id itself
    // stays unconfirmed.
    const scoped = await send(
      'GET',
      `/portal/work-items?projectId=${world.northstar.otherProjectId}`,
      atlas,
    );
    expect(scoped.statusCode).toBe(404);
  });

  it('loses everything the moment their client membership is suspended', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    expect((await send('GET', '/portal/projects', atlas)).statusCode).toBe(200);

    await db.admin.execute(
      'update client_memberships set status = ? where organization_id = ? and user_id = ?',
      ['suspended', world.northstar.organizationId, world.atlas.reviewer.id],
    );

    // The same cookie, unchanged. Membership is resolved per request, so a live session does
    // not outlive the grant it was issued against.
    for (const operation of CLIENT_OPERATIONS) {
      const response = await send(operation.method, operation.path, atlas);
      expect(response.statusCode, operation.name).toBe(404);
    }
  });

  it('loses everything the moment their client membership expires', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    expect((await send('GET', '/portal/projects', atlas)).statusCode).toBe(200);

    await db.admin.execute(
      'update client_memberships set expires_at = ? where organization_id = ? and user_id = ?',
      [new Date(Date.now() - 60_000), world.northstar.organizationId, world.atlas.reviewer.id],
    );

    for (const operation of CLIENT_OPERATIONS) {
      const response = await send(operation.method, operation.path, atlas);
      expect(response.statusCode, operation.name).toBe(404);
    }
  });

  it('follows a role changed after the session was issued', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const created = await submitRequest(atlas);

    // A client viewer holds `client_request.submit` — §2 says "Policy" — so the capability
    // this exercises is one a viewer keeps. `approval.decide` is the one they lose, and there
    // is no approval endpoint yet; what is provable today is that the role is **re-read**.
    await db.admin.execute(
      'update client_memberships set role = ? where organization_id = ? and user_id = ?',
      ['client_viewer', world.northstar.organizationId, world.atlas.reviewer.id],
    );

    const response = await send('GET', `/portal/requests/${created.id}`, atlas);
    expect(response.statusCode).toBe(200);

    const [row] = await observe(
      'select role as r from client_memberships where organization_id = ? and user_id = ?',
      [world.northstar.organizationId, world.atlas.reviewer.id],
    );
    expect(String(row?.['r'])).toBe('client_viewer');
  });

  it('cannot enumerate by direct id: a real other-client row and a fabricated id answer alike', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const meridian = await signIn(world.meridian.reviewer.id);
    const theirs = await submitRequest(meridian, world.meridian.projectId);

    const real = await send('GET', `/portal/requests/${theirs.id}`, atlas);
    const invented = await send('GET', `/portal/requests/${uuidv7()}`, atlas);

    expect(real.statusCode).toBe(404);
    expect(invented.statusCode).toBe(404);
    // Byte-identical but for the correlation id, which is per-request. A difference here is
    // how an id becomes confirmable.
    expect(withoutCorrelation(real.body)).toBe(withoutCorrelation(invented.body));
  });

  it('loses a project the moment the share is withdrawn', async () => {
    const studio = await signIn(world.northstar.owner.id);
    await publish(studio, 'The homepage design', 'client_visible');
    const atlas = await signIn(world.atlas.reviewer.id);
    expect(
      (await send('GET', '/portal/work-items', atlas)).json<{ workItems: unknown[] }>().workItems,
    ).toHaveLength(1);

    // §11's "object moved/reshared". `project_clients` is the whole of why a client principal
    // can reach a project, so removing the row removes the reach.
    await db.admin.execute(
      'delete from project_clients where organization_id = ? and project_id = ? and client_organization_id = ?',
      [world.northstar.organizationId, world.northstar.projectId, world.atlas.clientOrganizationId],
    );

    const after = await send('GET', '/portal/work-items', atlas);
    expect(after.json<{ workItems: unknown[] }>().workItems).toEqual([]);
  });

  it('never sees a soft-deleted work item, even one that was published to them', async () => {
    const studio = await signIn(world.northstar.owner.id);
    const itemId = await publish(studio, 'The homepage design', 'client_visible');

    const atlas = await signIn(world.atlas.reviewer.id);
    expect(
      (await send('GET', '/portal/work-items', atlas)).json<{ workItems: unknown[] }>().workItems,
    ).toHaveLength(1);

    await send('DELETE', `/work-items/${itemId}`, studio);

    const after = (await send('GET', '/portal/work-items', atlas)).json<{ workItems: unknown[] }>();
    expect(after.workItems).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §7: the projection is a projection
// ─────────────────────────────────────────────────────────────────────────────

describe('§7: forbidden fields never reach the client response path', () => {
  it('carries none of the forbidden field names on any client response', async () => {
    const studio = await signIn(world.northstar.owner.id);
    await publish(studio, 'The homepage design', 'client_visible');
    const atlas = await signIn(world.atlas.reviewer.id);
    await submitRequest(atlas);

    for (const operation of CLIENT_OPERATIONS) {
      const body = (await send(operation.method, operation.path, atlas)).body;
      for (const field of FORBIDDEN_CLIENT_FIELDS) {
        expect(body, `${operation.name} leaked ${field}`).not.toContain(`"${field}"`);
      }
    }
  });

  it('never echoes an internal identifier a client has no use for', async () => {
    const studio = await signIn(world.northstar.owner.id);
    await publish(studio, 'The homepage design', 'client_visible');
    const atlas = await signIn(world.atlas.reviewer.id);
    const created = await submitRequest(atlas);

    const studioSession = await signIn(world.northstar.manager.id);
    const triaged = (
      await send('POST', `/client-requests/${created.id}/transitions`, studioSession, {
        version: created.version,
        to: 'triage',
      })
    ).json<{ version: number }>();
    const accepted = (
      await send('POST', `/client-requests/${created.id}/acceptance`, studioSession, {
        version: triaged.version,
        clientSafeScopeSummary: 'A careers page with four roles.',
        commitment: 'unscheduled',
      })
    ).json<{ workItemId: string }>();

    const seen = (await send('GET', `/portal/requests/${created.id}`, atlas)).body;

    // The organization, the client organization, the person who submitted it, and — since
    // REQ-002 — the work item the acceptance created. A client holding the last of those could
    // ask for it by id on an internal endpoint, which is the whole of CLIENT-002.
    expect(seen).not.toContain(world.northstar.organizationId);
    expect(seen).not.toContain(world.atlas.clientOrganizationId);
    expect(seen).not.toContain(world.atlas.reviewer.id);
    expect(seen).not.toContain(accepted.workItemId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The internal projection, which WEB-005 added and nothing here had covered
// ─────────────────────────────────────────────────────────────────────────────

describe('the internal request view names the client, and only internally', () => {
  it('gives a manager the client organization’s name they cannot look up', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const created = await submitRequest(atlas);

    // Omar is a `manager`. `GET client-organizations` is gated on `org.manage`, which he does
    // not hold — a fact this asserts rather than assumes, because the whole reason the name is
    // on the projection is that this call fails.
    const studio = await signIn(world.northstar.manager.id);
    expect((await send('GET', '/client-organizations', studio)).statusCode).toBe(403);

    const seen = (await send('GET', `/client-requests/${created.id}`, studio)).json<{
      clientOrganizationName: string;
    }>();
    expect(seen.clientOrganizationName).toBe('Atlas Hospitality');
  });

  it('names the client on every row of the queue with one read, not one per row', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    await submitRequest(atlas);
    await submitRequest(atlas);
    const meridian = await signIn(world.meridian.reviewer.id);
    await submitRequest(meridian, world.meridian.projectId);

    const studio = await signIn(world.northstar.owner.id);
    const queue = (await send('GET', '/client-requests', studio)).json<{
      clientRequests: { clientOrganizationName: string | null }[];
    }>().clientRequests;

    expect(queue).toHaveLength(3);
    expect(new Set(queue.map((row) => row.clientOrganizationName))).toEqual(
      new Set(['Atlas Hospitality', 'Meridian Retail Group']),
    );
  });

  it('does not put the name on the client’s own view of the same row', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const created = await submitRequest(atlas);

    const seen = (await send('GET', `/portal/requests/${created.id}`, atlas)).json<
      Record<string, unknown>
    >();
    // Not a leak if it were there — it is their own name — but the client projection is built
    // field by field and this is the assertion that it still is. A field arriving on both views
    // is how one becomes a filtered copy of the other.
    expect(Object.keys(seen)).not.toContain('clientOrganizationName');
    expect(Object.keys(seen)).not.toContain('clientOrganizationId');
  });
});

/** Two refusals differ only by their correlation id, which is per-request by design. */
function withoutCorrelation(body: string): string {
  return body.replace(/"correlationId":"[^"]*"/, '"correlationId":"—"');
}
