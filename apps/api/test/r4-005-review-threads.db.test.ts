import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
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
 * R4 slice 5 over real HTTP on MariaDB 11.8 — proofing threads (migration 0268).
 *
 * 1. **Registry.** Both tables are tenant tables in TABLES / TENANT_TABLES / users.sql.
 * 2. **Numbering.** Pins on one file are numbered 1, 2, 3 … even when several are posted at once
 *    (the lock, the unique key and the retry), and a later version continues the count.
 * 3. **Audience.** A client mentioned on an internal thread is refused; `audience` cannot be
 *    changed in the database (trigger).
 * 4. **Tenant isolation.** The twin studio gets the one 404.
 * 5. **Backfill.** 0268's two INSERT … SELECT statements, run again on fresh `file_comments`,
 *    make one numbered thread per old comment on the root of the chain, with the right audience.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);
const MIGRATION = readFileSync(resolve(HERE, '../migrations/0268_review_threads.sql'), 'utf8');

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
  method: 'GET' | 'POST' | 'PATCH',
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

/** An uploaded, scanned, promoted file with one stored version. */
async function file(audience = 'internal'): Promise<{ id: string; versionId: string }> {
  const id = uuidv7();
  const versionId = uuidv7();
  await db.admin.execute(
    `insert into file_assets
       (id, organization_id, project_id, owner_user_id, name, purpose, object_id, audience,
        status, version)
     values (?, ?, ?, ?, 'poster.png', 'deliverable', ?, ?, 'ready', 1)`,
    [
      id,
      world.northstar.organizationId,
      world.northstar.projectId,
      world.northstar.owner.id,
      uuidv7(),
      audience,
    ],
  );
  await db.admin.execute(
    `insert into file_versions
       (id, organization_id, file_asset_id, version_no, object_key, size_bytes,
        declared_mime_type, detected_mime_type)
     values (?, ?, ?, 1, ?, 10, 'image/png', 'image/png')`,
    [versionId, world.northstar.organizationId, id, `tenant/${world.northstar.organizationId}/x`],
  );
  // Born in quarantine (trigger); the scan pass promotes it.
  await db.admin.execute(
    `update file_versions set trust_zone = 'private', scan_verdict = 'clean', scanned_at = current_timestamp(3), scanner = 'test' where id = ?`,
    [versionId],
  );
  return { id, versionId };
}

