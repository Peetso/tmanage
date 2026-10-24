import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import {
  createRequestDeferSweepStore,
  createWorkerDatabase,
  sweepDeferredRequests,
} from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
import { usingLeastPrivilegeCredential } from './support/test-database.js';
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
 * REQ-004 over real HTTP and the worker — A7 (0220) "Defer until" and A8 (0221) files on a
 * request message.
 *
 * Defer (0220):
 * 1. **The sweep reopens what is due, and only that.** A request deferred to a past day goes back
 *    to `triage` with its schedule cleared; one deferred to a future day stays parked. A second
 *    run reopens nothing.
 * 2. **The reminder reaches the deferrer in the request's own tenant**, once.
 * 3. **"Reopen now"** clears the schedule too, and the adversarial twin cannot reach it.
 *
 * Files (0221):
 * 4. **A message carries the files uploaded to that request**, and nothing else.
 * 5. **Append-only.** The trigger refuses any UPDATE; `users.sql` grants the runtime INSERT only.
 * 6. **Tenant isolation.** The composite keys refuse a cross-tenant message or file.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;
let workerDb: WorkerDatabase;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);

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
  method: 'GET' | 'POST',
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

interface RequestView {
  id: string;
  version: number;
  state: string;
  deferUntil?: string | null;
  remindOnReopen?: boolean;
}

const manager = () => world.northstar.manager;

async function fileRequest(
  session: Session,
  projectId = world.northstar.projectId,
): Promise<RequestView> {
  const response = await send('POST', '/portal/requests', session, {
    projectId,
    title: 'Add a careers page',
    description: 'We need a careers page before the recruitment round opens.',
  });
  if (response.statusCode !== 201) {
    throw new Error(`submit failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<RequestView>();
}

async function move(
  session: Session,
  request: { id: string; version: number },
  to: string,
  facts: Record<string, unknown> = {},
): Promise<RequestView> {
  const response = await send('POST', `/client-requests/${request.id}/transitions`, session, {
    version: request.version,
    to,
    ...facts,
  });
  if (response.statusCode !== 200) {
    throw new Error(`transition to ${to} failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<RequestView>();
}

/** A request filed by Atlas, triaged and deferred by the manager to `day`. */
async function deferredRequest(day: string, remindOnReopen: boolean): Promise<RequestView> {
  const client = await signIn(world.atlas.reviewer.id);
  const filed = await fileRequest(client);
  const studio = await signIn(manager().id);
  const triaged = await move(studio, filed, 'triage');
  return move(studio, triaged, 'deferred', {
    clientVisibleReason: 'We will pick this up after the launch.',
    deferUntil: day,
    remindOnReopen,
  });
}

async function scheduleOf(requestId: string): Promise<RowDataPacket> {
  const [row] = await observe(
    `select state, defer_until, reopen_reminder, deferred_by_user_id
       from client_requests where id = ?`,
    [requestId],
  );
  return row!;
}

/** A file the client uploaded to `requestId` (the portal upload session's end state). */
async function uploadedFile(
  requestId: string,
  options: { organizationId?: string; clientOrganizationId?: string; projectId?: string } = {},
): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await db.admin.execute(
    `insert into file_assets
       (id, organization_id, project_id, owner_user_id, client_organization_id, name, purpose,
        object_id, audience, status, version, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, 'request_attachment', ?, 'client_visible', 'ready', 1, ?, ?)`,
    [
      id,
      options.organizationId ?? world.northstar.organizationId,
      options.projectId ?? world.northstar.projectId,
      world.atlas.reviewer.id,
      options.clientOrganizationId ?? world.atlas.clientOrganizationId,
      'brief.pdf',
      requestId,
      now,
      now,
    ],
  );
  return id;
}

async function attachmentsOf(requestId: string): Promise<RowDataPacket[]> {
  return observe(
    'select id, organization_id, message_id, file_asset_id from request_message_files where request_id = ?',
    [requestId],
  );
}

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_req_004_suite', guardMode: 'enforce' }));
  workerDb = createWorkerDatabase({ url: db.url, connectionLimit: 2, statementTimeoutMs: 15_000 });
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
});

afterAll(async () => {
  await workerDb?.end();
  await stopHarness({ app, db });
});

// ─────────────────────────────────────────────────────────────────────────────
// 0220 · Defer until
// ─────────────────────────────────────────────────────────────────────────────

describe('0220 — deferring to a day', () => {
  it('stores the day, the reminder and the deferrer on the request', async () => {
    const deferred = await deferredRequest('2999-01-01', true);
    expect(deferred.state).toBe('deferred');
    expect(deferred.deferUntil).toBe('2999-01-01');
    expect(deferred.remindOnReopen).toBe(true);

    const row = await scheduleOf(deferred.id);
    expect(row['state']).toBe('deferred');
    expect(Number(row['reopen_reminder'])).toBe(1);
    expect(row['deferred_by_user_id']).toBe(manager().id);
  });

  it('refuses a day on a move that is not to deferred', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const filed = await fileRequest(client);
    const studio = await signIn(manager().id);
    const response = await send('POST', `/client-requests/${filed.id}/transitions`, studio, {
      version: filed.version,
      to: 'triage',
      deferUntil: '2999-01-01',
    });
    expect(response.statusCode).toBe(400);
    expect((await scheduleOf(filed.id))['defer_until']).toBeNull();
  });
});

