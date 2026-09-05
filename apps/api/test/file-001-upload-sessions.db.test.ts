import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { FORBIDDEN_CLIENT_FIELDS, uuidv7 } from '@tmanage/domain';
import { FakeObjectStore, MultipartUploadNotFoundError } from '@tmanage/storage';
import type { CompleteMultipartInput, StoredObject } from '@tmanage/storage';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { StorageModule } from '../src/common/storage/storage.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * FILE-001 over real HTTP — the upload session, both doors, and the quota a caller sees.
 *
 * The fake object store moves no bytes; what it answers is the size the suite configures,
 * which is how "the provider reported a different size" is a case here with no object
 * anywhere. That is the *size* third of 27-TEST-CATALOG INT-12 ("ETags/hash/declared size");
 * the etag and hash thirds are FILE-002's and nothing here claims them. The organization
 * quota is set to ten kilobytes for the suite, so the 100% block (`49-PRICING` §7) is eleven
 * uploads away rather than a gigabyte.
 *
 * What only this suite proves:
 *
 * 1. **A session is a reservation.** Creating one moves the counter; completing it converts
 *    the reservation to used bytes; cancelling it gives them back — and every one of those is
 *    visible to the next caller's quota.
 * 2. **A replay is a replay.** The same person with the same `Idempotency-Key` gets the same
 *    session, the same URLs, and reserves nothing twice; somebody else's key is a 409.
 * 3. **The provider's count wins.** A completion whose bytes do not match the declaration
 *    fails the session, releases the reservation and writes no version.
 * 4. **A client attaches to their own request and nothing else.** A sibling client's request,
 *    a deliverable, a message — 404, 422, 422 — and never the studio's private audience.
 * 5. **Nothing internal leaves.** No response, on either door, carries an object key or the
 *    provider's upload handle, and the client door's responses carry none of the forbidden
 *    fields.
 * 6. **A reservation is somebody's to release.** The opener cancels their own; an owner with
 *    organization-wide scope can list the studio's sessions and cancel a colleague's — and
 *    still cannot read or complete it.
 * 7. **A completion holds its row while it talks to the provider** (migration 0017). A
 *    cancel, a second completion, or a replay of the key that arrives while the provider is
 *    assembling the object is refused with 409 and moves nothing; the completion then lands,
 *    once, and the bytes are counted once.
 */

/**
 * The fake with a hook on `completeMultipart`: the one place a completion yields between
 * claiming its row and settling it, which is where a racing cancel has to be injected.
 * The subclass is the suite's, as the sweeper suite's `onAbort` one is.
 */
class HookedObjectStore extends FakeObjectStore {
  onComplete: ((input: CompleteMultipartInput) => Promise<void>) | null = null;

  override async completeMultipart(input: CompleteMultipartInput): Promise<StoredObject> {
    const hook = this.onComplete;
    this.onComplete = null; // Once: a completion the hook itself sends must not re-enter.
    if (hook) await hook(input);
    return super.completeMultipart(input);
  }
}

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;
let store: HookedObjectStore;

/** What the fake reports at completion when the suite has not said otherwise. */
const DECLARED = 1_000;
const ORG_LIMIT = 10_000;

const CONFIG: ApiConfig = {
  ...apiConfigFrom({
    NODE_ENV: 'test',
    SESSION_COOKIE_NAME: 'tmanage_session',
    SESSION_SECRET: 'local_dev_only_session_secret_for_the_files_suite_xxxxx',
    SESSION_TTL_SECONDS: 900,
    REFRESH_TTL_SECONDS: 1_209_600,
    CSRF_SECRET: 'local_dev_only_csrf_secret_for_the_files_suite_xxxxxxxx',
    API_PUBLIC_URL: 'http://localhost:4000',
    AUTH_MAX_FAILURES_IN_WINDOW: 50,
    AUTH_FAILURE_WINDOW_SECONDS: 900,
    AUTH_TOTP_ISSUER: 'TManage',
    CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
  }),
  storageOrgBytesLimit: ORG_LIMIT,
  uploadMaxBytes: 5_000,
  uploadUrlTtlSeconds: 900,
  // The open-upload cap, low enough to reach under the quota above at 100 bytes a session.
  uploadMaxOpenSessionsPerUser: 12,
};

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
  return {
    cookie: cookieHeader(setCookies(response)),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
  };
}

async function sendTo(
  slug: string,
  method: 'GET' | 'POST',
  path: string,
  session: Session,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url: `/v1/organizations/${slug}${path}`,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
      ...headers,
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

const send = (
  method: 'GET' | 'POST',
  path: string,
  session: Session,
  payload?: unknown,
  headers: Record<string, string> = {},
) => sendTo('northstar-studio', method, path, session, payload, headers);

interface UploadSession {
  id: string;
  fileAssetId: string;
  projectId: string;
  purpose: string;
  status: string;
  fileName: string;
  sizeBytes: number;
  partCount: number;
  reservedBytes: number;
  uploadUrls: { partNumber: number; url: string }[];
  expiresAt: string;
}

interface FileAsset {
  id: string;
  name: string;
  status: string;
  sizeBytes: number;
  fileVersionId: string;
  versionNo: number;
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: { field: string; message?: string }[];
  };
}

let keyCounter = 0;
const freshKey = (): string => `upload-key-${String(++keyCounter).padStart(12, '0')}`;

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: world.northstar.projectId,
    fileName: 'brief.pdf',
    mimeType: 'application/pdf',
    sizeBytes: DECLARED,
    purpose: 'deliverable',
    ...overrides,
  };
}

