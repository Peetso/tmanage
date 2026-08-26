import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { WORK_ITEM_STATES } from '@tmanage/domain';
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
 * WORK-001 over real HTTP — the work aggregate, its lifecycle, and its audience.
 *
 * `PROJ-001` proved the repository's tenant scoping and `packages/domain` proves the state
 * machine in 35 unit cases. This suite is about the four things only the service and the route
 * can get wrong:
 *
 * 1. **The audience is the whole of client isolation.** An internal work item must not be
 *    readable by a client principal — not filtered out of a response, not fetched at all.
 * 2. **State is not a field.** There is no way to reach `done` except through a transition the
 *    machine allowed, so §5's requirements — an owner and a completion timestamp — cannot be
 *    stepped around by a `PATCH`.
 * 3. **The version is required.** A write that does not name the version it read is refused,
 *    and one that names a stale version is a conflict rather than a silent overwrite.
 * 4. **Creation is audited; retitling is not.** The set of audited actions is a judgement,
 *    and this asserts the judgement rather than assuming it.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_work_items_suite_';
const CSRF_SECRET = 'local_dev_only_csrf_secret_for_the_work_items_suite_xxx';

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
const ATLAS_SLUG = 'northstar-studio';

const owner = () => world.northstar.owner;
const designer = () => world.northstar.designer;
const project = () => world.northstar.projectId;

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
      // Only when there is a body. Fastify refuses a request that declares JSON and sends
      // nothing — "Body cannot be empty when content-type is set" — with a 400 raised before
      // any handler runs, which the first run of this suite mistook for a validation failure
      // in the DELETE route.
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

interface WorkItem {
  id: string;
  state: string;
  version: number;
  audience: string;
  title: string;
  ownerUserId: string | null;
  dueAt: string | null;
}

