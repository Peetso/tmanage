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
 * CLIENT-003 over real HTTP — an internal manager posts a project update, and it reaches the
 * client's portal timeline only once it is published.
 *
 * Four things this suite proves against a live server, on top of what the pure unit suite and the
 * migrator case cover:
 *
 * 1. **The internal write and the client read agree.** A project manager posts an update through
 *    the internal `POST /projects/:id/updates`, and the client reads the same row through
 *    `GET /portal/projects/:id/updates` — two services, one table, published-only.
 * 2. **`published` is the client-visibility gate.** An update posted with `published: false` is
 *    invisible to the client; a published one is visible.
 * 3. **One client cannot see another, and probing is a 404.** Atlas cannot read Meridian's
 *    project updates, and a sibling-client project id answers 404 rather than an empty list.
 * 4. **The route guard holds.** A client principal — who never holds `project.manage` — is
 *    refused the internal write with 403, and the client read leaks no staff identity.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_updates_suite_xx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_updates_suite_xxxxxx';

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

async function send(
  method: 'GET' | 'POST',
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

interface PortalUpdate {
  id: string;
  projectId: string;
  title: string;
  body: string;
  published: boolean;
  createdAt: string;
}

const owner = () => world.northstar.owner;

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

describe('an internal manager posts an update the client can read', () => {
  it('round-trips a published update to the client, newest first', async () => {
    const studio = await signIn(owner().id);
    const first = await send('POST', `/projects/${world.northstar.projectId}/updates`, studio, {
      title: 'Kickoff',
      body: 'We have started on the homepage.',
    });
    expect(first.statusCode).toBe(201);
    const second = await send('POST', `/projects/${world.northstar.projectId}/updates`, studio, {
      title: 'Homepage shipped',
      body: 'It is live.',
      published: true,
    });
    expect(second.statusCode).toBe(201);

    const client = await signIn(world.atlas.reviewer.id);
    const response = await send(
      'GET',
      `/portal/projects/${world.northstar.projectId}/updates`,
      client,
    );
    expect(response.statusCode).toBe(200);
    const updates = response.json<{ updates: PortalUpdate[] }>().updates;
    expect(updates.map((u) => u.title)).toEqual(['Homepage shipped', 'Kickoff']);
    expect(updates.every((u) => u.published)).toBe(true);
  });

  it('hides an unpublished update from the client but records it', async () => {
    const studio = await signIn(owner().id);
    await send('POST', `/projects/${world.northstar.projectId}/updates`, studio, {
      title: 'Client-visible note',
      body: 'You can see this.',
      published: true,
    });
    await send('POST', `/projects/${world.northstar.projectId}/updates`, studio, {
      title: 'Internal draft',
      body: 'Not ready for the client.',
      published: false,
    });

    const client = await signIn(world.atlas.reviewer.id);
    const titles = (
      await send('GET', `/portal/projects/${world.northstar.projectId}/updates`, client)
    )
      .json<{ updates: PortalUpdate[] }>()
      .updates.map((u) => u.title);
    expect(titles).toContain('Client-visible note');
    expect(titles).not.toContain('Internal draft');

    // Both rows exist in the tenant — the gate is the read predicate, not the absence of the row.
    const rows = await observe(
      `SELECT published FROM project_updates WHERE organization_id = ? AND project_id = ?`,
      [world.northstar.organizationId, world.northstar.projectId],
    );
    expect(rows).toHaveLength(2);
  });

  it('carries no staff identity or tenant id in the client view', async () => {
    const studio = await signIn(owner().id);
    await send('POST', `/projects/${world.northstar.projectId}/updates`, studio, {
      title: 'A visible update',
      body: 'body text',
      published: true,
    });

    const client = await signIn(world.atlas.reviewer.id);
    const response = await send(
      'GET',
      `/portal/projects/${world.northstar.projectId}/updates`,
      client,
    );
    const update = response.json<{ updates: PortalUpdate[] }>().updates[0]!;
    expect(Object.keys(update).sort()).toEqual(
      ['body', 'createdAt', 'id', 'projectId', 'published', 'title'].sort(),
    );
    // §4 excludes staff — the author id must never appear on the wire.
    expect(response.body).not.toContain(owner().id);
    expect(response.body).not.toContain(world.northstar.organizationId);
  });
});

describe('one client cannot see another, and the guard holds', () => {
  it('answers 404 for a sibling client’s project id rather than an empty list', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const response = await send(
      'GET',
      `/portal/projects/${world.meridian.projectId}/updates`,
      atlas,
    );
    // 404 rather than 200-with-nothing. An empty list is a claim about a boundary this caller
    // must not be able to see across.
    expect(response.statusCode).toBe(404);
  });

  it('refuses a client the internal write with 403 and writes nothing', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const response = await send('POST', `/projects/${world.northstar.projectId}/updates`, atlas, {
      title: 'A client should not be able to post this',
      body: 'nope',
      published: true,
    });
    // The CapabilityGuard refuses: no client role holds `project.manage`.
    expect(response.statusCode).toBe(403);

    const rows = await observe(`SELECT id FROM project_updates`);
    expect(rows).toHaveLength(0);
  });

  it('answers 404 and writes nothing for an unknown project id on the internal write', async () => {
    const studio = await signIn(owner().id);
    const response = await send(
      'POST',
      `/projects/00000000-0000-4000-8000-0000000000ff/updates`,
      studio,
      { title: 'X', body: 'y', published: true },
    );
    // Known-trap: an unknown id is a 404, never the 500 a bare foreign key would surface.
    expect(response.statusCode).toBe(404);
    const rows = await observe(`SELECT id FROM project_updates`);
    expect(rows).toHaveLength(0);
  });
});