/** Open a session as the studio, the ordinary case every other test starts from. */
async function open(
  session: Session,
  overrides: Record<string, unknown> = {},
  key = freshKey(),
): Promise<UploadSession> {
  const response = await send('POST', '/upload-sessions', session, body(overrides), {
    'idempotency-key': key,
  });
  if (response.statusCode !== 201) {
    throw new Error(`open failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<UploadSession>();
}

function partsFor(session: UploadSession): { parts: { partNumber: number; etag: string }[] } {
  return {
    parts: Array.from({ length: session.partCount }, (_, i) => ({
      partNumber: i + 1,
      etag: `etag-${i + 1}`,
    })),
  };
}

async function counter(organizationId: string): Promise<{ used: number; reserved: number }> {
  const [row] = await observe(
    'select used_value as used, reserved_value as reserved from usage_counters where organization_id = ?',
    [organizationId],
  );
  return { used: Number(row?.['used'] ?? 0), reserved: Number(row?.['reserved'] ?? 0) };
}

async function outboxTypes(aggregateId: string): Promise<string[]> {
  const rows = await observe(
    'select type from outbox_events where aggregate_id = ? order by occurred_at, id',
    [aggregateId],
  );
  return rows.map((r) => String(r['type']));
}

async function auditActions(): Promise<string[]> {
  const rows = await observe('select action from audit_events order by created_at, id');
  return rows.map((r) => String(r['action']));
}

/** Submit a request as an Atlas client, so a client upload has something to attach to. */
async function submitRequest(session: Session, projectId = world.northstar.projectId) {
  const response = await send('POST', '/portal/requests', session, {
    projectId,
    title: 'Add a careers page',
    description: 'We need a careers page before the recruitment round opens.',
  });
  if (response.statusCode !== 201) {
    throw new Error(`submit failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<{ id: string; version: number }>();
}

const owner = () => world.northstar.owner;
const manager = () => world.northstar.manager;
const designer = () => world.northstar.designer;

beforeAll(async () => {
  db = await startTestDatabase();
  store = new HookedObjectStore(() => DECLARED);
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
      storage: StorageModule.forObjectStore(store),
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
  store.began.length = 0;
  store.completed.length = 0;
  store.aborted.length = 0;
  store.sizeFor.clear();
  store.onComplete = null;
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// Creating a session is reserving bytes
// ─────────────────────────────────────────────────────────────────────────────

describe('creating a session', () => {
  it('reserves the declared bytes, opens one provider upload and answers one target per part', async () => {
    const studio = await signIn(manager().id);
    const session = await open(studio, { sizeBytes: 4_500 });

    expect(session.status).toBe('reserved');
    expect(session.reservedBytes).toBe(4_500);
    expect(session.partCount).toBe(1);
    expect(session.uploadUrls).toHaveLength(1);
    expect(session.uploadUrls[0]?.url.startsWith('memory://')).toBe(true);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 4_500 });
    expect(store.began).toHaveLength(1);
    expect(store.began[0]?.zone).toBe('quarantine');
    expect(store.began[0]?.objectKey.startsWith(`tenant/${world.northstar.organizationId}/`)).toBe(
      true,
    );
    expect(await outboxTypes(session.id)).toEqual(['usage.storage_reserved.v1']);

    const [asset] = await observe(
      'select status, owner_user_id as o from file_assets where id = ?',
      [session.fileAssetId],
    );
    expect(asset?.['status']).toBe('created');
    expect(asset?.['o']).toBe(manager().id);
  });

  it('never puts the object key, or any forbidden field, in a response', async () => {
    const studio = await signIn(manager().id);
    const response = await send('POST', '/upload-sessions', studio, body(), {
      'idempotency-key': freshKey(),
    });
    expect(response.statusCode).toBe(201);
    const objectKey = store.began[0]?.objectKey ?? 'unset';
    expect(response.body).not.toContain(objectKey);
    expect(response.body).not.toContain('tenant/');
    for (const field of FORBIDDEN_CLIENT_FIELDS) expect(response.body).not.toContain(`"${field}"`);
  });

  it('answers the same session, byte for byte, to a replay of the same key by the same person', async () => {
    const studio = await signIn(manager().id);
    const key = freshKey();
    const first = await send('POST', '/upload-sessions', studio, body(), {
      'idempotency-key': key,
    });
    const again = await send('POST', '/upload-sessions', studio, body(), {
      'idempotency-key': key,
    });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.body).toBe(first.body);
    // One reservation, one provider upload. Reversal: drop the key read before the insert
    // and the unique index still holds the counter at 1_000 — but the provider is asked
    // twice; drop both and this reserves 2_000.
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: DECLARED });
    expect(store.began).toHaveLength(1);
  });

  it('refuses another person’s idempotency key with 409 rather than handing over their session', async () => {
    const key = freshKey();
    await open(await signIn(manager().id), {}, key);
    const response = await send('POST', '/upload-sessions', await signIn(owner().id), body(), {
      'idempotency-key': key,
    });
    expect(response.statusCode).toBe(409);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: DECLARED });
  });

  it('refuses a replay whose session has since been cancelled, or that names another project, with 409', async () => {
    // A replay is the same upload or it is a conflict. Reversal: let `replay` check only the
    // opener and the first case is a 201 carrying `reservedBytes: 0` and the URLs of an
    // aborted upload; the second hands back project A's session to a request about project B.
    const studio = await signIn(owner().id);
    const cancelledKey = freshKey();
    const session = await open(studio, {}, cancelledKey);
    await send('POST', `/upload-sessions/${session.id}/cancel`, studio);
    const afterCancel = await send('POST', '/upload-sessions', studio, body(), {
      'idempotency-key': cancelledKey,
    });
    expect(afterCancel.statusCode).toBe(409);
    expect(afterCancel.json<ErrorBody>().error.details?.map((d) => d.field)).toEqual([
      'Idempotency-Key',
    ]);

    const liveKey = freshKey();
    await open(studio, {}, liveKey);
    const otherProject = await send(
      'POST',
      '/upload-sessions',
      studio,
      body({ projectId: world.northstar.otherProjectId }),
      { 'idempotency-key': liveKey },
    );
    expect(otherProject.statusCode).toBe(409);
    // The cancelled session gave its bytes back; the live one still holds its own; nothing new.
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: DECLARED });
    expect(store.began).toHaveLength(2);
  });

  it('requires objectId for a request attachment from the studio too', async () => {
    // Reversal: let an internal principal omit it and this is a 201 for a file no request
    // will ever list.
    const response = await send(
      'POST',
      '/upload-sessions',
      await signIn(manager().id),
      body({ purpose: 'request_attachment' }),
      { 'idempotency-key': freshKey() },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.details?.map((d) => d.field)).toEqual(['objectId']);
    expect(store.began).toHaveLength(0);
  });

  it('requires the Idempotency-Key header and names it as the field', async () => {
    const response = await send('POST', '/upload-sessions', await signIn(manager().id), body());
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.details?.map((d) => d.field)).toEqual([
      'Idempotency-Key',
    ]);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
  });

  it('refuses a single upload above UPLOAD_MAX_BYTES before touching the quota', async () => {
    const response = await send(
      'POST',
      '/upload-sessions',
      await signIn(manager().id),
      body({ sizeBytes: 5_001 }),
      { 'idempotency-key': freshKey() },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.details?.map((d) => d.field)).toEqual(['sizeBytes']);
    expect(store.began).toHaveLength(0);
  });

  it('refuses a document upload for everyone, because nobody has built documents', async () => {
    const response = await send(
      'POST',
      '/upload-sessions',
      await signIn(manager().id),
      body({ purpose: 'document' }),
      { 'idempotency-key': freshKey() },
    );
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details?.map((d) => d.field)).toEqual(['purpose']);
  });

  it('answers 404 for a project the member is not on, and for one that does not exist', async () => {
    const member = await signIn(designer().id);
    const unshared = await send(
      'POST',
      '/upload-sessions',
      member,
      body({ projectId: world.northstar.otherProjectId }),
      { 'idempotency-key': freshKey() },
    );
    const absent = await send('POST', '/upload-sessions', member, body({ projectId: uuidv7() }), {
      'idempotency-key': freshKey(),
    });
    expect(unshared.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The quota
// ─────────────────────────────────────────────────────────────────────────────

describe('the organization quota (49 §6, §7)', () => {
  it('blocks the reservation that would cross 100%, records the refusal, and abandons the provider upload', async () => {
    const studio = await signIn(manager().id);
    for (let i = 0; i < 10; i += 1) await open(studio);
    expect(await counter(world.northstar.organizationId)).toEqual({
      used: 0,
      reserved: ORG_LIMIT,
    });

    const refused = await send('POST', '/upload-sessions', studio, body(), {
      'idempotency-key': freshKey(),
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<ErrorBody>().error.details?.map((d) => d.field)).toEqual(['sizeBytes']);
    // Reversal: delete the predicate from `reserve` and this is a 201 with reserved 11_000.
    expect(await counter(world.northstar.organizationId)).toEqual({
      used: 0,
      reserved: ORG_LIMIT,
    });
    expect(await auditActions()).toEqual(['upload_session.refused']);
    const [row] = await observe(
      "select result, object_id as o, metadata_json as m from audit_events where action = 'upload_session.refused'",
    );
    expect(row?.['result']).toBe('denied');
    expect(row?.['o']).toBeNull();
    expect(JSON.stringify(row?.['m'])).toContain('storage_quota_exhausted');
    expect(store.began).toHaveLength(11);
    expect(store.aborted).toHaveLength(1);
    expect(await observe('select id from upload_sessions')).toHaveLength(10);
  });

  it('counts a claim against the cap: a completion in flight still holds its slot', async () => {
    const studio = await signIn(manager().id);
    const cap = CONFIG.uploadMaxOpenSessionsPerUser;
    // The first at the declared size the fake reports, the rest small: twelve of a
    // thousand would cross the ten-kilobyte quota before the cap is reached.
    const first = await open(studio);
    for (let i = 1; i < cap; i += 1) await open(studio, { sizeBytes: 100 });
    let inFlight = 0;
    // Reversal: count only `reserved` in `countOpenFor` and the open below is 201 — a
    // person at the cap holds the cap-th plus every completion they can keep in flight.
    store.onComplete = async () => {
      const opened = await send('POST', '/upload-sessions', studio, body({ sizeBytes: 100 }), {
        'idempotency-key': freshKey(),
      });
      inFlight = opened.statusCode;
    };
    const done = await send(
      'POST',
      `/upload-sessions/${first.id}/complete`,
      studio,
      partsFor(first),
    );
    expect(done.statusCode, done.body).toBe(202);
    expect(inFlight).toBe(429);
    // Completed, the slot is free.
    const after = await send('POST', '/upload-sessions', studio, body({ sizeBytes: 100 }), {
      'idempotency-key': freshKey(),
    });
    expect(after.statusCode).toBe(201);
  });

  it('caps the reservations one person holds open: the thirteenth is 429, a colleague is not, and a cancel makes room', async () => {
    const studio = await signIn(manager().id);
    const small = { sizeBytes: 100 };
    const held: UploadSession[] = [];
    for (let i = 0; i < CONFIG.uploadMaxOpenSessionsPerUser; i += 1) {
      held.push(await open(studio, small));
    }
    expect(store.began).toHaveLength(12);

    const refused = await send('POST', '/upload-sessions', studio, body(small), {
      'idempotency-key': freshKey(),
    });
    expect(refused.statusCode, refused.body).toBe(429);
    expect(refused.json<ErrorBody>().error.code).toBe('rate_limited');
    // Reversal: drop the count before `beginMultipart` and `began` reads 13 here — the
    // provider was asked and then told to abandon; drop the count inside the reservation
    // as well and this is a 201 with thirteen rows.
    expect(store.began).toHaveLength(12);
    expect(store.aborted).toHaveLength(0);
    expect(await auditActions()).toEqual(['upload_session.refused']);
    const [row] = await observe(
      "select metadata_json as m from audit_events where action = 'upload_session.refused'",
    );
    expect(JSON.stringify(row?.['m'])).toContain('too_many_open_uploads');
    expect(JSON.stringify(row?.['m'])).toContain('"limit_sessions":12');
    expect(await observe('select id from upload_sessions')).toHaveLength(12);

    // The cap is the person's, not the organization's.
    const colleague = await signIn(owner().id);
    const theirs = await send('POST', '/upload-sessions', colleague, body(small), {
      'idempotency-key': freshKey(),
    });
    expect(theirs.statusCode, theirs.body).toBe(201);

    // A cancel makes room: the count is of `reserved` rows, and a cancelled one is not.
    const first = held[0] as UploadSession;
    expect((await send('POST', `/upload-sessions/${first.id}/cancel`, studio)).statusCode).toBe(
      200,
    );
    const again = await send('POST', '/upload-sessions', studio, body(small), {
      'idempotency-key': freshKey(),
    });
    expect(again.statusCode, again.body).toBe(201);
  });

  it('still answers 422 and records the refusal when the provider refuses to abandon the upload', async () => {
    // The error path aborts the provider upload it opened before the reservation. Reversal:
    // take the try/catch off that abort and a provider that is down turns the only audited
    // denial in the slice into a 500 with no audit row.
    const studio = await signIn(manager().id);
    for (let i = 0; i < 10; i += 1) await open(studio);
    store.failNextAbort = new Error('the provider is down');

    const refused = await send('POST', '/upload-sessions', studio, body(), {
      'idempotency-key': freshKey(),
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json<ErrorBody>().error.details?.map((d) => d.field)).toEqual(['sizeBytes']);
    // The abort that failed is a row of its own, naming the handle the provider still
    // holds. Reversal: swallow the abort silently again and only the refusal is here.
    expect(await auditActions()).toEqual(['upload_session.abort_failed', 'upload_session.refused']);
    const [abortRow] = await observe(
      "select result, metadata_json as m from audit_events where action = 'upload_session.abort_failed'",
    );
    expect(abortRow?.['result']).toBe('error');
    // The fake numbers its handles across the whole run, so the shape and not the number.
    expect(JSON.stringify(abortRow?.['m'])).toMatch(/"provider_upload_id":"fake-upload-\d+"/);
    expect(JSON.stringify(abortRow?.['m'])).toContain('"refusal":"QuotaExhausted"');
    expect(store.failNextAbort).toBeNull();
    expect(store.aborted).toHaveLength(0);
    expect(await counter(world.northstar.organizationId)).toEqual({
      used: 0,
      reserved: ORG_LIMIT,
    });
  });

  it('counts a client’s upload against the studio’s quota, not a quota of the client’s own', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const request = await submitRequest(atlas);
    const response = await send(
      'POST',
      '/portal/upload-sessions',
      atlas,
      body({
        purpose: 'request_attachment',
        objectId: request.id,
        fileName: 'logo.png',
        mimeType: 'image/png',
      }),
      { 'idempotency-key': freshKey() },
    );
    expect(response.statusCode).toBe(201);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: DECLARED });
    // No counter row keyed on the client organization exists, or on the twin.
    expect(await observe('select id from usage_counters')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Completing
// ─────────────────────────────────────────────────────────────────────────────

describe('completing a session', () => {
  it('converts the reservation to used bytes, writes version 1, and tells the outbox and the audit log', async () => {
    const studio = await signIn(manager().id);
    const session = await open(studio);
    const response = await send(
      'POST',
      `/upload-sessions/${session.id}/complete`,
      studio,
      partsFor(session),
    );
    expect(response.statusCode, response.body).toBe(202);
    const asset = response.json<FileAsset>();
    expect(asset).toMatchObject({
      id: session.fileAssetId,
      name: 'brief.pdf',
      status: 'uploaded',
      sizeBytes: DECLARED,
      versionNo: 1,
    });
    expect(asset.fileVersionId).toMatch(/^[0-9a-f-]{36}$/);

    expect(await counter(world.northstar.organizationId)).toEqual({ used: DECLARED, reserved: 0 });
    const versions = await observe(
      'select object_key as k, size_bytes as s from file_versions where file_asset_id = ?',
      [session.fileAssetId],
    );
    expect(versions).toHaveLength(1);
    expect(Number(versions[0]?.['s'])).toBe(DECLARED);
    expect(String(versions[0]?.['k'])).toBe(store.began[0]?.objectKey);
    expect(response.body).not.toContain(String(versions[0]?.['k']));

    expect(await outboxTypes(session.id)).toEqual([
      'usage.storage_reserved.v1',
      'upload.completed.v1',
      'usage.storage_committed.v1',
    ]);
    expect(await auditActions()).toEqual(['file_asset.uploaded']);
    const [sessionRow] = await observe(
      'select status, committed_bytes as c from upload_sessions where id = ?',
      [session.id],
    );
    expect(sessionRow?.['status']).toBe('completed');
    expect(Number(sessionRow?.['c'])).toBe(DECLARED);
  });

  it('completes once: a second completion answers the same file and moves nothing', async () => {
    const studio = await signIn(manager().id);
    const session = await open(studio);
    const first = await send(
      'POST',
      `/upload-sessions/${session.id}/complete`,
      studio,
      partsFor(session),
    );
    const again = await send(
      'POST',
      `/upload-sessions/${session.id}/complete`,
      studio,
      partsFor(session),
    );
    expect(first.statusCode).toBe(202);
    expect(again.statusCode).toBe(202);
    expect(again.json<FileAsset>().fileVersionId).toBe(first.json<FileAsset>().fileVersionId);
    // Reversal: drop the `where status in ('reserved')` guard and used doubles to 2_000.
    expect(await counter(world.northstar.organizationId)).toEqual({ used: DECLARED, reserved: 0 });
    expect(await observe('select id from file_versions')).toHaveLength(1);
    expect(store.completed).toHaveLength(1);
  });

  it('refuses a completion that does not name every part exactly once', async () => {
    const studio = await signIn(manager().id);
    const session = await open(studio);
    const response = await send('POST', `/upload-sessions/${session.id}/complete`, studio, {
      parts: [{ partNumber: 2, etag: 'x' }],
    });
    expect(response.statusCode).toBe(422);
    expect(store.completed).toHaveLength(0);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: DECLARED });
  });

  it('fails the session when the provider reports a different size, and gives the bytes back (INT-12, the size third only)', async () => {
    // Only the size is compared here. The etags a caller sends are forwarded to the provider
    // and compared to nothing at completion, and `declared_content_hash` is compared to the
    // bytes only by FILE-002's verification pass (`file-002-verification.db.test.ts`); this
    // title claims neither.
    const studio = await signIn(manager().id);
    const session = await open(studio);
    store.sizeFor.set(store.began[0]?.objectKey ?? '', DECLARED + 1);

    const response = await send(
      'POST',
      `/upload-sessions/${session.id}/complete`,
      studio,
      partsFor(session),
    );
    expect(response.statusCode).toBe(422);
    // Reversal: trust `declared_bytes` at completion and this is a 202 with a version row.
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
    expect(await observe('select id from file_versions')).toHaveLength(0);
    const [row] = await observe('select status from upload_sessions where id = ?', [session.id]);
    expect(row?.['status']).toBe('failed');
    const [asset] = await observe('select status from file_assets where id = ?', [
      session.fileAssetId,
    ]);
    expect(asset?.['status']).toBe('cancelled');
    expect(store.aborted).toHaveLength(1);
    expect(await outboxTypes(session.id)).toEqual([
      'usage.storage_reserved.v1',
      'usage.storage_released.v1',
    ]);
  });

  it('still answers 422 and releases the session when the provider has lost the upload and refuses to abort it', async () => {
    // The completion catch releases on `MultipartUploadNotFoundError`, and the release
    // aborts first. Reversal: make that abort required, as cancel's is, and a provider that
    // throws on abort turns the 422 into a 500 with the bytes held.
    const studio = await signIn(manager().id);
    const session = await open(studio);
    store.failNext = new MultipartUploadNotFoundError();
    store.failNextAbort = new Error('the provider is down');

    const response = await send(
      'POST',
      `/upload-sessions/${session.id}/complete`,
      studio,
      partsFor(session),
    );
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json<ErrorBody>().error.details?.map((d) => d.field)).toEqual(['parts']);
    expect(store.failNext).toBeNull();
    expect(store.failNextAbort).toBeNull();
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
    const [row] = await observe('select status from upload_sessions where id = ?', [session.id]);
    expect(row?.['status']).toBe('failed');
    // The refused abort is recorded, as the create path records its own: the provider
    // holds an upload the session no longer describes, and the row names the handle.
    // Reversal: drop `recordSessionAbortFailure` from `releaseAs` and the log is empty.
    expect(await auditActions()).toEqual(['upload_session.abort_failed']);
    const [abortRow] = await observe(
      "select result as r, object_id as o, metadata_json as m from audit_events where action = 'upload_session.abort_failed'",
    );
    expect(abortRow?.['r']).toBe('error');
    expect(abortRow?.['o']).toBe(session.id);
    expect(JSON.stringify(abortRow?.['m'])).toMatch(/"provider_upload_id":"fake-upload-\d+"/);
    expect(JSON.stringify(abortRow?.['m'])).toContain('"refusal":"MultipartUploadNotFoundError"');
    expect(JSON.stringify(abortRow?.['m'])).toContain('"cause":"failed"');
  });

  it('refuses an expired session and releases it', async () => {
    const studio = await signIn(manager().id);
    const session = await open(studio);
    await db.admin.query('update upload_sessions set expires_at = ? where id = ?', [
      new Date(Date.now() - 1_000),
      session.id,
    ]);
    const response = await send(
      'POST',
      `/upload-sessions/${session.id}/complete`,
      studio,
      partsFor(session),
    );
    expect(response.statusCode).toBe(422);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
    const [row] = await observe('select status from upload_sessions where id = ?', [session.id]);
    expect(row?.['status']).toBe('expired');
  });

  it('holds the row while the provider assembles: a cancel, a second completion and a replay of the key in that window are 409, and the completion lands once', async () => {
    const studio = await signIn(manager().id);
    const key = freshKey();
    const session = await open(studio, {}, key);
    const seen: Record<string, unknown> = {};

    // The provider is mid-`completeMultipart` when the same person cancels, completes
    // again, and re-sends the key. Reversal: drop the claim (`reserved → completing`
    // before the provider call) and the cancel answers 200, releases the bytes and aborts
    // the upload under the completion; the completion then finds its row `cancelled`.
    store.onComplete = async () => {
      const [cancel, again, replay, read] = await Promise.all([
        send('POST', `/upload-sessions/${session.id}/cancel`, studio),
        send('POST', `/upload-sessions/${session.id}/complete`, studio, partsFor(session)),
        send('POST', '/upload-sessions', studio, body(), { 'idempotency-key': key }),
        send('GET', `/upload-sessions/${session.id}`, studio),
      ]);
      seen['cancel'] = [cancel.statusCode, cancel.json<ErrorBody>().error.code];
      seen['again'] = [again.statusCode, again.json<ErrorBody>().error.code];
      seen['replay'] = [
        replay.statusCode,
        replay.json<ErrorBody>().error.details?.[0]?.message ?? '',
      ];
      const view = read.json<UploadSession>();
      seen['read'] = [view.status, view.reservedBytes, view.uploadUrls.length];
    };

    const response = await send(
      'POST',
      `/upload-sessions/${session.id}/complete`,
      studio,
      partsFor(session),
    );
    expect(response.statusCode, response.body).toBe(202);
    expect(seen['cancel']).toEqual([409, 'conflict']);
    expect(seen['again']).toEqual([409, 'conflict']);
    expect(seen['replay']).toEqual([
      409,
      'was used by a session whose completion is in flight; wait for it',
    ]);
    // While claimed: the bytes are still reserved and the part targets are withdrawn.
    expect(seen['read']).toEqual(['completing', DECLARED, 0]);

    expect(await counter(world.northstar.organizationId)).toEqual({ used: DECLARED, reserved: 0 });
    expect(store.completed).toHaveLength(1);
    expect(store.aborted).toHaveLength(0);
    expect(store.began).toHaveLength(1);
    expect(await observe('select id from file_versions')).toHaveLength(1);
    const [row] = await observe('select status, version as v from upload_sessions where id = ?', [
      session.id,
    ]);
    expect(row?.['status']).toBe('completed');
    // reserved(1) → completing(2) → completed(3): the claim is a move of its own.
    expect(Number(row?.['v'])).toBe(3);
    // As a set: the two commit-transaction events share `occurred_at` to the millisecond
    // and the chain has seen them read back in the other order under load.
    expect([...(await outboxTypes(session.id))].sort()).toEqual(
      ['usage.storage_reserved.v1', 'upload.completed.v1', 'usage.storage_committed.v1'].sort(),
    );
  });

  it('gives the claim back when the provider is down, so the same session completes on the retry', async () => {
    const studio = await signIn(manager().id);
    const session = await open(studio);
    store.failNext = new Error('the provider is down');
    const down = await send(
      'POST',
      `/upload-sessions/${session.id}/complete`,
      studio,
      partsFor(session),
    );
    expect(down.statusCode).toBe(500);
    // Reversal: drop the `finally` un-claim and the row stays `completing`: the retry below
    // is 409 for ever, the bytes are held, and only the sweeper's reclaim frees it.
    const [row] = await observe('select status from upload_sessions where id = ?', [session.id]);
    expect(row?.['status']).toBe('reserved');
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: DECLARED });

    const retry = await send(
      'POST',
      `/upload-sessions/${session.id}/complete`,
      studio,
      partsFor(session),
    );
    expect(retry.statusCode, retry.body).toBe(202);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: DECLARED, reserved: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cancelling
// ─────────────────────────────────────────────────────────────────────────────

describe('cancelling a session', () => {
  it('releases the reservation, abandons the provider upload, and is idempotent', async () => {
    const studio = await signIn(manager().id);
    const session = await open(studio);
    const first = await send('POST', `/upload-sessions/${session.id}/cancel`, studio);
    const again = await send('POST', `/upload-sessions/${session.id}/cancel`, studio);
    expect(first.statusCode).toBe(200);
    expect(first.json<UploadSession>().status).toBe('cancelled');
    expect(first.json<UploadSession>().reservedBytes).toBe(0);
    // The part URLs leave with the reservation. Against a token-authorized transport a URL
    // that outlives its session is a door with no lock; reversal: serve `uploadTargetsJson`
    // for every status and the cancelled session still hands them out.
    expect(first.json<UploadSession>().uploadUrls).toEqual([]);
    const read = await send('GET', `/upload-sessions/${session.id}`, studio);
    expect(read.json<UploadSession>().uploadUrls).toEqual([]);
    expect(again.statusCode).toBe(200);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
    expect(store.aborted).toHaveLength(1);
    expect(await outboxTypes(session.id)).toEqual([
      'usage.storage_reserved.v1',
      'usage.storage_released.v1',
    ]);
  });

  it('cannot be completed after cancellation, and cannot be cancelled after completion', async () => {
    const studio = await signIn(manager().id);
    const cancelled = await open(studio);
    await send('POST', `/upload-sessions/${cancelled.id}/cancel`, studio);
    const complete = await send(
      'POST',
      `/upload-sessions/${cancelled.id}/complete`,
      studio,
      partsFor(cancelled),
    );
    expect(complete.statusCode).toBe(422);

    const completed = await open(studio);
    await send('POST', `/upload-sessions/${completed.id}/complete`, studio, partsFor(completed));
    const cancel = await send('POST', `/upload-sessions/${completed.id}/cancel`, studio);
    expect(cancel.statusCode).toBe(422);
    // Reversal: let cancel release regardless of status and used drops below zero — or,
    // with the UNSIGNED column, the statement fails as a 500.
    expect(await counter(world.northstar.organizationId)).toEqual({ used: DECLARED, reserved: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Who may touch a session
// ─────────────────────────────────────────────────────────────────────────────

describe('the boundary', () => {
  it('answers 404 to another person, another tenant and a fabricated id, byte-identically', async () => {
    const session = await open(await signIn(manager().id));
    const normalize = (response: InjectedResponse) =>
      response.body.replace(response.json<ErrorBody>().error.correlationId, 'CID');

    const colleague = await send('GET', `/upload-sessions/${session.id}`, await signIn(owner().id));
    const stranger = await sendTo(
      'brightops',
      'GET',
      `/upload-sessions/${session.id}`,
      await signIn(world.brightops.owner.id),
    );
    const nobody = await send('GET', `/upload-sessions/${uuidv7()}`, await signIn(manager().id));
    for (const response of [colleague, stranger, nobody]) expect(response.statusCode).toBe(404);
    expect(normalize(colleague)).toBe(normalize(nobody));
  });

  it('lists only the caller’s own sessions, newest first', async () => {
    const studio = await signIn(manager().id);
    const a = await open(studio);
    const b = await open(studio);
    await open(await signIn(owner().id));
    const response = await send('GET', '/upload-sessions', studio);
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ uploadSessions: UploadSession[] }>().uploadSessions.map((s) => s.id),
    ).toEqual([b.id, a.id]);
  });

  it('lets an owner with organization-wide scope see the studio’s sessions and cancel a colleague’s, and nobody else', async () => {
    // Five abandoned 100 MB sessions by one person hold a 500 MB studio for good if only the
    // opener can release them. Reversal: gate `cancel` on the opener alone and the owner's
    // cancel is a 404 with the bytes still held.
    const studio = await signIn(manager().id);
    const boss = await signIn(owner().id);
    const colleague = await signIn(designer().id);
    const theirs = await open(studio);
    const atlas = await signIn(world.atlas.reviewer.id);
    const request = await submitRequest(atlas);
    const clients = (
      await send(
        'POST',
        '/portal/upload-sessions',
        atlas,
        body({
          purpose: 'request_attachment',
          objectId: request.id,
          fileName: 'logo.png',
          mimeType: 'image/png',
        }),
        { 'idempotency-key': freshKey() },
      )
    ).json<UploadSession>();

    // The wide list: the owner sees both; the manager may not ask for it.
    const wide = await send('GET', '/upload-sessions?scope=organization', boss);
    expect(wide.statusCode, wide.body).toBe(200);
    const listed = wide.json<{ uploadSessions: UploadSession[] }>().uploadSessions;
    expect(listed.map((s) => s.id)).toEqual([clients.id, theirs.id]);
    // The wide list names the sessions and never their targets: since FILE-001b a target is
    // a bearer credential for a write, and the owner opened neither of these. The opener
    // still sees their own. Reversal: serve `uploadUrls` for every reserved row.
    expect(listed.map((s) => s.uploadUrls)).toEqual([[], []]);
    expect(
      (await send('GET', `/upload-sessions/${theirs.id}`, studio)).json<UploadSession>().uploadUrls,
    ).toHaveLength(1);
    expect((await send('GET', '/upload-sessions?scope=organization', studio)).statusCode).toBe(403);
    expect((await send('GET', '/upload-sessions?scope=elsewhere', boss)).statusCode).toBe(400);

    // Read and complete stay the opener's, wide scope or not.
    expect((await send('GET', `/upload-sessions/${theirs.id}`, boss)).statusCode).toBe(404);
    expect(
      (await send('POST', `/upload-sessions/${theirs.id}/complete`, boss, partsFor(theirs)))
        .statusCode,
    ).toBe(404);
    // A colleague without organization-wide scope cannot release it either.
    expect((await send('POST', `/upload-sessions/${theirs.id}/cancel`, colleague)).statusCode).toBe(
      404,
    );
    expect(await counter(world.northstar.organizationId)).toEqual({
      used: 0,
      reserved: 2 * DECLARED,
    });

    const released = await send('POST', `/upload-sessions/${theirs.id}/cancel`, boss);
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json<UploadSession>().status).toBe('cancelled');
    const clientReleased = await send('POST', `/upload-sessions/${clients.id}/cancel`, boss);
    expect(clientReleased.statusCode, clientReleased.body).toBe(200);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
    expect(store.aborted).toHaveLength(2);
    // The opener sees what happened to their session.
    expect(
      (await send('GET', `/upload-sessions/${theirs.id}`, studio)).json<UploadSession>().status,
    ).toBe('cancelled');
  });

  it('answers 404 to a part PUT with no sink bound, even when the body is JSON', async () => {
    // This application holds the fake and binds no `LOCAL_PART_SINK`. The route checks the
    // sink and the part number before the body's type, so a deployment with no sink says
    // 404 to everything rather than 400 to a JSON body. Reversal: check the body first.
    const response = (await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${'a'.repeat(32)}/parts/1?t=pu1.1.x`,
      headers: { 'content-type': 'application/json' },
      payload: { bytes: 'aaaa' },
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('not_found');
  });

  it('refuses a client on the studio’s door and the studio on the client’s, with 403', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const studio = await signIn(manager().id);
    const clientInside = await send('POST', '/upload-sessions', atlas, body(), {
      'idempotency-key': freshKey(),
    });
    const studioOutside = await send('POST', '/portal/upload-sessions', studio, body(), {
      'idempotency-key': freshKey(),
    });
    expect(clientInside.statusCode).toBe(403);
    expect(studioOutside.statusCode).toBe(403);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The client's door
// ─────────────────────────────────────────────────────────────────────────────

describe('a client attaching a file to their request', () => {
  const clientBody = (requestId: string, overrides: Record<string, unknown> = {}) =>
    body({
      purpose: 'request_attachment',
      objectId: requestId,
      fileName: 'logo.png',
      mimeType: 'image/png',
      ...overrides,
    });

  it('opens, completes and lists a session on their own request', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const request = await submitRequest(atlas);
    const created = await send('POST', '/portal/upload-sessions', atlas, clientBody(request.id), {
      'idempotency-key': freshKey(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const session = created.json<UploadSession>();
    for (const field of FORBIDDEN_CLIENT_FIELDS) expect(created.body).not.toContain(`"${field}"`);
    // The literal check the internal door already had, on the door that matters. (The
    // provider's handle is inside each part URL by design, as an S3 upload id would be; what
    // must not appear is the handle as a *field*, which `FORBIDDEN_CLIENT_FIELDS` now names.)
    expect(created.body).not.toContain(store.began[0]?.objectKey ?? 'unset');
    expect(created.body).not.toContain('tenant/');
    expect(created.body).not.toContain('"providerUploadId"');

    const [asset] = await observe(
      'select audience, client_organization_id as c, object_id as o from file_assets where id = ?',
      [session.fileAssetId],
    );
    expect(asset?.['audience']).toBe('client_visible');
    expect(asset?.['c']).toBe(world.atlas.clientOrganizationId);
    // The request the file belongs to is on the row, and on the session — 0016. Reversal:
    // drop `objectId` from the two create inputs and both read NULL, with nothing for a
    // "files on this request" panel to join on.
    expect(asset?.['o']).toBe(request.id);
    const [sessionRow] = await observe('select object_id as o from upload_sessions where id = ?', [
      session.id,
    ]);
    expect(sessionRow?.['o']).toBe(request.id);

    const completed = await send(
      'POST',
      `/portal/upload-sessions/${session.id}/complete`,
      atlas,
      partsFor(session),
    );
    expect(completed.statusCode, completed.body).toBe(202);
    expect(completed.json<FileAsset>().status).toBe('uploaded');
    const [event] = await observe(
      "select payload_json as p from outbox_events where aggregate_id = ? and type = 'upload.completed.v1'",
      [session.id],
    );
    expect((event?.['p'] as { objectId?: string }).objectId).toBe(request.id);

    const listed = await send('GET', '/portal/upload-sessions', atlas);
    expect(
      listed.json<{ uploadSessions: UploadSession[] }>().uploadSessions.map((s) => s.id),
    ).toEqual([session.id]);
  });

  it('cannot attach to a request that has been withdrawn', async () => {
    // A closed request is not a place to keep adding files, each reserving against the
    // studio's quota. Reversal: drop the terminal-state check from `requireObject` and this
    // is a 201 with 1_000 bytes reserved against a request nobody will act on.
    const atlas = await signIn(world.atlas.reviewer.id);
    const request = await submitRequest(atlas);
    const withdrawn = await send('POST', `/portal/requests/${request.id}/withdrawal`, atlas, {
      version: request.version,
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);

    const response = await send('POST', '/portal/upload-sessions', atlas, clientBody(request.id), {
      'idempotency-key': freshKey(),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details?.map((d) => d.field)).toEqual(['objectId']);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
    expect(store.began).toHaveLength(0);
  });

  it('cannot attach to a sibling client’s request, and learns nothing from the refusal', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const request = await submitRequest(atlas);
    const meridian = await signIn(world.meridian.reviewer.id);
    const response = await send(
      'POST',
      '/portal/upload-sessions',
      meridian,
      clientBody(request.id, { projectId: world.northstar.projectId }),
      { 'idempotency-key': freshKey() },
    );
    expect(response.statusCode).toBe(404);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
  });

  it('cannot upload a deliverable, a message attachment, or a file with no request', async () => {
    const atlas = await signIn(world.atlas.reviewer.id);
    const request = await submitRequest(atlas);
    const deliverable = await send(
      'POST',
      '/portal/upload-sessions',
      atlas,
      clientBody(request.id, { purpose: 'deliverable' }),
      { 'idempotency-key': freshKey() },
    );
    const message = await send(
      'POST',
      '/portal/upload-sessions',
      atlas,
      clientBody(request.id, { purpose: 'message_attachment' }),
      { 'idempotency-key': freshKey() },
    );
    const unattached = await send(
      'POST',
      '/portal/upload-sessions',
      atlas,
      clientBody(request.id, { objectId: undefined }),
      { 'idempotency-key': freshKey() },
    );
    expect(deliverable.statusCode).toBe(422);
    expect(message.statusCode).toBe(422);
    expect(unattached.statusCode).toBe(400);
    expect(store.began).toHaveLength(0);
  });

  it('cannot see or finish the studio’s session, nor the studio a client’s', async () => {
    const studio = await signIn(manager().id);
    const atlas = await signIn(world.atlas.reviewer.id);
    const internal = await open(studio);
    const request = await submitRequest(atlas);
    const client = (
      await send('POST', '/portal/upload-sessions', atlas, clientBody(request.id), {
        'idempotency-key': freshKey(),
      })
    ).json<UploadSession>();

    const clientOnInternal = await send(
      'POST',
      `/portal/upload-sessions/${internal.id}/complete`,
      atlas,
      partsFor(internal),
    );
    const studioOnClient = await send(
      'POST',
      `/upload-sessions/${client.id}/complete`,
      studio,
      partsFor(client),
    );
    expect(clientOnInternal.statusCode).toBe(404);
    expect(studioOnClient.statusCode).toBe(404);
    expect(store.completed).toHaveLength(0);
  });
});