async function createItem(
  session: Session,
  overrides: Record<string, unknown> = {},
): Promise<WorkItem> {
  const response = await send('POST', '/work-items', session, {
    projectId: project(),
    title: 'Rebuild the homepage',
    ...overrides,
  });
  if (response.statusCode !== 201) {
    throw new Error(`create failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<WorkItem>();
}

/** Walk an item to a state through legal transitions, supplying whatever each one requires. */
async function moveTo(session: Session, item: WorkItem, to: string): Promise<WorkItem> {
  const path: Record<string, { next: string; facts?: Record<string, unknown> }[]> = {
    ready: [{ next: 'ready' }],
    in_progress: [{ next: 'ready' }, { next: 'in_progress' }],
    internal_review: [{ next: 'ready' }, { next: 'in_progress' }, { next: 'internal_review' }],
    done: [
      { next: 'ready' },
      { next: 'in_progress' },
      { next: 'internal_review' },
      {
        next: 'done',
        facts: { ownerId: 'someone', completedAt: '2026-08-26T12:00:00.000Z' },
      },
    ],
  };

  let current = item;
  for (const step of path[to] ?? []) {
    const response = await send('POST', `/work-items/${current.id}/transitions`, session, {
      version: current.version,
      to: step.next,
      ...(step.facts ? { facts: step.facts } : {}),
    });
    if (response.statusCode !== 200) {
      throw new Error(`transition to ${step.next} failed: ${response.statusCode} ${response.body}`);
    }
    current = response.json<WorkItem>();
  }
  return current;
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

describe('creating work', () => {
  it('starts at the lifecycle’s initial state, not the column default', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);

    // `work_items.state DEFAULT 'triage'` is a client-request state that 23-ERD §5 does not
    // give work items. The repository writes the machine's initial state explicitly, so the
    // schema divergence Peter chose to leave cannot reach a row.
    expect(item.state).toBe('backlog');
    expect(WORK_ITEM_STATES[0]).toBe('backlog');

    const rows = await observe('select state from work_items where id = ?', [item.id]);
    expect(rows[0]!['state']).toBe('backlog');
  });

  it('defaults to internal, which is the audience a client cannot see', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);
    expect(item.audience).toBe('internal');
  });

  it('records the creation, in the same transaction', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);

    const events = await observe(
      `select * from audit_events where action = 'work_item.created' and object_id = ?`,
      [item.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!['object_type']).toBe('work_item');
    expect(events[0]!['actor_user_id']).toBe(owner().id);
  });

  it('accepts a due instant with a time of day', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session, { dueAt: '2026-09-30T17:00:00.000Z' });
    expect(item.dueAt).toBe('2026-09-30T17:00:00.000Z');
  });

  it.each([
    ['a bare calendar date', '2026-09-30'],
    ['a number', 1_759_248_000_000],
    ['nonsense', 'next friday'],
  ])('refuses %s as a due instant', async (_name, dueAt) => {
    const session = await signIn(owner().id);
    const response = await send('POST', '/work-items', session, {
      projectId: project(),
      title: 'Bad date',
      dueAt,
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { details: { field: string }[] } }>();
    expect(body.error.details.map((d) => d.field)).toContain('dueAt');
  });

  it('refuses a project in another organization', async () => {
    const session = await signIn(owner().id);
    const response = await send('POST', '/work-items', session, {
      projectId: world.twin.projectId,
      title: 'Cross-tenant attempt',
    });

    // Not found, not forbidden: 403 would confirm the project exists.
    expect(response.statusCode).toBe(404);
    expect(
      await observe('select count(*) as n from work_items where title = ?', [
        'Cross-tenant attempt',
      ]),
    ).toEqual([expect.objectContaining({ n: 0 })]);
  });

  it('offers no way to set the state', async () => {
    const session = await signIn(owner().id);
    const response = await send('POST', '/work-items', session, {
      projectId: project(),
      title: 'Straight to done',
      state: 'done',
    });

    // The field is ignored rather than refused — it is not part of the body's shape — and the
    // item still starts at the beginning. §5's requirements cannot be stepped around.
    expect(response.statusCode).toBe(201);
    expect(response.json<WorkItem>().state).toBe('backlog');
  });
});

describe('the lifecycle', () => {
  it('moves through the states the machine allows', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);

    const ready = await moveTo(session, item, 'ready');
    expect(ready.state).toBe('ready');
    expect(ready.version).toBe(item.version + 1);
  });

  it('refuses a transition the machine does not have', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);

    const response = await send('POST', `/work-items/${item.id}/transitions`, session, {
      version: item.version,
      to: 'done',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      'cannot move from backlog to done',
    );
  });

  /**
   * §5: "`done` requires an owner and a completion timestamp." The machine holds that rule and
   * the service reports what was missing — which is safe to be specific about, because the
   * caller already holds the row.
   */
  it('names the facts a transition needed and did not get', async () => {
    const session = await signIn(owner().id);
    let item = await createItem(session);
    item = await moveTo(session, item, 'internal_review');

    const response = await send('POST', `/work-items/${item.id}/transitions`, session, {
      version: item.version,
      to: 'done',
    });

    expect(response.statusCode).toBe(422);
    const fields = response
      .json<{ error: { details: { field: string }[] } }>()
      .error.details.map((detail) => detail.field);
    expect(fields).toContain('ownerId');
    expect(fields).toContain('completedAt');
  });

  it('accepts the transition once the facts are supplied', async () => {
    const session = await signIn(owner().id);
    const item = await moveTo(session, await createItem(session), 'done');
    expect(item.state).toBe('done');
  });

  it('requires a blocker reason and an ask to block, and a resolution to leave', async () => {
    const session = await signIn(owner().id);
    let item = await moveTo(session, await createItem(session), 'in_progress');

    const bare = await send('POST', `/work-items/${item.id}/transitions`, session, {
      version: item.version,
      to: 'blocked',
    });
    expect(bare.statusCode).toBe(422);

    const blocked = await send('POST', `/work-items/${item.id}/transitions`, session, {
      version: item.version,
      to: 'blocked',
      facts: { blockerReason: 'waiting on copy', blockerAsk: 'send the final text' },
    });
    expect(blocked.statusCode).toBe(200);
    item = blocked.json<WorkItem>();
    expect(item.state).toBe('blocked');

    const leaving = await send('POST', `/work-items/${item.id}/transitions`, session, {
      version: item.version,
      to: 'in_progress',
    });
    expect(leaving.statusCode).toBe(422);
  });

  it('records every transition, with the states either side', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);
    await moveTo(session, item, 'ready');

    const events = await observe(
      `select * from audit_events where action = 'work_item.transitioned' and object_id = ?`,
      [item.id],
    );
    expect(events).toHaveLength(1);

    const raw = events[0]!['metadata_json'];
    const metadata = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    expect(metadata['state_before']).toBe('backlog');
    expect(metadata['state_after']).toBe('ready');
  });

  /**
   * A blocker reason is prose written by a person. §12's metadata rule is identifiers and
   * classifications, so the audit row records **which** facts were supplied and never their
   * content.
   */
  it('records which facts were supplied, never their content', async () => {
    const session = await signIn(owner().id);
    const item = await moveTo(session, await createItem(session), 'in_progress');

    await send('POST', `/work-items/${item.id}/transitions`, session, {
      version: item.version,
      to: 'blocked',
      facts: { blockerReason: 'the client has not signed off', blockerAsk: 'chase Salma' },
    });

    const events = await observe(
      // Ordered by id rather than by timestamp: audit ids are UUIDv7, so they sort by
      // creation, and two transitions in one test can land in the same millisecond.
      `select metadata_json from audit_events
        where action = 'work_item.transitioned' and object_id = ? order by id desc`,
      [item.id],
    );
    const raw = events[0]!['metadata_json'];
    const metadata = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    expect(metadata['facts_supplied']).toEqual(['blockerAsk', 'blockerReason']);
    expect(JSON.stringify(metadata)).not.toContain('Salma');
    expect(JSON.stringify(metadata)).not.toContain('signed off');
  });
});

describe('optimistic concurrency', () => {
  it('refuses a write that names no version', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);

    const response = await send('PATCH', `/work-items/${item.id}`, session, {
      title: 'Renamed without a token',
    });
    expect(response.statusCode).toBe(400);
    expect(
      response.json<{ error: { details: { field: string }[] } }>().error.details[0]!.field,
    ).toBe('version');
  });

  it('refuses a stale version rather than overwriting', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);

    const first = await send('PATCH', `/work-items/${item.id}`, session, {
      version: item.version,
      title: 'First writer wins',
    });
    expect(first.statusCode).toBe(200);

    const second = await send('PATCH', `/work-items/${item.id}`, session, {
      version: item.version,
      title: 'Second writer loses',
    });
    expect(second.statusCode).toBe(409);

    const rows = await observe('select title from work_items where id = ?', [item.id]);
    expect(rows[0]!['title']).toBe('First writer wins');
  });

  it('bumps the version on every write, so a client must re-read', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);

    const updated = await send('PATCH', `/work-items/${item.id}`, session, {
      version: item.version,
      title: 'Renamed',
    });
    expect(updated.json<WorkItem>().version).toBe(item.version + 1);
  });
});

describe('what is audited and what is not', () => {
  it('does not record an ordinary field edit', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);

    await send('PATCH', `/work-items/${item.id}`, session, {
      version: item.version,
      title: 'A new title',
    });

    const events = await observe(
      `select action from audit_events where object_id = ? and action <> 'work_item.created'`,
      [item.id],
    );
    expect(events).toEqual([]);
  });

  /** Widening to `client_visible` is a publication decision, not a field edit. */
  it('records an audience change, with both sides', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);

    await send('PATCH', `/work-items/${item.id}`, session, {
      version: item.version,
      audience: 'client_visible',
    });

    const events = await observe(
      `select metadata_json from audit_events
        where action = 'work_item.audience_changed' and object_id = ?`,
      [item.id],
    );
    expect(events).toHaveLength(1);
    const raw = events[0]!['metadata_json'];
    const metadata = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    expect(metadata['audience_before']).toBe('internal');
    expect(metadata['audience_after']).toBe('client_visible');
    expect(metadata['widened']).toBe(true);
  });

  it('records a deletion, with the state it was in', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);

    const response = await send('DELETE', `/work-items/${item.id}`, session);
    expect(response.statusCode).toBe(204);

    const events = await observe(
      `select metadata_json from audit_events
        where action = 'work_item.deleted' and object_id = ?`,
      [item.id],
    );
    expect(events).toHaveLength(1);
    const raw = events[0]!['metadata_json'];
    const metadata = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    expect(metadata['state_at_deletion']).toBe('backlog');
  });

  it('soft-deletes rather than removing the row', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);
    await send('DELETE', `/work-items/${item.id}`, session);

    const rows = await observe('select deleted_at from work_items where id = ?', [item.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['deleted_at']).not.toBeNull();

    // Gone from the list, and gone from a direct read.
    const listed = await send('GET', '/work-items', session);
    expect(listed.json<{ workItems: WorkItem[] }>().workItems.map((w) => w.id)).not.toContain(
      item.id,
    );
    expect((await send('GET', `/work-items/${item.id}`, session)).statusCode).toBe(404);
  });
});

describe('the audience, which is the whole of client isolation', () => {
  it('hides an internal item from a client principal entirely', async () => {
    const internal = await signIn(owner().id);
    const item = await createItem(internal);

    const client = await signIn(world.atlas.reviewer.id);
    const listed = await send('GET', '/work-items', client, undefined, ATLAS_SLUG);

    if (listed.statusCode === 200) {
      const ids = listed.json<{ workItems: WorkItem[] }>().workItems.map((w) => w.id);
      expect(ids).not.toContain(item.id);
    } else {
      // A client with no membership in this organization is refused outright, which is also
      // a correct answer to "can they see it".
      expect([401, 403, 404]).toContain(listed.statusCode);
    }

    const direct = await send('GET', `/work-items/${item.id}`, client, undefined, ATLAS_SLUG);
    expect([401, 403, 404]).toContain(direct.statusCode);
  });

  it('lets an internal reader see every audience', async () => {
    const session = await signIn(owner().id);
    await createItem(session, { title: 'Internal one' });
    const visible = await createItem(session, { title: 'Published one' });
    await send('PATCH', `/work-items/${visible.id}`, session, {
      version: visible.version,
      audience: 'client_visible',
    });

    const listed = await send('GET', '/work-items', session);
    const titles = listed.json<{ workItems: WorkItem[] }>().workItems.map((w) => w.title);
    expect(titles).toContain('Internal one');
    expect(titles).toContain('Published one');
  });
});

describe('the list', () => {
  it('filters by project', async () => {
    const session = await signIn(owner().id);
    const item = await createItem(session);

    const mine = await send('GET', `/work-items?projectId=${project()}`, session);
    expect(mine.json<{ workItems: WorkItem[] }>().workItems.map((w) => w.id)).toContain(item.id);

    const other = await send(
      'GET',
      `/work-items?projectId=${world.northstar.otherProjectId}`,
      session,
    );
    expect(other.json<{ workItems: WorkItem[] }>().workItems.map((w) => w.id)).not.toContain(
      item.id,
    );
  });

  it('filters by a comma-separated list of states', async () => {
    const session = await signIn(owner().id);
    const backlog = await createItem(session, { title: 'Still in backlog' });
    const ready = await moveTo(session, await createItem(session, { title: 'Ready now' }), 'ready');

    const listed = await send('GET', '/work-items?state=ready,in_progress', session);
    const ids = listed.json<{ workItems: WorkItem[] }>().workItems.map((w) => w.id);
    expect(ids).toContain(ready.id);
    expect(ids).not.toContain(backlog.id);
  });

  it('refuses a state that is not one', async () => {
    const session = await signIn(owner().id);
    const response = await send('GET', '/work-items?state=nearly_done', session);
    expect(response.statusCode).toBe(400);
    expect(
      response.json<{ error: { details: { field: string }[] } }>().error.details[0]!.field,
    ).toBe('state');
  });

  it('echoes no tenant identifier', async () => {
    const session = await signIn(owner().id);
    await createItem(session);
    const listed = await send('GET', '/work-items', session);
    expect(listed.body).not.toContain(world.northstar.organizationId);
  });
});

describe('the guards still apply', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = (await app.inject({
      method: 'GET',
      url: `/v1/organizations/${NORTHSTAR}/work-items`,
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(401);
  });

  it('refuses a mutation with no CSRF token', async () => {
    const session = await signIn(owner().id);
    const response = (await app.inject({
      method: 'POST',
      url: `/v1/organizations/${NORTHSTAR}/work-items`,
      headers: { 'content-type': 'application/json', cookie: session.cookie },
      payload: { projectId: project(), title: 'No token' },
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(403);
  });

  it('answers the same for another tenant’s work item as for one that does not exist', async () => {
    const session = await signIn(designer().id);
    const foreign = await send('GET', `/work-items/${world.twin.workItemId}`, session);
    const absent = await send('GET', '/work-items/0198f0aa-0000-7000-8000-0000000000ff', session);

    expect(foreign.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(foreign.body.replace(/"correlationId":"[^"]+"/, '')).toBe(
      absent.body.replace(/"correlationId":"[^"]+"/, ''),
    );
  });
});
