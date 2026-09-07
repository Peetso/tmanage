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
 * CLIENT-002 over real HTTP — the client portal, and the assertion that has been parked since
 * the HTTP surface landed.
 *
 * `http-pipeline.db.test.ts` says it in a comment: a client seeing their **own** client
 * organization's work and not a sibling client's "belongs on a Client Portal endpoint, which
 * serves the client projection rather than the internal record. No such endpoint exists yet."
 * This suite is that endpoint, and the case is the fourth one below.
 *
 * Four things only this suite can prove:
 *
 * 1. **A client can finally read something.** Every previous ticket left them able to sign in
 *    and see nothing, because every endpoint served the internal record and
 *    `12-PERMISSION-MATRIX` §2 gives every client role "View internal project: Never".
 * 2. **The projection is a projection.** No owner, no internal state, no field a filter would
 *    have had to remember to strip.
 * 3. **Atlas cannot see Meridian.** Two clients of the same studio, which is the boundary
 *    `04-SECURITY-PRIVACY` §5 is most emphatic about.
 * 4. **A client admin invites into their own client organization and nowhere else** —
 *    `12-PERMISSION-MATRIX` §2's "within own client org/policy", the sentence that decides
 *    whether one client can put people inside another.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_portal_suite_xxx';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_portal_suite_xxxxxxx';

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

interface PortalWorkItem {
  id: string;
  projectId: string;
  title: string;
  progress: string;
  dueAt: string | null;
  updatedAt: string;
}

interface PortalProject {
  id: string;
  name: string;
  status: string;
  committedAt: string | null;
  forecastAt: string | null;
}

const owner = () => world.northstar.owner;

/** Publish a work item to the client, through the internal API, as the studio would. */
async function publish(
  session: Session,
  title: string,
  audience: 'client_visible' | 'client_action_required',
  projectId = world.northstar.projectId,
): Promise<string> {
  const created = await send('POST', '/work-items', session, { projectId, title });
  if (created.statusCode !== 201) {
    throw new Error(`create failed: ${created.statusCode} ${created.body}`);
  }
  const item = created.json<{ id: string; version: number }>();

  const updated = await send('PATCH', `/work-items/${item.id}`, session, {
    version: item.version,
    audience,
  });
  if (updated.statusCode !== 200) {
    throw new Error(`publish failed: ${updated.statusCode} ${updated.body}`);
  }
  return item.id;
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

describe('a client can finally read something', () => {
  it('lists the projects shared with their client organization', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const response = await send('GET', '/portal/projects', client);

    expect(response.statusCode).toBe(200);
    const projects = response.json<{ projects: PortalProject[] }>().projects;
    expect(projects.map((project) => project.id)).toEqual([world.northstar.projectId]);
  });

  it('shows work published to them, and nothing else', async () => {
    const studio = await signIn(owner().id);
    await publish(studio, 'The homepage design', 'client_visible');
    await send('POST', '/work-items', studio, {
      projectId: world.northstar.projectId,
      title: 'Internal retro notes',
    });

    const client = await signIn(world.atlas.reviewer.id);
    const response = await send('GET', '/portal/work-items', client);

    expect(response.statusCode).toBe(200);
    const titles = response.json<{ workItems: PortalWorkItem[] }>().workItems.map((i) => i.title);
    expect(titles).toContain('The homepage design');
    expect(titles).not.toContain('Internal retro notes');
  });

  it('marks what is waiting on the client, which is the whole of CL-02', async () => {
    const studio = await signIn(owner().id);
    await publish(studio, 'Approve the copy', 'client_action_required');
    await publish(studio, 'The homepage design', 'client_visible');

    const client = await signIn(world.atlas.reviewer.id);
    const items = (await send('GET', '/portal/work-items', client)).json<{
      workItems: PortalWorkItem[];
    }>().workItems;

    const byTitle = new Map(items.map((item) => [item.title, item.progress]));
    expect(byTitle.get('Approve the copy')).toBe('waiting_on_you');
    expect(byTitle.get('The homepage design')).toBe('in_progress');
  });
});

