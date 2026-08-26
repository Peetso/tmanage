import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { uuidv7 } from '@tmanage/domain';
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
 * PROJ-001 over real HTTP — creating a project, and the workspace list that makes it possible.
 *
 * `PROJ-001` built the repositories and proved the tenant scoping. What this suite is about is
 * the three things the endpoint adds:
 *
 * 1. **A target date is a forecast, not a commitment.** `22-SCREEN-BY-SCREEN` §3 says the date
 *    on `ON-03` "is marked target until milestone plan confirmed", and this asserts the column
 *    it lands in — `forecast_at`, with `committed_at` left null.
 * 2. **Creating a project is audited**, in the same transaction as the insert.
 * 3. **The workspace list exists at all.** Without it a client cannot learn a `workspaceId`,
 *    and `fk_projects_workspace_tenant` means it cannot guess one.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_projects_suite_x';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_projects_suite_xxxxx';

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

async function signIn(userId: string): Promise<{ cookie: string; csrfToken: string }> {
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

const owner = () => world.northstar.owner;
const designer = () => world.northstar.designer;
/**
 * The seeded slug, spelled out rather than read off the world.
 *
 * `SeededTenant` carries ids and names but no slug — the seed passes one to `organization()`
 * and does not keep it. Restating it here is the smaller of two evils: widening the seed's
 * public shape for one suite would change what every other suite sees.
 */
const slug = () => 'northstar-studio';

async function createProject(
  session: { cookie: string; csrfToken: string },
  payload: Record<string, unknown>,
): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'POST',
    url: `/v1/organizations/${slug()}/projects`,
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
    },
    payload,
  })) as unknown as InjectedResponse;
}

async function listWorkspaces(session: { cookie: string }): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'GET',
    url: `/v1/organizations/${slug()}/workspaces`,
    headers: { cookie: session.cookie },
  })) as unknown as InjectedResponse;
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

