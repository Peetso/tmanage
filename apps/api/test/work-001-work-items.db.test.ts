import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { WORK_ITEM_STATES } from '@tmanage/domain';
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

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId);
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
        // A real member since 0013: the owner is written to `owner_user_id` and checked
        // against the memberships table first. 'someone' would now earn a 422.
        next: 'done',
        facts: { ownerId: owner().id, completedAt: '2026-08-26T12:00:00.000Z' },
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
  ({ app, db } = await bootHttpHarness({
    secretTag: 'the_work_items_suite',
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

/**
 * 0013: the two facts `done` requires are stored, not discarded. Recorded 2026-08-31 as
 * "internal_review -> done requires two facts the schema then discards"; closed 2026-09-01.
 */
describe('completion (0013)', () => {
  async function inReview(session: Session): Promise<WorkItem> {
    return moveTo(
      session,
      await createItem(session, { title: 'Finish the style guide' }),
      'internal_review',
    );
  }

  it('writes the owner and the completion time to the row, and the view carries them', async () => {
    const session = await signIn(owner().id);
    const item = await inReview(session);

    const response = await send('POST', `/work-items/${item.id}/transitions`, session, {
      version: item.version,
      to: 'done',
      facts: { ownerId: designer().id, completedAt: '2026-08-30T15:45:00.000Z' },
    });
    expect(response.statusCode).toBe(200);
    const done = response.json<WorkItem & { completedAt: string | null }>();
    expect(done.state).toBe('done');
    expect(done.ownerUserId).toBe(designer().id);
    expect(done.completedAt).toBe('2026-08-30T15:45:00.000Z');

    const rows = await observe(
      'select owner_user_id as ownerUserId, completed_at as completedAt from work_items where id = ?',
      [item.id],
    );
    expect(rows[0]?.['ownerUserId']).toBe(designer().id);
    expect(new Date(rows[0]?.['completedAt'] as Date).toISOString()).toBe(
      '2026-08-30T15:45:00.000Z',
    );
  });

  it('refuses an owner who is not an active member of this organization, naming the field', async () => {
    const session = await signIn(owner().id);
    const item = await inReview(session);

    const response = await send('POST', `/work-items/${item.id}/transitions`, session, {
      version: item.version,
      to: 'done',
      facts: { ownerId: world.brightops.owner.id, completedAt: '2026-08-30T15:45:00.000Z' },
    });
    expect(response.statusCode).toBe(422);
    const details = response.json<{ error: { details: { field: string }[] } }>().error.details;
    expect(details.map((d) => d.field)).toEqual(['ownerId']);
    // Nothing moved.
    expect(
      (await observe('select state from work_items where id = ?', [item.id]))[0]?.['state'],
    ).toBe('internal_review');
  });

  it('refuses a completion time that is not an instant, or is in the future', async () => {
    const session = await signIn(owner().id);
    const item = await inReview(session);

    const garbled = await send('POST', `/work-items/${item.id}/transitions`, session, {
      version: item.version,
      to: 'done',
      facts: { ownerId: owner().id, completedAt: 'yesterday-ish' },
    });
    expect(garbled.statusCode).toBe(422);
    expect(
      garbled.json<{ error: { details: { field: string; message: string }[] } }>().error.details,
    ).toEqual([{ field: 'completedAt', message: 'must be an ISO 8601 instant' }]);

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const future = await send('POST', `/work-items/${item.id}/transitions`, session, {
      version: item.version,
      to: 'done',
      facts: { ownerId: owner().id, completedAt: tomorrow },
    });
    expect(future.statusCode).toBe(422);
    expect(
      future.json<{ error: { details: { field: string; message: string }[] } }>().error.details,
    ).toEqual([{ field: 'completedAt', message: 'must not be in the future' }]);
  });

  it('still lets the machine name a missing fact rather than the parser naming its shape', async () => {
    const session = await signIn(owner().id);
    const item = await inReview(session);

    const response = await send('POST', `/work-items/${item.id}/transitions`, session, {
      version: item.version,
      to: 'done',
      facts: { ownerId: owner().id },
    });
    expect(response.statusCode).toBe(422);
    const details = response.json<{ error: { details: { field: string; message: string }[] } }>()
      .error.details;
    expect(details).toEqual([{ field: 'completedAt', message: 'is required for this transition' }]);
  });

  it('clears the completion time when the item is reopened, and keeps it when archived', async () => {
    const session = await signIn(owner().id);
    const done = await moveTo(session, await createItem(session), 'done');
    expect((done as WorkItem & { completedAt: string | null }).completedAt).not.toBeNull();

    const reopened = await send('POST', `/work-items/${done.id}/transitions`, session, {
      version: done.version,
      to: 'in_progress',
      facts: { reopenReason: 'The client found a broken link' },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json<{ completedAt: string | null }>().completedAt).toBeNull();

    const again = await moveTo(session, await createItem(session), 'done');
    const archived = await send('POST', `/work-items/${again.id}/transitions`, session, {
      version: again.version,
      to: 'archived',
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ completedAt: string | null }>().completedAt).toBe(
      '2026-08-26T12:00:00.000Z',
    );
  });
});

/** Two refusals the 2026-09-01 fleet found in the code around the completion change. */
describe('what the fleet found beside the completion change', () => {
  it('refuses backlog -> done as illegal, never as "the owner is not a member"', async () => {
    // The completion facts are parsed only for a move the machine has. Otherwise a caller
    // could learn whether any user id is an active member by attempting an illegal move.
    const session = await signIn(owner().id);
    const item = await createItem(session);

    const response = await send('POST', `/work-items/${item.id}/transitions`, session, {
      version: item.version,
      to: 'done',
      facts: { ownerId: world.brightops.owner.id, completedAt: '2026-08-30T15:45:00.000Z' },
    });
    expect(response.statusCode).toBe(422);
    const error = response.json<{ error: { message: string; details?: unknown[] } }>().error;
    expect(error.message).toBe('A work item cannot move from backlog to done');
    expect(error.details).toBeUndefined();
  });

  it('treats a blank blocker owner as no owner rather than as a user whose id is empty', async () => {
    const session = await signIn(owner().id);
    const item = await moveTo(session, await createItem(session), 'in_progress');

    const response = await send('POST', `/work-items/${item.id}/transitions`, session, {
      version: item.version,
      to: 'blocked',
      facts: { blockerReason: 'No key', blockerAsk: 'The key', blockerOwnerUserId: '   ' },
    });
    expect(response.statusCode).toBe(200);
    const rows = await observe(
      'select owner_user_id as ownerUserId from work_blockers where work_item_id = ?',
      [item.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['ownerUserId']).toBeNull();
  });
});

/**
 * The list applies `mayRead` after SQL's `limit`. Recorded 2026-08-31 as "a full page can come
 * back short"; closed 2026-09-01 by paging on until `limit` readable rows are in hand.
 */
describe('a page is limit readable rows', () => {
  it('does not end the list early when the first SQL page is all rows this member may not read', async () => {
    const boss = await signIn(owner().id);
    // A marker in the designer's project, then two rows in the project the designer is NOT on,
    // then one more in theirs. Ids are UUIDv7, so this is also their sort order.
    const marker = await createItem(boss, { title: 'Marker' });
    const hiddenOne = await createItem(boss, {
      projectId: world.northstar.otherProjectId,
      title: 'Hidden one',
    });
    const hiddenTwo = await createItem(boss, {
      projectId: world.northstar.otherProjectId,
      title: 'Hidden two',
    });
    const visible = await createItem(boss, { title: 'Visible after the hidden ones' });

    // The pin depends on that order. UUIDv7 orders by millisecond and is random within one,
    // and four HTTP round trips never land in the same millisecond — but if they ever did,
    // this fails loudly here rather than letting the case pass against the old code.
    const minted = [marker.id, hiddenOne.id, hiddenTwo.id, visible.id];
    expect(minted).toEqual([...minted].sort());

    // Before the fix, SQL's page of 2 after the marker was exactly the two hidden rows, the
    // filter emptied it, and the designer was told the list ended here.
    const designer = await signIn(world.northstar.designer.id);
    const page = await send('GET', `/work-items?after=${marker.id}&limit=2`, designer);
    expect(page.statusCode).toBe(200);
    const ids = page.json<{ workItems: WorkItem[] }>().workItems.map((w) => w.id);
    expect(ids).toEqual([visible.id]);
  });
});

/**
 * WORK-002's cursor, proved at the API. Added 2026-08-30: the `after` keyset cursor had
 * been implemented since WORK-001 landed and driven by WEB-002's screens, and no database
 * case had ever exercised it — the gap the WORK-002 re-derivation found. Ids are UUIDv7,
 * so id order is creation order and the cursor is the last row's id.
 */
describe('the cursor', () => {
  it('pages in id order without overlap or omission, and a short page ends the walk', async () => {
    const session = await signIn(owner().id);
    const created: string[] = [];
    for (const title of ['One', 'Two', 'Three', 'Four', 'Five']) {
      created.push((await createItem(session, { title: `Cursor ${title}` })).id);
    }
    // The seed world adds one existing item to this project; the full set is created + it.
    const all = await send('GET', '/work-items?limit=200', session);
    const everything = all.json<{ workItems: WorkItem[] }>().workItems.map((w) => w.id);

    const walked: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await send(
        'GET',
        `/work-items?limit=2${after === undefined ? '' : `&after=${after}`}`,
        session,
      );
      const rows = page.json<{ workItems: WorkItem[] }>().workItems;
      walked.push(...rows.map((w) => w.id));
      if (rows.length < 2) break;
      after = rows[rows.length - 1]!.id;
    }

    // Same rows, same order, each exactly once — the property a keyset cursor exists for.
    expect(walked).toEqual(everything);
    expect(new Set(walked).size).toBe(walked.length);
    expect([...walked].sort()).toEqual([...walked]);
    for (const id of created) expect(walked).toContain(id);
  });

  it('composes with filters: the page after a cursor still honours the state filter', async () => {
    const session = await signIn(owner().id);
    const readyIds: string[] = [];
    for (const title of ['A', 'B', 'C']) {
      const item = await createItem(session, { title: `Ready ${title}` });
      readyIds.push((await moveTo(session, item, 'ready')).id);
    }
    await createItem(session, { title: 'Still backlog' });

    const first = await send('GET', '/work-items?state=ready&limit=2', session);
    const firstRows = first.json<{ workItems: WorkItem[] }>().workItems;
    expect(firstRows).toHaveLength(2);
    const second = await send(
      'GET',
      `/work-items?state=ready&limit=2&after=${firstRows[1]!.id}`,
      session,
    );
    const secondRows = second.json<{ workItems: WorkItem[] }>().workItems;
    expect(secondRows.map((w) => w.id)).toEqual([readyIds[2]]);
    for (const row of [...firstRows, ...secondRows]) expect(row.state).toBe('ready');
  });

  it('a cursor cannot reach across the tenant boundary', async () => {
    const session = await signIn(owner().id);
    await createItem(session);
    // The twin's work item id as a cursor is just a value to compare ids against: the
    // tenant predicate still binds every row, so nothing of the twin's is reachable and
    // nothing of ours is hidden beyond ordinary id comparison.
    const page = await send('GET', `/work-items?after=${world.twin.workItemId}`, session);
    expect(page.statusCode).toBe(200);
    const rows = page.json<{ workItems: WorkItem[] }>().workItems;
    for (const row of rows) {
      expect(row.id > world.twin.workItemId).toBe(true);
      expect(row.id).not.toBe(world.twin.workItemId);
    }
    expect(page.body).not.toContain(world.twin.organizationId);
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