describe('the projection is a projection, not a filtered record', () => {
  it('carries no owner and no internal state', async () => {
    const studio = await signIn(owner().id);
    await publish(studio, 'The homepage design', 'client_visible');

    const client = await signIn(world.atlas.reviewer.id);
    const response = await send('GET', '/portal/work-items', client);
    const item = response.json<{ workItems: PortalWorkItem[] }>().workItems[0]!;

    // §4 excludes staff, and the work lifecycle is not "milestone state". A client reading
    // `internal_review` learns their deliverable is being argued about inside the agency.
    expect(Object.keys(item).sort()).toEqual([
      'dueAt',
      'id',
      'progress',
      'projectId',
      'title',
      'updatedAt',
    ]);
  });

  it('never echoes a tenant identifier', async () => {
    const studio = await signIn(owner().id);
    await publish(studio, 'The homepage design', 'client_visible');

    const client = await signIn(world.atlas.reviewer.id);
    const response = await send('GET', '/portal/work-items', client);
    expect(response.body).not.toContain(world.northstar.organizationId);
    expect(response.body).not.toContain(world.atlas.clientOrganizationId);
  });

  it('hides an item again when it is narrowed back to internal', async () => {
    const studio = await signIn(owner().id);
    const itemId = await publish(studio, 'Briefly shared', 'client_visible');

    const client = await signIn(world.atlas.reviewer.id);
    const before = (await send('GET', '/portal/work-items', client)).json<{
      workItems: PortalWorkItem[];
    }>().workItems;
    expect(before.map((item) => item.title)).toContain('Briefly shared');

    const current = (await send('GET', `/work-items/${itemId}`, studio)).json<{
      version: number;
    }>();
    await send('PATCH', `/work-items/${itemId}`, studio, {
      version: current.version,
      audience: 'internal',
    });

    const after = (await send('GET', '/portal/work-items', client)).json<{
      workItems: PortalWorkItem[];
    }>().workItems;
    expect(after.map((item) => item.title)).not.toContain('Briefly shared');
  });
});

describe('one client cannot see another', () => {
  /**
   * The case parked in `http-pipeline.db.test.ts` when the HTTP surface landed.
   *
   * Atlas and Meridian are two clients of the same studio. Meridian's project is shared with
   * Meridian and not with Atlas, and the only thing that makes that true is a `project_clients`
   * row — which is what `PrincipalRepository.projectScope` reads and `authorize()` rule 10
   * enforces.
   */
  it('does not show a sibling client’s project, even inside the same studio', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const response = await send('GET', '/portal/projects', atlas);

    const ids = response.json<{ projects: PortalProject[] }>().projects.map((p) => p.id);
    expect(ids).toContain(world.northstar.projectId);
    expect(ids).not.toContain(world.meridian.projectId);
    expect(response.body).not.toContain(world.meridian.projectId);
  });

  it('answers 404 for a sibling client’s project id, rather than an empty list', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const response = await send(
      'GET',
      `/portal/work-items?projectId=${world.meridian.projectId}`,
      atlas,
    );

    // 404 rather than 200 with nothing in it. An empty list is a claim about a boundary this
    // caller must not be able to see across.
    expect(response.statusCode).toBe(404);
  });

  it('shows each client their own work and only their own', async () => {
    const studio = await signIn(owner().id);
    await publish(studio, 'Atlas homepage', 'client_visible', world.northstar.projectId);
    await publish(studio, 'Meridian storefront', 'client_visible', world.meridian.projectId);

    const atlas = await signIn(world.atlas.reviewer.id);
    const meridian = await signIn(world.meridian.reviewer.id);

    const atlasTitles = (await send('GET', '/portal/work-items', atlas))
      .json<{
        workItems: PortalWorkItem[];
      }>()
      .workItems.map((item) => item.title);
    const meridianTitles = (await send('GET', '/portal/work-items', meridian))
      .json<{
        workItems: PortalWorkItem[];
      }>()
      .workItems.map((item) => item.title);

    expect(atlasTitles).toContain('Atlas homepage');
    expect(atlasTitles).not.toContain('Meridian storefront');
    expect(meridianTitles).toContain('Meridian storefront');
    expect(meridianTitles).not.toContain('Atlas homepage');
  });
});