async function chain(root: string, member: string, versionNo: number): Promise<void> {
  await db.admin.execute(
    `insert into attachment_versions
       (id, organization_id, project_id, root_file_asset_id, file_asset_id, version_no,
        created_by_user_id)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv7(),
      world.northstar.organizationId,
      world.northstar.projectId,
      root,
      member,
      versionNo,
      world.northstar.owner.id,
    ],
  );
}

const pin = (body: string, extra: Record<string, unknown> = {}) => ({
  anchorKind: 'pin',
  anchor: { x: 0.5, y: 0.25 },
  body,
  ...extra,
});

interface ThreadBody {
  id: string;
  number: number;
  audience: string;
  subjectId: string;
  comments: { body: string }[];
}

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_r4_005_suite', guardMode: 'enforce' }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
});

afterAll(async () => {
  await stopHarness({ app, db });
});

describe('0268 — registry', () => {
  it('both tables are tenant tables with app and worker grants', () => {
    for (const table of ['review_threads', 'review_comments']) {
      expect(Object.keys(TABLES)).toContain(table);
      expect(TENANT_TABLES[table]).toBe('organization_id');
      const onTable = (user: string) =>
        [...(intents.get(`'${user}'@'%'`)?.privileges ?? [])]
          .filter((key) => key.startsWith(`tmanage.${table}:`))
          .sort();
      expect(onTable('tmanage_app')).toEqual([
        `tmanage.${table}:DELETE`,
        `tmanage.${table}:INSERT`,
        `tmanage.${table}:UPDATE`,
      ]);
      expect(onTable('tmanage_worker')).toEqual([
        `tmanage.${table}:DELETE`,
        `tmanage.${table}:SELECT`,
      ]);
    }
  });
});

describe('0268 — threads over HTTP', () => {
  it('numbers pins per file, also when posted at once, and continues on a later version', async () => {
    const root = await file();
    const owner = await signIn(world.northstar.owner.id);
    const first = await send('POST', `/files/${root.id}/review/threads`, owner, pin('one'));
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json<ThreadBody>().number).toBe(1);

    const burst = await Promise.all(
      ['a', 'b', 'c', 'd'].map((body) =>
        send('POST', `/files/${root.id}/review/threads`, owner, pin(body)),
      ),
    );
    for (const response of burst) expect(response.statusCode, response.body).toBe(201);
    expect(burst.map((r) => r.json<ThreadBody>().number).sort()).toEqual([2, 3, 4, 5]);

    const v2 = await file();
    await chain(root.id, v2.id, 2);
    const later = await send(
      'POST',
      `/files/${v2.id}/review/threads`,
      owner,
      pin('on v2', { versionId: v2.versionId }),
    );
    expect(later.statusCode, later.body).toBe(201);
    expect(later.json<ThreadBody>()).toMatchObject({ number: 6, subjectId: root.id });

    const listed = await send('GET', `/files/${v2.id}/review/threads`, owner);
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ threads: ThreadBody[] }>().threads.map((t) => t.number)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    const onV2 = await send(
      'GET',
      `/files/${v2.id}/review/threads?versionId=${v2.versionId}`,
      owner,
    );
    expect(onV2.json<{ threads: ThreadBody[] }>().threads.map((t) => t.number)).toEqual([6]);

    const audits = await observe(
      `select count(*) as n from audit_events where action = 'review.thread_created'`,
    );
    expect(Number(audits[0]?.['n'])).toBe(6);
    const events = await observe(
      `select count(*) as n from outbox_events where type = 'review.thread_created.v1'`,
    );
    expect(Number(events[0]?.['n'])).toBe(6);
  });

  it('replies, resolves and reopens', async () => {
    const root = await file();
    const owner = await signIn(world.northstar.owner.id);
    const thread = (
      await send('POST', `/files/${root.id}/review/threads`, owner, pin('fix'))
    ).json<ThreadBody>();
    const reply = await send('POST', `/review/threads/${thread.id}/comments`, owner, {
      body: 'done',
    });
    expect(reply.statusCode, reply.body).toBe(201);
    const resolved = await send('POST', `/review/threads/${thread.id}/resolve`, owner, {});
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json<{ status: string }>().status).toBe('resolved');
    const reopened = await send('POST', `/review/threads/${thread.id}/unresolve`, owner, {});
    expect(reopened.json<{ status: string }>().status).toBe('open');
  });

  it('refuses a client mentioned on an internal thread, and makes it client-visible unasked', async () => {
    const root = await file('client_visible');
    const owner = await signIn(world.northstar.owner.id);
    const clientUser = world.atlas.reviewer.id;
    const refused = await send(
      'POST',
      `/files/${root.id}/review/threads`,
      owner,
      pin(`@${clientUser} look`, { audience: 'internal' }),
    );
    expect(refused.statusCode, refused.body).toBe(422);
    const shared = await send(
      'POST',
      `/files/${root.id}/review/threads`,
      owner,
      pin(`@${clientUser} look`),
    );
    expect(shared.statusCode, shared.body).toBe(201);
    expect(shared.json<ThreadBody>().audience).toBe('client_visible');
  });

  it('the audience cannot be changed in the database', async () => {
    const root = await file();
    const owner = await signIn(world.northstar.owner.id);
    const thread = (
      await send('POST', `/files/${root.id}/review/threads`, owner, pin('secret'))
    ).json<ThreadBody>();
    await expect(
      db.admin.execute(`update review_threads set audience = 'client_visible' where id = ?`, [
        thread.id,
      ]),
    ).rejects.toThrow(/audience is immutable/);
    await expect(
      db.admin.execute(`update review_threads set number = 99 where id = ?`, [thread.id]),
    ).rejects.toThrow(/immutable/);
  });

  it('gives the twin studio the one 404', async () => {
    const root = await file();
    const twin = await signIn(world.twin.owner.id);
    const response = await send('GET', `/files/${root.id}/review/threads`, twin, undefined, TWIN);
    expect(response.statusCode).toBe(404);
  });

  it('lists mention candidates: staff, and the client contacts for a client-visible comment', async () => {
    const owner = await signIn(world.northstar.owner.id);
    const staffOnly = await send(
      'GET',
      `/projects/${world.northstar.projectId}/review/mention-candidates?limit=25`,
      owner,
    );
    expect(staffOnly.statusCode, staffOnly.body).toBe(200);
    const kinds = staffOnly
      .json<{ candidates: { kind: string }[] }>()
      .candidates.map((c) => c.kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain('client');
    const withClients = await send(
      'GET',
      `/projects/${world.northstar.projectId}/review/mention-candidates?limit=25&audience=client_visible`,
      owner,
    );
    const people = withClients.json<{ candidates: { userId: string; kind: string }[] }>()
      .candidates;
    expect(people.find((c) => c.userId === world.atlas.reviewer.id)?.kind).toBe('client');
  });
});

describe('0268 — backfill of file_comments', () => {
  function statement(start: string): string {
    const from = MIGRATION.indexOf(start);
    const end = MIGRATION.indexOf(';', from);
    if (from < 0 || end < 0) throw new Error(`no statement ${start}`);
    return MIGRATION.slice(from, end);
  }

  it('makes one numbered thread per live comment on the root, with the file’s audience', async () => {
    const root = await file('internal');
    const v2 = await file('internal');
    await chain(root.id, v2.id, 2);
    const shared = await file('client_visible');
    const org = world.northstar.organizationId;
    const author = uuidv7();
    const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    const rows: [string, string, string, string, string | null][] = [
      [ids[0]!, root.id, 'first on v1', '2026-10-01 10:00:00.000', null],
      [ids[1]!, v2.id, 'then on v2', '2026-10-02 10:00:00.000', null],
      [ids[2]!, root.id, 'later on v1', '2026-10-03 10:00:00.000', null],
      [ids[3]!, shared.id, 'for the client', '2026-10-01 09:00:00.000', null],
      [ids[4]!, root.id, 'deleted', '2026-10-04 10:00:00.000', '2026-10-05 10:00:00.000'],
    ];
    for (const [id, assetId, body, at, deletedAt] of rows) {
      await db.admin.execute(
        `insert into file_comments (id, organization_id, file_asset_id, body, created_by, created_at, deleted_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        [id, org, assetId, body, author, at, deletedAt],
      );
    }
    await db.admin.query('delete from review_comments');
    await db.admin.query('delete from review_threads');
    await db.admin.query(statement('INSERT INTO review_threads'));
    await db.admin.query(statement('INSERT INTO review_comments'));

    const threads = await observe(
      `select id, subject_id, file_version_id, number, audience, anchor_kind, project_id,
              created_by_membership_id
         from review_threads order by subject_id, number`,
    );
    expect(threads).toHaveLength(4);
    const onRoot = threads.filter((row) => row['subject_id'] === root.id);
    expect(onRoot.map((row) => [row['id'], Number(row['number'])])).toEqual([
      [ids[0], 1],
      [ids[1], 2],
      [ids[2], 3],
    ]);
    expect(onRoot.map((row) => row['file_version_id'])).toEqual([
      root.versionId,
      v2.versionId,
      root.versionId,
    ]);
    expect(onRoot.every((row) => row['audience'] === 'internal')).toBe(true);
    const sharedThread = threads.find((row) => row['subject_id'] === shared.id);
    expect(sharedThread?.['audience']).toBe('client_visible');
    expect(Number(sharedThread?.['number'])).toBe(1);
    expect(threads.every((row) => row['anchor_kind'] === 'none')).toBe(true);
    expect(threads.every((row) => row['project_id'] === world.northstar.projectId)).toBe(true);
    expect(threads.every((row) => row['created_by_membership_id'] === author)).toBe(true);

    const comments = await observe(
      'select id, thread_id, body from review_comments order by created_at',
    );
    expect(comments.map((row) => row['body'])).toEqual([
      'for the client',
      'first on v1',
      'then on v2',
      'later on v1',
    ]);
    expect(comments.every((row) => row['id'] === row['thread_id'])).toBe(true);
  });
});
