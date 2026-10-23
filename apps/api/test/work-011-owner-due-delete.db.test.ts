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
 * WORK-011 (P9) over real HTTP — the work item detail's owner and due-date pickers, its edit and
 * its delete, against the API those controls call (`PATCH` and `DELETE …/work-items/:id`).
 *
 * WORK-001 proves the version token, the audience audit and that a deletion is audited at all.
 * What P9 added a screen for, and what this suite therefore pins, is the owner and due-date
 * columns being set and cleared through `PATCH`, who may do it, that an owner must be somebody
 * who can act in this organization, that a delete is a 404 afterwards to every caller and audited
 * exactly once, and that neither write reaches across the tenant boundary.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const NORTHSTAR = 'northstar-studio';

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId);
}

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

interface WorkItem {
  id: string;
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
    projectId: world.northstar.projectId,
    title: 'Draft the booking confirmation email',
    ...overrides,
  });
  if (response.statusCode !== 201) {
    throw new Error(`create failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<WorkItem>();
}

async function row(id: string): Promise<RowDataPacket | undefined> {
  const rows = await observe(
    'select owner_user_id, due_at, version, deleted_at, title from work_items where id = ?',
    [id],
  );
  return rows[0];
}

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_work_owner_due_delete_suite' }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
});

afterAll(async () => {
  await stopHarness({ app, db });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('setting and clearing the owner and the due date', () => {
  it('writes both columns, bumps the version, and a re-read carries them', async () => {
    const session = await signIn(world.northstar.designer.id);
    const item = await createItem(session);

    const due = '2026-11-30T15:00:00.000Z';
    const response = await send('PATCH', `/work-items/${item.id}`, session, {
      version: item.version,
      ownerUserId: world.northstar.manager.id,
      dueAt: due,
    });
    expect(response.statusCode).toBe(200);
    const updated = response.json<WorkItem>();
    expect(updated.ownerUserId).toBe(world.northstar.manager.id);
    expect(new Date(updated.dueAt ?? '').toISOString()).toBe(due);
    expect(updated.version).toBe(item.version + 1);

    const stored = await row(item.id);
    expect(stored?.['owner_user_id']).toBe(world.northstar.manager.id);
    expect(new Date(stored?.['due_at'] as string | Date).toISOString()).toBe(due);

    const reread = await send('GET', `/work-items/${item.id}`, session);
    expect(reread.json<WorkItem>().ownerUserId).toBe(world.northstar.manager.id);
  });

  it('clears both with an explicit null, and leaves a field it was not sent alone', async () => {
    const session = await signIn(world.northstar.owner.id);
    const item = await createItem(session, {
      ownerUserId: world.northstar.designer.id,
      dueAt: '2026-12-01T09:00:00.000Z',
    });

    // Only the owner is sent: the due date must survive.
    const first = await send('PATCH', `/work-items/${item.id}`, session, {
      version: item.version,
      ownerUserId: null,
    });
    expect(first.statusCode).toBe(200);
    let stored = await row(item.id);
    expect(stored?.['owner_user_id']).toBeNull();
    expect(stored?.['due_at']).not.toBeNull();

    const second = await send('PATCH', `/work-items/${item.id}`, session, {
      version: first.json<WorkItem>().version,
      dueAt: null,
    });
    expect(second.statusCode).toBe(200);
    stored = await row(item.id);
    expect(stored?.['due_at']).toBeNull();
    expect(stored?.['title']).toBe('Draft the booking confirmation email');
  });

  it('refuses a due date that is not an instant, with no write', async () => {
    const session = await signIn(world.northstar.owner.id);
    const item = await createItem(session);

    const response = await send('PATCH', `/work-items/${item.id}`, session, {
      version: item.version,
      dueAt: 'next tuesday',
    });
    expect(response.statusCode).toBe(400);
    expect((await row(item.id))?.['version']).toBe(item.version);
  });

  it('refuses an owner from another organization, and the row keeps no foreign user id', async () => {
    // Tarek owns BrightOps and holds no membership here. The owner picker only offers this
    // studio's people, but the API is the boundary: a hand-made PATCH naming him must not put
    // another tenant's person on this tenant's row.
    const session = await signIn(world.northstar.owner.id);
    const item = await createItem(session);

    const response = await send('PATCH', `/work-items/${item.id}`, session, {
      version: item.version,
      ownerUserId: world.brightops.owner.id,
    });
    expect(response.statusCode).toBe(422);
    const stored = await row(item.id);
    expect(stored?.['owner_user_id']).toBeNull();
    expect(stored?.['version']).toBe(item.version);
  });

  it('refuses a foreign owner on create too, and no item is written', async () => {
    const session = await signIn(world.northstar.owner.id);
    const response = await send('POST', '/work-items', session, {
      projectId: world.northstar.projectId,
      title: 'Owned from another tenant',
      ownerUserId: world.twin.owner.id,
    });
    expect(response.statusCode).toBe(422);
    expect(
      await observe('select id from work_items where title = ?', ['Owned from another tenant']),
    ).toHaveLength(0);
  });

  it('refuses a client person as the owner of internal work', async () => {
    const session = await signIn(world.northstar.owner.id);
    const item = await createItem(session);

    const response = await send('PATCH', `/work-items/${item.id}`, session, {
      version: item.version,
      ownerUserId: world.atlas.reviewer.id,
    });
    expect(response.statusCode).toBe(422);
    expect((await row(item.id))?.['owner_user_id']).toBeNull();
  });
});

describe('who may edit and delete', () => {
  it('refuses a client reviewer both writes on an item they can read, with nothing written', async () => {
    const internal = await signIn(world.northstar.owner.id);
    const item = await createItem(internal, { audience: 'client_visible' });

    const client = await signIn(world.atlas.reviewer.id);
    const patch = await send('PATCH', `/work-items/${item.id}`, client, {
      version: item.version,
      ownerUserId: world.atlas.reviewer.id,
      dueAt: '2026-12-24T00:00:00.000Z',
    });
    expect([403, 404]).toContain(patch.statusCode);
    const del = await send('DELETE', `/work-items/${item.id}`, client);
    expect([403, 404]).toContain(del.statusCode);

    const stored = await row(item.id);
    expect(stored?.['owner_user_id']).toBeNull();
    expect(stored?.['due_at']).toBeNull();
    expect(stored?.['deleted_at']).toBeNull();
    expect(
      await observe(`select id from audit_events where action = 'work_item.deleted'`),
    ).toHaveLength(0);
  });

  it('lets an ordinary member on the project delete, audited once with the actor and tenant', async () => {
    const session = await signIn(world.northstar.designer.id);
    const item = await createItem(session);

    expect((await send('DELETE', `/work-items/${item.id}`, session)).statusCode).toBe(204);
    // Gone for the next write too: neither a second delete nor a late PATCH finds it.
    expect((await send('DELETE', `/work-items/${item.id}`, session)).statusCode).toBe(404);
    const late = await send('PATCH', `/work-items/${item.id}`, session, {
      version: item.version,
      dueAt: '2026-12-01T09:00:00.000Z',
    });
    expect(late.statusCode).toBe(404);
    expect((await row(item.id))?.['due_at']).toBeNull();

    const events = await observe(
      `select organization_id, actor_user_id, object_type from audit_events
        where action = 'work_item.deleted' and object_id = ?`,
      [item.id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.['organization_id']).toBe(world.northstar.organizationId);
    expect(events[0]?.['actor_user_id']).toBe(world.northstar.designer.id);
  });
});

describe('the tenant boundary', () => {
  it('another tenant’s owner can neither edit nor delete this item through their own slug', async () => {
    const session = await signIn(world.northstar.owner.id);
    const item = await createItem(session);

    // The adversarial twin: same project name, organization id one hex digit away.
    const twin = await signIn(world.twin.owner.id);
    const twinSlug = 'northstar-studios';
    const patch = await send(
      'PATCH',
      `/work-items/${item.id}`,
      twin,
      { version: item.version, ownerUserId: world.twin.owner.id },
      twinSlug,
    );
    expect(patch.statusCode).toBe(404);
    const del = await send('DELETE', `/work-items/${item.id}`, twin, undefined, twinSlug);
    expect(del.statusCode).toBe(404);

    const stored = await row(item.id);
    expect(stored?.['owner_user_id']).toBeNull();
    expect(stored?.['deleted_at']).toBeNull();
    expect(stored?.['version']).toBe(item.version);
    expect(
      await observe(`select id from audit_events where action = 'work_item.deleted'`),
    ).toHaveLength(0);
  });

  it('this tenant’s owner cannot reach BrightOps’ item through a slug they have no membership in', async () => {
    const session = await signIn(world.northstar.owner.id);
    const target = world.brightops.workItemId;

    const del = await send(
      'DELETE',
      `/work-items/${target}`,
      session,
      undefined,
      'brightops-consulting',
    );
    expect(del.statusCode).toBe(404);
    // Nor through their own slug, naming the foreign id.
    expect((await send('DELETE', `/work-items/${target}`, session)).statusCode).toBe(404);
    expect((await row(target))?.['deleted_at']).toBeNull();
  });
});