describe('the internal endpoints stay closed to a client', () => {
  it('refuses the internal work list, rather than filtering it', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const response = await send('GET', '/work-items', client);

    // `work.read` is internal-only and in no client ceiling. The portal is a different
    // surface, not the same one with a filter in front.
    expect(response.statusCode).toBe(403);
  });

  it('refuses the internal project list', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    expect((await send('GET', '/projects', client)).statusCode).toBe(403);
  });

  it('lets an internal reader see what the client sees', async () => {
    const studio = await signIn(owner().id);
    await publish(studio, 'The homepage design', 'client_visible');

    // How anybody at the agency checks a publication without asking the client.
    const response = await send('GET', '/portal/work-items', studio);
    expect(response.statusCode).toBe(200);
    const titles = response.json<{ workItems: PortalWorkItem[] }>().workItems.map((i) => i.title);
    expect(titles).toContain('The homepage design');
  });
});

describe('a client admin invites into their own client organization', () => {
  it('creates a client invitation without naming a client organization', async () => {
    const admin = await signIn(world.atlas.admin.id);
    const response = await send('POST', '/portal/client-members', admin, {
      email: 'nour.hassan@atlas.example',
      role: 'client_viewer',
    });

    expect(response.statusCode).toBe(201);
    const issued = response.json<{ invitation: { clientOrganizationId: string | null } }>();

    // Taken from the principal. The body has no such field.
    expect(issued.invitation.clientOrganizationId).toBe(world.atlas.clientOrganizationId);
  });

  it('refuses a client role that is not one', async () => {
    const admin = await signIn(world.atlas.admin.id);
    const response = await send('POST', '/portal/client-members', admin, {
      email: 'nour.hassan@atlas.example',
      role: 'org_admin',
    });

    // An internal role on a client invitation would create a client membership whose role no
    // client ceiling contains.
    expect(response.statusCode).toBe(400);
  });

  it('refuses a client reviewer, who does not hold client_member.manage', async () => {
    const reviewer = await signIn(world.atlas.reviewer.id);
    const response = await send('POST', '/portal/client-members', reviewer, {
      email: 'nour.hassan@atlas.example',
      role: 'client_viewer',
    });

    expect(response.statusCode).toBe(403);
  });

  it('cannot reach the internal invitation route at all', async () => {
    const admin = await signIn(world.atlas.admin.id);
    const response = await send('POST', '/invitations', admin, {
      email: 'nour.hassan@atlas.example',
      role: 'client_viewer',
      clientOrganizationId: world.meridian.clientOrganizationId,
    });

    // `org.manage` is in no client ceiling, so the guard refuses before any handler runs —
    // which is why the portal route exists rather than a second branch on this one.
    expect(response.statusCode).toBe(403);

    const rows = await observe('select id from invitations');
    expect(rows).toHaveLength(0);
  });

  it('records the invitation against the client organization', async () => {
    const admin = await signIn(world.atlas.admin.id);
    await send('POST', '/portal/client-members', admin, {
      email: 'nour.hassan@atlas.example',
      role: 'client_viewer',
    });

    const events = await observe(
      `select metadata_json from audit_events where action = 'invitation.issued'`,
    );
    expect(events).toHaveLength(1);
    const raw = events[0]!['metadata_json'];
    const metadata = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    expect(metadata['destination']).toBe('client_organization');
    expect(metadata['client_organization_id']).toBe(world.atlas.clientOrganizationId);
  });
});

describe('the guards still apply', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = (await app.inject({
      method: 'GET',
      url: `/v1/organizations/${NORTHSTAR}/portal/projects`,
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(401);
  });

  it('answers the same for another tenant’s slug as for one that does not exist', async () => {
    const client = await signIn(world.atlas.reviewer.id);

    const foreign = (await app.inject({
      method: 'GET',
      url: '/v1/organizations/brightops/portal/projects',
      headers: { cookie: client.cookie },
    })) as unknown as InjectedResponse;
    const missing = (await app.inject({
      method: 'GET',
      url: '/v1/organizations/no-such-studio/portal/projects',
      headers: { cookie: client.cookie },
    })) as unknown as InjectedResponse;

    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    const strip = (body: string) => body.replace(/"correlationId":"[^"]+"/, '');
    expect(strip(foreign.body)).toBe(strip(missing.body));
  });
});
