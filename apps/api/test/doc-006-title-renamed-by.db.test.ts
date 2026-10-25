import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { TABLES } from '../src/common/database/schema.js';
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
 * DOC-006 over real HTTP — D2 (migration 0227): who last renamed a document.
 *
 * 1. **The column.** `documents.title_updated_by_user_id` exists, NULL until a rename, and is
 *    declared in the Drizzle schema.
 * 2. **A rename stamps the actor** from the acting context, and the view carries it.
 * 3. **A stale rename changes nothing** (409), and the adversarial twin gets a 404.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const NORTHSTAR = 'northstar-studio';
const TWIN = 'northstar-studios';

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId);
}

async function send(
  method: 'POST' | 'PATCH',
  path: string,
  session: Session,
  payload: unknown,
  slug = NORTHSTAR,
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url: `/v1/organizations/${slug}${path}`,
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
    },
    payload: payload as Record<string, unknown>,
  })) as unknown as InjectedResponse;
}

interface DocumentView {
  id: string;
  title: string;
  updatedAt: string;
  titleUpdatedByUserId?: string;
}

async function createDocument(session: Session): Promise<DocumentView> {
  const response = await send('POST', '/documents', session, {
    projectId: world.northstar.projectId,
    title: 'Atlas brief',
    body: 'Scope, timeline and the people involved.',
  });
  if (response.statusCode !== 201) {
    throw new Error(`create failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<DocumentView>();
}

async function renamedBy(documentId: string): Promise<unknown> {
  const [row] = await observe(
    'select title, title_updated_by_user_id from documents where id = ?',
    [documentId],
  );
  return row;
}

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_doc_006_suite', guardMode: 'enforce' }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
});

afterAll(async () => {
  await stopHarness({ app, db });
});

describe('0227 — the column', () => {
  it('is a nullable CHAR(36) on documents, declared in the schema', async () => {
    const [column] = await observe(
      `select data_type, character_maximum_length, is_nullable from information_schema.columns
        where table_schema = database() and table_name = 'documents'
          and column_name = 'title_updated_by_user_id'`,
    );
    expect(column).toBeDefined();
    expect(String(column!['data_type'] ?? column!['DATA_TYPE']).toLowerCase()).toBe('char');
    expect(Number(column!['character_maximum_length'] ?? column!['CHARACTER_MAXIMUM_LENGTH'])).toBe(
      36,
    );
    expect(String(column!['is_nullable'] ?? column!['IS_NULLABLE'])).toBe('YES');
    expect(Object.keys(TABLES)).toContain('documents');
  });
});

describe('0227 — a rename stamps who renamed it', () => {
  it('is NULL at creation and names the owner who renamed it', async () => {
    const author = await signIn(world.northstar.owner.id);
    const created = await createDocument(author);
    expect(await renamedBy(created.id)).toEqual({
      title: 'Atlas brief',
      title_updated_by_user_id: null,
    });
    expect(created.titleUpdatedByUserId).toBeUndefined();

    const response = await send('PATCH', `/documents/${created.id}`, author, {
      title: 'Atlas brief — v2',
      expectedUpdatedAt: created.updatedAt,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<DocumentView>().titleUpdatedByUserId).toBe(world.northstar.owner.id);
    expect(await renamedBy(created.id)).toEqual({
      title: 'Atlas brief — v2',
      title_updated_by_user_id: world.northstar.owner.id,
    });
  });

  it('changes nothing on a stale rename', async () => {
    const author = await signIn(world.northstar.owner.id);
    const created = await createDocument(author);
    const first = await send('PATCH', `/documents/${created.id}`, author, {
      title: 'Atlas brief — owner',
      expectedUpdatedAt: created.updatedAt,
    });
    expect(first.statusCode, first.body).toBe(200);

    const stale = await send('PATCH', `/documents/${created.id}`, author, {
      title: 'Atlas brief — stale',
      expectedUpdatedAt: created.updatedAt,
    });
    expect(stale.statusCode).toBe(409);
    expect(await renamedBy(created.id)).toEqual({
      title: 'Atlas brief — owner',
      title_updated_by_user_id: world.northstar.owner.id,
    });
  });

  it('gives the adversarial twin a 404 and leaves the stamp alone', async () => {
    const author = await signIn(world.northstar.owner.id);
    const created = await createDocument(author);
    const twin = await signIn(world.twin.owner.id);
    const response = await send(
      'PATCH',
      `/documents/${created.id}`,
      twin,
      { title: 'Twin title', expectedUpdatedAt: created.updatedAt },
      TWIN,
    );
    expect(response.statusCode).toBe(404);
    expect(await renamedBy(created.id)).toEqual({
      title: 'Atlas brief',
      title_updated_by_user_id: null,
    });
  });
});