describe('0220 — the defer sweep', () => {
  it('reopens a due request to triage, clears its schedule and reminds the deferrer once', async () => {
    const due = await deferredRequest('2000-01-03', true);
    const parked = await deferredRequest('2999-01-01', true);

    const first = await sweepDeferredRequests(createRequestDeferSweepStore(workerDb));
    expect(first).toEqual({ reopened: 1, reminded: 1 });

    const reopened = await scheduleOf(due.id);
    expect(reopened['state']).toBe('triage');
    expect(reopened['defer_until']).toBeNull();
    expect(Number(reopened['reopen_reminder'])).toBe(0);
    expect(reopened['deferred_by_user_id']).toBeNull();

    // The future one is untouched.
    const still = await scheduleOf(parked.id);
    expect(still['state']).toBe('deferred');
    expect(still['defer_until']).not.toBeNull();

    // One notice, to the manager who deferred it, in the request's own tenant.
    const notices = await observe(
      `select organization_id, recipient_user_id, object_id from notifications
        where type = 'client_request.reopened.v1'`,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!['organization_id']).toBe(world.northstar.organizationId);
    expect(notices[0]!['recipient_user_id']).toBe(manager().id);
    expect(notices[0]!['object_id']).toBe(due.id);

    // Idempotent: nothing more is due.
    const second = await sweepDeferredRequests(createRequestDeferSweepStore(workerDb));
    expect(second).toEqual({ reopened: 0, reminded: 0 });
    expect(
      await observe(`select id from notifications where type = 'client_request.reopened.v1'`),
    ).toHaveLength(1);
  });

  it('reopens silently when no reminder was asked for', async () => {
    const due = await deferredRequest('2000-01-03', false);
    const result = await sweepDeferredRequests(createRequestDeferSweepStore(workerDb));
    expect(result).toEqual({ reopened: 1, reminded: 0 });
    expect((await scheduleOf(due.id))['state']).toBe('triage');
    expect(
      await observe(`select id from notifications where type = 'client_request.reopened.v1'`),
    ).toHaveLength(0);
  });

  it('runs on grants tmanage_worker already holds in users.sql', () => {
    const worker = intents.get(`'tmanage_worker'@'%'`);
    expect(worker?.privileges.has('tmanage.client_requests:SELECT')).toBe(true);
    expect(worker?.privileges.has('tmanage.client_requests:UPDATE')).toBe(true);
    expect(worker?.privileges.has('tmanage.notifications:INSERT')).toBe(true);
  });
});

