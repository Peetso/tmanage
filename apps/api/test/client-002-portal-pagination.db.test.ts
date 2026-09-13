import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { uuidv7 } from '@tmanage/domain';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * R07 over real HTTP — the portal must not stop before a client's accessible records.
 *
 * The scoped repositories return one keyset page (default 50 rows) and the portal service
 * applies `mayRead` per row, because the relation rule is `authorize()`'s, not a column. The
 * defect this suite pins is *filtering after limiting*: when the service filtered a single page,
 * a client whose only accessible row sat past the first 50 tenant rows received an empty list.
 *
 * Both cases below are constructed to fail against that old order of operations — the first page
 * is deliberately filled with rows the client cannot read, and the one row they can read is
 * created last so its `uuidv7` id sorts after them — and to pass once the service walks pages
 * until it has a full page of readable rows.
 *
 * UNEXECUTED IN THIS SLICE: the database suite lock is held elsewhere for the whole session.
 * Run it with:
 *   pnpm --filter @tmanage/api test -- --project database client-002-portal-pagination
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_portal_pagination_xx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_portal_pagination_xxxxxx';

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

async function get(path: string, session: Session): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'GET',
    url: `/v1/organizations/${NORTHSTAR}${path}`,
    headers: { cookie: session.cookie },
  })) as unknown as InjectedResponse;
}

interface PortalProject {
  id: string;
  name: string;
  status: string;
  committedAt: string | null;
  forecastAt: string | null;
}

interface PortalWorkItem {
  id: string;
  projectId: string;
  title: string;
  progress: string;
  dueAt: string | null;
  updatedAt: string;
}

/** Insert a bare northstar project (not shared with any client). Returns its id. */
async function insertProject(name: string): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    'insert into projects (id, organization_id, workspace_id, name) values (?, ?, ?, ?)',
    [id, world.northstar.organizationId, world.northstar.workspaceId, name],
  );
  return id;
}

async function shareWithAtlas(projectId: string): Promise<void> {
  await db.admin.execute(
    `insert into project_clients (id, organization_id, project_id, client_organization_id)
     values (?, ?, ?, ?)`,
    [uuidv7(), world.northstar.organizationId, projectId, world.atlas.clientOrganizationId],
  );
}

/** Insert a client-visible work item. Returns its id. */
async function insertClientVisibleItem(projectId: string, title: string): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into work_items
       (id, organization_id, project_id, title, state, audience, created_at, updated_at)
     values (?, ?, ?, ?, 'in_progress', 'client_visible', now(3), now(3))`,
    [id, world.northstar.organizationId, projectId, title],
  );
  return id;
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

describe('portal project list past the first repository page (R07)', () => {
  it("returns the client's only accessible project when it is the tenant's 61st row", async () => {
    // Stop the seeded project from occupying an early, readable slot: the client's accessible
    // project must be the one that sits past the first page.
    await db.admin.execute(
      `delete from project_clients
        where organization_id = ? and project_id = ? and client_organization_id = ?`,
      [world.northstar.organizationId, world.northstar.projectId, world.atlas.clientOrganizationId],
    );

    // 60 tenant projects the client cannot read, created first so their ids sort before…
    for (let i = 0; i < 60; i += 1) {
      await insertProject(`Filler project ${i}`);
    }
    // …the one shared project, created last so its uuidv7 sorts after every filler — well past
    // the repository's 50-row first page.
    const accessible = await insertProject('The one shared project');
    await shareWithAtlas(accessible);

    const client = await signIn(world.atlas.reviewer.id);
    const response = await get('/portal/projects', client);

    expect(response.statusCode).toBe(200);
    const projects = response.json<{ projects: PortalProject[] }>().projects;
    // Old order of operations (filter one 50-row page) returns []; the walk returns the row.
    expect(projects.map((p) => p.id)).toEqual([accessible]);
  });
});

describe('portal work-item list past the first repository page (R07)', () => {
  it('returns client work in a readable project hidden behind a full page of unreadable rows', async () => {
    const unreadable = await insertProject('A project not shared with the client');

    // 60 client-visible items the client cannot read — they belong to an unshared project, yet
    // the audience predicate selects them, so they fill the repository's first page.
    for (let i = 0; i < 60; i += 1) {
      await insertClientVisibleItem(unreadable, `Unreadable client-visible item ${i}`);
    }
    // One client-visible item in the project the client *can* read, created last so its id
    // sorts after the 60 above.
    const visible = await insertClientVisibleItem(
      world.northstar.projectId,
      'The item the client should see',
    );

    const client = await signIn(world.atlas.reviewer.id);
    const response = await get('/portal/work-items', client);

    expect(response.statusCode).toBe(200);
    const items = response.json<{ workItems: PortalWorkItem[] }>().workItems;
    // Old order of operations (filter one 50-row page) returns []; the walk returns the row.
    expect(items.map((i) => i.id)).toEqual([visible]);
  });
});