describe('the workspace list', () => {
  it('returns this organization’s workspaces and nothing else', async () => {
    const session = await signIn(owner().id);
    const response = await listWorkspaces(session);

    expect(response.statusCode).toBe(200);
    const { workspaces } = response.json<{ workspaces: { id: string; name: string }[] }>();
    expect(workspaces.length).toBeGreaterThan(0);

    const mine = await observe('select id from workspaces where organization_id = ?', [
      world.northstar.organizationId,
    ]);
    expect(workspaces.map((w) => w.id).sort()).toEqual(mine.map((row) => String(row['id'])).sort());
  });

  it('echoes no tenant identifier', async () => {
    const session = await signIn(owner().id);
    const response = await listWorkspaces(session);
    expect(response.body).not.toContain(world.northstar.organizationId);
  });

  it('refuses an unauthenticated caller', async () => {
    const response = (await app.inject({
      method: 'GET',
      url: `/v1/organizations/${slug()}/workspaces`,
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(401);
  });

  it('refuses a limit that is not a positive integer', async () => {
    const session = await signIn(owner().id);
    const response = (await app.inject({
      method: 'GET',
      url: `/v1/organizations/${slug()}/workspaces?limit=nonsense`,
      headers: { cookie: session.cookie },
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(400);
  });
});

describe('creating a project', () => {
  async function workspaceId(session: { cookie: string }): Promise<string> {
    const response = await listWorkspaces(session);
    return response.json<{ workspaces: { id: string }[] }>().workspaces[0]!.id;
  }

  it('creates it, and defaults the owner to the person who created it', async () => {
    const session = await signIn(owner().id);
    const response = await createProject(session, {
      workspaceId: await workspaceId(session),
      name: 'Atlas Website Relaunch',
    });

    expect(response.statusCode).toBe(201);
    const project = response.json<{ id: string; ownerUserId: string; name: string }>();
    expect(project.name).toBe('Atlas Website Relaunch');
    expect(project.ownerUserId).toBe(owner().id);
  });

  it('honours an owner that was named', async () => {
    const session = await signIn(owner().id);
    const response = await createProject(session, {
      workspaceId: await workspaceId(session),
      name: 'Named owner',
      ownerUserId: designer().id,
    });

    expect(response.json<{ ownerUserId: string }>().ownerUserId).toBe(designer().id);
  });

  /**
   * Claim 1, and the reason this ticket touched the schema at all. A date typed on a setup
   * screen, before anyone has planned the work, is a forecast — writing it to `committed_at`
   * would make a promise on the team's behalf that nobody made.
   */
  it('stores a target date as a forecast, never as a commitment', async () => {
    const session = await signIn(owner().id);
    const response = await createProject(session, {
      workspaceId: await workspaceId(session),
      name: 'With a target',
      targetDate: '2026-09-30',
    });

    expect(response.statusCode).toBe(201);
    const project = response.json<{ id: string; forecastAt: string; committedAt: string | null }>();
    expect(project.forecastAt.slice(0, 10)).toBe('2026-09-30');
    expect(project.committedAt).toBeNull();

    const rows = await observe('select committed_at, forecast_at from projects where id = ?', [
      project.id,
    ]);
    expect(rows[0]!['committed_at']).toBeNull();
    expect(rows[0]!['forecast_at']).not.toBeNull();
  });

  it('accepts a project with no date at all', async () => {
    const session = await signIn(owner().id);
    const response = await createProject(session, {
      workspaceId: await workspaceId(session),
      name: 'No date',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ forecastAt: string | null }>().forecastAt).toBeNull();
  });

  it.each([
    ['a date with a time', '2026-09-30T12:00:00Z'],
    ['a European ordering', '30-09-2026'],
    ['a month that does not exist', '2026-13-01'],
    ['a day that does not exist', '2026-02-31'],
    ['a number', 20260930],
  ])('refuses %s, naming the field', async (_name, targetDate) => {
    const session = await signIn(owner().id);
    const response = await createProject(session, {
      workspaceId: await workspaceId(session),
      name: 'Bad date',
      targetDate,
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { details: { field: string }[] } }>();
    expect(body.error.details.map((detail) => detail.field)).toContain('targetDate');
  });

  /** Claim 2. The audit row and the insert commit together or not at all. */
  it('records the creation, in the same transaction', async () => {
    const session = await signIn(owner().id);
    const response = await createProject(session, {
      workspaceId: await workspaceId(session),
      name: 'Audited',
      targetDate: '2026-09-30',
    });
    const project = response.json<{ id: string }>();

    const events = await observe(
      `select * from audit_events
        where organization_id = ? and action = 'project.created'`,
      [world.northstar.organizationId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!['object_type']).toBe('project');
    expect(events[0]!['object_id']).toBe(project.id);
    expect(events[0]!['actor_user_id']).toBe(owner().id);

    const raw = events[0]!['metadata_json'];
    const metadata = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    expect(metadata['owner_user_id']).toBe(owner().id);
    expect(metadata['has_forecast_date']).toBe(true);
    // The date itself is a fact about the work, not an identifier. §12's metadata rule.
    expect(JSON.stringify(metadata)).not.toContain('2026-09-30');
  });

  it('writes no project and no audit row when the body is invalid', async () => {
    const session = await signIn(owner().id);
    const before = await observe('select count(*) as n from projects');

    const response = await createProject(session, { name: 'No workspace' });
    expect(response.statusCode).toBe(400);

    const after = await observe('select count(*) as n from projects');
    expect(Number(after[0]!['n'])).toBe(Number(before[0]!['n']));
    expect(
      await observe(`select count(*) as n from audit_events where action = 'project.created'`),
    ).toEqual([expect.objectContaining({ n: 0 })]);
  });

  /**
   * The composite foreign key doing the work rather than a service check. A workspace id from
   * another organization is refused by the database, not by a comparison someone could
   * forget to write.
   */
  it('refuses a workspace belonging to another organization', async () => {
    const session = await signIn(owner().id);
    const [foreign] = await observe('select id from workspaces where organization_id = ? limit 1', [
      world.twin.organizationId,
    ]);

    const response = await createProject(session, {
      workspaceId: String(foreign!['id']),
      name: 'Cross-tenant attempt',
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(
      await observe('select count(*) as n from projects where name = ?', ['Cross-tenant attempt']),
    ).toEqual([expect.objectContaining({ n: 0 })]);
  });

  it('refuses a caller without the capability', async () => {
    // The Atlas reviewer is a client principal; `project.create` is internal-only.
    const session = await signIn(world.atlas.reviewer.id);
    const response = await createProject(session, {
      workspaceId: uuidv7(),
      name: 'Client attempt',
    });
    expect([401, 403, 404]).toContain(response.statusCode);
  });

  it('refuses a mutation with no CSRF token', async () => {
    const session = await signIn(owner().id);
    const id = await workspaceId(session);
    const response = (await app.inject({
      method: 'POST',
      url: `/v1/organizations/${slug()}/projects`,
      headers: { 'content-type': 'application/json', cookie: session.cookie },
      payload: { workspaceId: id, name: 'No token' },
    })) as unknown as InjectedResponse;

    expect(response.statusCode).toBe(403);
  });

  it('appears in the project list afterwards', async () => {
    const session = await signIn(owner().id);
    const created = await createProject(session, {
      workspaceId: await workspaceId(session),
      name: 'Listed afterwards',
      targetDate: '2026-09-30',
    });
    const project = created.json<{ id: string }>();

    const listed = (await app.inject({
      method: 'GET',
      url: `/v1/organizations/${slug()}/projects`,
      headers: { cookie: session.cookie },
    })) as unknown as InjectedResponse;

    const body = listed.json<{ projects: { id: string; forecastAt: string | null }[] }>();
    const found = body.projects.find((row) => row.id === project.id);
    expect(found).toBeDefined();
    expect(found?.forecastAt).not.toBeNull();
  });
});