describe('0220 — "Reopen now"', () => {
  it('moves a deferred request back to triage and clears the schedule', async () => {
    const deferred = await deferredRequest('2999-01-01', true);
    const studio = await signIn(manager().id);
    const response = await send('POST', `/client-requests/${deferred.id}/reopen`, studio, {
      version: deferred.version,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<RequestView>().state).toBe('triage');

    const row = await scheduleOf(deferred.id);
    expect(row['state']).toBe('triage');
    expect(row['defer_until']).toBeNull();
    expect(Number(row['reopen_reminder'])).toBe(0);
    expect(row['deferred_by_user_id']).toBeNull();
  });

  it('gives the adversarial twin a 404 and leaves the request parked', async () => {
    const deferred = await deferredRequest('2999-01-01', true);
    const twin = await signIn(world.twin.owner.id);
    const response = await send(
      'POST',
      `/client-requests/${deferred.id}/reopen`,
      twin,
      { version: deferred.version },
      TWIN,
    );
    expect(response.statusCode).toBe(404);
    expect((await scheduleOf(deferred.id))['state']).toBe('deferred');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 0221 · Files on a request message
// ─────────────────────────────────────────────────────────────────────────────

describe('0221 — registry: request_message_files in all four places', () => {
  it('is in TABLES and TENANT_TABLES, and users.sql grants the runtime INSERT only', () => {
    expect(Object.keys(TABLES)).toContain('request_message_files');
    expect(TENANT_TABLES['request_message_files']).toBe('organization_id');

    const onTable = (user: string) =>
      [...(intents.get(`'${user}'@'%'`)?.privileges ?? [])].filter((key) =>
        key.startsWith('tmanage.request_message_files:'),
      );
    expect(onTable('tmanage_app')).toEqual(['tmanage.request_message_files:INSERT']);
    expect(onTable('tmanage_worker')).toEqual([]);
  });

  it.skipIf(!usingLeastPrivilegeCredential)(
    'holds no UPDATE or DELETE for the runtime credential to reach for',
    async () => {
      const grants = await observe("show grants for 'tmanage_app'@'%'");
      const line = grants
        .map((row) => String(Object.values(row)[0]))
        .find((text) => text.includes('`request_message_files`'));
      expect(line, 'no grant names request_message_files').toBeDefined();
      expect(line).not.toMatch(/UPDATE|DELETE/i);
    },
  );
});

describe('0221 — attaching files to a message', () => {
  it('records the client’s uploaded file on the message and shows it on both doors', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const request = await fileRequest(client);
    const fileId = await uploadedFile(request.id);

    const posted = await send('POST', `/portal/requests/${request.id}/messages`, client, {
      body: 'The brief is attached.',
      fileIds: [fileId],
    });
    expect(posted.statusCode).toBe(201);
    const message = posted.json<{ id: string; files: { id: string; name: string }[] }>();
    expect(message.files).toEqual([{ id: fileId, name: 'brief.pdf' }]);

    const rows = await attachmentsOf(request.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['organization_id']).toBe(world.northstar.organizationId);
    expect(rows[0]!['message_id']).toBe(message.id);
    expect(rows[0]!['file_asset_id']).toBe(fileId);

    const studio = await signIn(manager().id);
    const team = await send('GET', `/client-requests/${request.id}/messages`, studio);
    expect(team.statusCode).toBe(200);
    const teamMessages = team.json<{ messages: { files: { id: string }[] }[] }>().messages;
    expect(teamMessages[0]!.files.map((f) => f.id)).toEqual([fileId]);
  });

  it('refuses a file uploaded to another request, and writes neither message nor attachment', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const request = await fileRequest(client);
    const other = await fileRequest(client);
    const foreignFile = await uploadedFile(other.id);

    const posted = await send('POST', `/portal/requests/${request.id}/messages`, client, {
      body: 'Wrong file',
      fileIds: [foreignFile],
    });
    // The body is well-formed; the named file is not attachable here — the service's 422.
    expect(posted.statusCode).toBe(422);
    expect(await attachmentsOf(request.id)).toHaveLength(0);
    expect(
      await observe('select id from request_messages where request_id = ?', [request.id]),
    ).toHaveLength(0);
  });
});

describe('0221 — append-only', () => {
  it('refuses any UPDATE, even from the admin credential', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const request = await fileRequest(client);
    const fileId = await uploadedFile(request.id);
    await send('POST', `/portal/requests/${request.id}/messages`, client, {
      body: 'Attached',
      fileIds: [fileId],
    });
    const second = await uploadedFile(request.id);

    await expect(
      db.admin.execute('update request_message_files set file_asset_id = ? where request_id = ?', [
        second,
        request.id,
      ]),
    ).rejects.toThrow(/append-only/i);
    const rows = await attachmentsOf(request.id);
    expect(rows.map((row) => row['file_asset_id'])).toEqual([fileId]);
  });
});

describe('0221 — tenant isolation', () => {
  it('refuses a cross-tenant message or file at the storage layer', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const request = await fileRequest(client);
    const fileId = await uploadedFile(request.id);
    const posted = await send('POST', `/portal/requests/${request.id}/messages`, client, {
      body: 'Northstar thread',
    });
    const messageId = posted.json<{ id: string }>().id;

    const insert = (organizationId: string, fileAssetId: string) =>
      db.admin.execute(
        `insert into request_message_files
           (id, organization_id, message_id, request_id, file_asset_id, attached_by_membership_id)
         values (?, ?, ?, ?, ?, ?)`,
        [
          uuidv7(),
          organizationId,
          messageId,
          request.id,
          fileAssetId,
          world.atlas.reviewer.membershipId,
        ],
      );

    // The twin's organization naming Northstar's message and file: neither pair exists.
    await expect(insert(world.twin.organizationId, fileId)).rejects.toThrow(/foreign key/i);
    // Northstar's message with a file id that is not a Northstar file.
    await expect(insert(world.northstar.organizationId, uuidv7())).rejects.toThrow(/foreign key/i);
    expect(await attachmentsOf(request.id)).toHaveLength(0);
  });

  it('gives the adversarial twin a 404 on Northstar’s thread, attachments included', async () => {
    const client = await signIn(world.atlas.reviewer.id);
    const request = await fileRequest(client);
    const fileId = await uploadedFile(request.id);
    await send('POST', `/portal/requests/${request.id}/messages`, client, {
      body: 'Northstar only',
      fileIds: [fileId],
    });

    const twin = await signIn(world.twin.owner.id);
    const read = await send(
      'GET',
      `/client-requests/${request.id}/messages`,
      twin,
      undefined,
      TWIN,
    );
    expect(read.statusCode).toBe(404);
    expect(read.body).not.toContain(fileId);
    expect(read.body).not.toContain('brief.pdf');
    expect(
      await observe('select id from request_message_files where organization_id = ?', [
        world.twin.organizationId,
      ]),
    ).toHaveLength(0);
  });
});
