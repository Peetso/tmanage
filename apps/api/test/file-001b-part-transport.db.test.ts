import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import {
  FilesystemObjectStore,
  createPartAdmission,
  derivePartSigningKey,
  mintPartToken,
} from '@tmanage/storage';
import type { CompleteMultipartInput, StoredObject } from '@tmanage/storage';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { StorageModule } from '../src/common/storage/storage.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import {
  createFastifyAdapter,
  PART_BODY_SLACK_BYTES,
  PART_CONTENT_TYPE,
} from '../src/common/http/fastify-adapter.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * FILE-001b over real HTTP — the bytes move, through the API, into the filesystem driver.
 *
 * `file-001-upload-sessions.db.test.ts` proves the session and the reservation against a
 * fake that moves nothing. This suite boots the same application on `StorageModule.forConfig`
 * with the real `filesystem` driver under a temporary root, a **sixteen-byte part size**
 * (`UPLOAD_PART_SIZE_BYTES`, a number no deployment uses; the real 8 MiB is proved once, in
 * E2E-12a) and the octet-stream parser `main.ts` registers, and drives a whole multipart
 * upload: create, PUT every part with no session at all, complete with the etags the PUTs
 * answered. That is INT-12's etag third *for the local driver*; the content-hash third stays
 * FILE-002's.
 *
 * What only this suite proves:
 *
 * 1. **The transport is public and the neighbours are not.** A PUT with no cookie and no
 *    CSRF token lands; the same client's `complete` without a cookie is 401.
 * 2. **Every refusal is one 404.** No token, a truncated one, another upload's, another
 *    part's, an unknown handle, an expired token, a token minted under the session or CSRF
 *    secret, a part the upload does not have, a traversal in the handle — one body,
 *    byte-identical modulo the correlation id, and nothing written.
 * 3. **The directory is the revocation.** Cancel, then PUT: 404 and nothing on disk.
 *    Complete, then PUT: 404 and the sealed object unchanged.
 * 4. **A provider refusal at completion keeps the upload open** (decision 11). A wrong etag
 *    or a part never sent is 422 on `parts`, the session stays `reserved`, the parts stay
 *    on disk, and the same session completes once the client has re-sent what was wrong.
 * 5. **The ceiling is the part size, in our envelope.** One byte over is 413 from the driver,
 *    after the token; a byte over the slack is 413 from the parser, before it. Nothing
 *    written either way.
 * 6. **The response says only the etag.** No key, no tenant, no handle, empty body.
 * 7. **The parser and the 413 mapping stay off every other route.** An octet-stream body
 *    anywhere else is 415 unread; an oversize JSON body anywhere else is a generic 413.
 * 8. **The claim holds against the real driver** (migration 0017). A cancel that lands while
 *    the driver is assembling the object is 409; the assembly finishes, the object is sealed,
 *    the staging directory is gone, and the bytes are counted once.
 */

/**
 * The real driver with a hook on `completeMultipart` — the window between the claim and
 * the commit, where a racing cancel is injected. Wired through `StorageModule.forLocalStore`
 * so the same object is the store and the part sink, as `forConfig` wires it.
 */
class HookedFilesystemObjectStore extends FilesystemObjectStore {
  onComplete: ((input: CompleteMultipartInput) => Promise<void>) | null = null;

  override async completeMultipart(input: CompleteMultipartInput): Promise<StoredObject> {
    const hook = this.onComplete;
    this.onComplete = null;
    if (hook) await hook(input);
    return super.completeMultipart(input);
  }
}

let db: TestDatabase;
let store: HookedFilesystemObjectStore;
let world: SeedWorld;
let app: NestFastifyApplication;
let root: string;
/** Milliseconds added to the driver's clock — the expiry case, without a sleep. */
let clockOffsetMs = 0;

const PART_SIZE = 16;
const DECLARED = 64; // four parts
const ORG_LIMIT = 10_000;
const TTL_SECONDS = 900;
const PUBLIC_URL = 'http://localhost:4000';
const SIGNING_SECRET = 'a_storage_signing_secret_for_the_transport_suite_xxxx';

const CONFIG: ApiConfig = {
  ...apiConfigFrom({
    NODE_ENV: 'test',
    SESSION_COOKIE_NAME: 'tmanage_session',
    SESSION_SECRET: 'local_dev_only_session_secret_for_the_files_suite_xxxxx',
    SESSION_TTL_SECONDS: 900,
    REFRESH_TTL_SECONDS: 1_209_600,
    CSRF_SECRET: 'local_dev_only_csrf_secret_for_the_files_suite_xxxxxxxx',
    AUTH_MFA_SEED_KEYS: '1:local_dev_only_mfa_seed_key_change_me_00000',
    API_PUBLIC_URL: PUBLIC_URL,
    AUTH_MAX_FAILURES_IN_WINDOW: 50,
    AUTH_FAILURE_WINDOW_SECONDS: 900,
    AUTH_TOTP_ISSUER: 'TManage',
    CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
  }),
  storageOrgBytesLimit: ORG_LIMIT,
  uploadMaxBytes: 5_000,
  uploadUrlTtlSeconds: TTL_SECONDS,
  uploadPartSizeBytes: PART_SIZE,
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

interface UploadSession {
  id: string;
  fileAssetId: string;
  status: string;
  partCount: number;
  reservedBytes: number;
  uploadUrls: { partNumber: number; url: string }[];
}

interface FileAsset {
  id: string;
  status: string;
  sizeBytes: number;
  fileVersionId: string;
}

interface ErrorBody {
  error: { code: string; message: string; correlationId: string; details?: { field: string }[] };
}

const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex');
const bytes = (fill: string, length = PART_SIZE) => Buffer.alloc(length, fill);
const FILLS = ['a', 'b', 'c', 'd'];

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

async function send(
  method: 'GET' | 'POST',
  path: string,
  session: Session | null,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<InjectedResponse> {
  return (await app.inject({
    method,
    url: `/v1/organizations/northstar-studio${path}`,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(session ? { cookie: session.cookie } : {}),
      ...(session && method !== 'GET' ? { [CSRF_HEADER]: session.csrfToken } : {}),
      ...headers,
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

let keyCounter = 0;
const freshKey = (): string => `transport-key-${String(++keyCounter).padStart(10, '0')}`;

/** Open a session as the studio's manager: sixty-four bytes, four parts. */
async function open(session: Session, sizeBytes = DECLARED): Promise<UploadSession> {
  const response = await send(
    'POST',
    '/upload-sessions',
    session,
    {
      projectId: world.northstar.projectId,
      fileName: 'brief.pdf',
      mimeType: 'application/pdf',
      sizeBytes,
      purpose: 'deliverable',
    },
    { 'idempotency-key': freshKey() },
  );
  if (response.statusCode !== 201) {
    throw new Error(`open failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<UploadSession>();
}

/** The path and query of a minted URL — what the browser would send to the API. */
function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function handleOf(session: UploadSession): string {
  const url = new URL(session.uploadUrls[0]?.url ?? '');
  return url.pathname.split('/')[3] as string;
}

/** A PUT as the browser sends it: raw bytes, the content type, and **no cookie**. */
async function putPart(
  path: string,
  body: Buffer,
  headers: Record<string, string> = {},
): Promise<InjectedResponse> {
  return (await app.inject({
    method: 'PUT',
    url: path,
    headers: { 'content-type': PART_CONTENT_TYPE, ...headers },
    payload: body,
  })) as unknown as InjectedResponse;
}

/** PUT every part, in order, and collect the etags the way a client would. */
async function putAll(session: UploadSession): Promise<{ partNumber: number; etag: string }[]> {
  const parts: { partNumber: number; etag: string }[] = [];
  for (const target of session.uploadUrls) {
    const response = await putPart(pathOf(target.url), bytes(FILLS[target.partNumber - 1] ?? 'z'));
    if (response.statusCode !== 200) {
      throw new Error(`PUT ${target.partNumber} failed: ${response.statusCode} ${response.body}`);
    }
    parts.push({ partNumber: target.partNumber, etag: String(response.headers['etag']) });
  }
  return parts;
}

async function complete(
  session: Session | null,
  upload: UploadSession,
  parts: readonly { partNumber: number; etag: string }[],
): Promise<InjectedResponse> {
  return send('POST', `/upload-sessions/${upload.id}/complete`, session, { parts });
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .replace(/\\/g, '/'),
    )
    .sort();
}

const under = (handle: string) => walk(root).filter((p) => p.startsWith(`uploads/${handle}/`));
const objects = () => walk(root).filter((p) => p.startsWith('objects/'));

async function counter(): Promise<{ used: number; reserved: number }> {
  const [row] = await observe(
    'select used_value as used, reserved_value as reserved from usage_counters where organization_id = ?',
    [world.northstar.organizationId],
  );
  return { used: Number(row?.['used'] ?? 0), reserved: Number(row?.['reserved'] ?? 0) };
}

async function sessionStatus(id: string): Promise<string> {
  const [row] = await observe('select status from upload_sessions where id = ?', [id]);
  return String(row?.['status']);
}

async function versionRows(fileAssetId: string): Promise<RowDataPacket[]> {
  return observe('select size_bytes as s, etag as e from file_versions where file_asset_id = ?', [
    fileAssetId,
  ]);
}

/** The error body with the one field that legitimately differs per request removed. */
function shape(response: InjectedResponse): unknown {
  const body = response.json<ErrorBody>();
  expect(typeof body.error.correlationId).toBe('string');
  return { status: response.statusCode, error: { ...body.error, correlationId: undefined } };
}

beforeAll(async () => {
  db = await startTestDatabase();
  root = mkdtempSync(join(tmpdir(), 'tmanage-transport-'));
  store = new HookedFilesystemObjectStore({
    root,
    signingSecret: SIGNING_SECRET,
    publicUrl: PUBLIC_URL,
    partSizeBytes: PART_SIZE,
    now: () => Date.now() + clockOffsetMs,
  });
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
      storage: StorageModule.forLocalStore(store),
    }),
    createFastifyAdapter({
      uploadPartSizeBytes: PART_SIZE,
      admitPart: createPartAdmission(SIGNING_SECRET, () => Date.now() + clockOffsetMs),
    }),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  clockOffsetMs = 0;
  store.onComplete = null;
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

// ─────────────────────────────────────────────────────────────────────────────
// The whole upload
// ─────────────────────────────────────────────────────────────────────────────

describe('the whole upload', () => {
  it('moves sixty-four bytes in four parts with no session, completes on their etags, and writes the version (INT-12, the etag third, local driver)', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    expect(upload.partCount).toBe(4);
    expect(upload.uploadUrls.map((u) => u.partNumber)).toEqual([1, 2, 3, 4]);
    for (const target of upload.uploadUrls) {
      expect(target.url.startsWith(`${PUBLIC_URL}/v1/uploads/`)).toBe(true);
      expect(target.url).not.toContain(world.northstar.organizationId);
      expect(target.url).not.toContain(upload.id);
    }
    const handle = handleOf(upload);
    expect(under(handle)).toEqual([`uploads/${handle}/manifest.json`]);

    const parts = await putAll(upload);
    expect(parts.map((p) => p.etag)).toEqual(FILLS.map((f) => `"${md5(bytes(f))}"`));
    expect(under(handle)).toHaveLength(5); // the manifest and four parts

    const before = objects();
    const response = await complete(studio, upload, parts);
    expect(response.statusCode).toBe(202);
    const asset = response.json<FileAsset>();
    expect(asset.status).toBe('uploaded');
    expect(asset.sizeBytes).toBe(DECLARED);
    expect(asset.fileVersionId).toBeTruthy();

    // On disk: exactly one new object, the parts in order, and the staging directory gone.
    const after = objects();
    expect(after.length).toBe(before.length + 1);
    const object = after.find((p) => !before.includes(p)) as string;
    expect(object.startsWith('objects/quarantine/')).toBe(true);
    expect(readFileSync(join(root, object))).toEqual(Buffer.concat(FILLS.map((f) => bytes(f))));
    expect(under(handle)).toEqual([]);

    // In the database: the version, the composite etag, the reservation converted.
    const versions = await versionRows(upload.fileAssetId);
    expect(versions).toHaveLength(1);
    expect(Number(versions[0]?.['s'])).toBe(DECLARED);
    const composite = createHash('md5')
      .update(Buffer.concat(FILLS.map((f) => Buffer.from(md5(bytes(f)), 'hex'))))
      .digest('hex');
    expect(String(versions[0]?.['e'])).toBe(`${composite}-4`);
    expect(await counter()).toEqual({ used: DECLARED, reserved: 0 });
    expect(await sessionStatus(upload.id)).toBe('completed');
  });

  it('accepts the PUT with no cookie and no CSRF token, while the neighbouring route still demands both', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    const target = pathOf(upload.uploadUrls[0]?.url ?? '');

    // Reversal: drop `@Public()` from the controller and this is a 401 — the PUT is not a
    // safe method, so `CsrfGuard` would be reached too.
    const anonymous = await putPart(target, bytes('a'));
    expect(anonymous.statusCode).toBe(200);
    // With a cookie but no CSRF header: still 200, because the token is bound to nothing.
    const cookied = await putPart(target, bytes('a'), { cookie: studio.cookie });
    expect(cookied.statusCode).toBe(200);

    // The contrast: completion is the session-holder's and is refused without one.
    const noSession = await complete(null, upload, []);
    expect(noSession.statusCode).toBe(401);
    const noCsrf = (await app.inject({
      method: 'POST',
      url: `/v1/organizations/northstar-studio/upload-sessions/${upload.id}/complete`,
      headers: { 'content-type': 'application/json', cookie: studio.cookie },
      payload: { parts: [] },
    })) as unknown as InjectedResponse;
    expect(noCsrf.statusCode).toBe(403);
  });

  it('answers only the etag: an empty body, and no key, tenant or handle in the headers', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    const response = await putPart(pathOf(upload.uploadUrls[0]?.url ?? ''), bytes('a'));

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    expect(response.headers['etag']).toBe(`"${md5(bytes('a'))}"`);
    const headers = JSON.stringify(response.headers);
    expect(headers).not.toContain(handleOf(upload));
    expect(headers).not.toContain(world.northstar.organizationId);
    expect(headers).not.toContain('tenant/');
    expect(headers).not.toContain(upload.id);
  });

  it('refuses a JSON body as a client error (400), a body with no content type as Fastify does (415), and a JSON body for a part that is not one as 404', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    const target = pathOf(upload.uploadUrls[0]?.url ?? '');
    const json = (await app.inject({
      method: 'PUT',
      url: target,
      headers: { 'content-type': 'application/json' },
      payload: { bytes: 'aaaa' },
    })) as unknown as InjectedResponse;
    expect(json.statusCode).toBe(400);
    expect(json.json<ErrorBody>().error.code).toBe('validation_failed');

    // What `fetch` sends for a `Blob.slice()` body: no content type at all. Fastify has no
    // parser for that and answers 415 before the route; pinned so the record says so.
    const untyped = (await app.inject({
      method: 'PUT',
      url: target,
      headers: {},
      payload: bytes('a'),
    })) as unknown as InjectedResponse;
    expect(untyped.statusCode).toBe(415);
    expect(untyped.json<ErrorBody>().error.code).toBe('validation_failed');

    // The part number is checked before the body: a JSON body for part "one" is the same
    // 404 as every other refusal, not a hint that the route is reading the body at all.
    // Reversal: check the body type first and this is a 400.
    const notAPart = (await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${handleOf(upload)}/parts/one`,
      headers: { 'content-type': 'application/json' },
      payload: { bytes: 'aaaa' },
    })) as unknown as InjectedResponse;
    expect(notAPart.statusCode).toBe(404);
    expect(under(handleOf(upload))).toEqual([`uploads/${handleOf(upload)}/manifest.json`]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Every refusal is one 404
// ─────────────────────────────────────────────────────────────────────────────

describe('what the PUT refuses', () => {
  it('answers one byte-identical 404 to no token, a truncated one, a foreign one, the wrong part, an unknown handle and an impossible part number, and writes nothing', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    const other = await open(studio);
    const handle = handleOf(upload);
    const [one, two] = upload.uploadUrls.map((u) => new URL(u.url));
    const token = (one as URL).searchParams.get('t') as string;
    const base = `/v1/uploads/${handle}/parts/1`;

    // Reversal: distinguish expiry, forgery or absence by status or message — an oracle.
    const attempts = [
      base,
      `${base}?t=`,
      `${base}?t=${token.slice(0, -1)}`,
      `${base}?t=${new URL(other.uploadUrls[0]?.url ?? '').searchParams.get('t') as string}`,
      `${base}?t=${(two as URL).searchParams.get('t') as string}`,
      `/v1/uploads/${'0'.repeat(32)}/parts/1?t=${token}`,
      `/v1/uploads/${handle}/parts/5?t=${token}`,
      `/v1/uploads/${handle}/parts/0?t=${token}`,
      `/v1/uploads/${handle}/parts/one?t=${token}`,
      `/v1/uploads/${handle}/parts/01?t=${token}`,
    ];
    const shapes = [];
    for (const path of attempts) {
      const response = await putPart(path, bytes('a'));
      expect(response.statusCode, path).toBe(404);
      shapes.push(shape(response));
    }
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    expect(shapes[0]).toMatchObject({ status: 404, error: { code: 'not_found' } });

    expect(under(handle)).toEqual([`uploads/${handle}/manifest.json`]);
    expect(under(handleOf(other))).toEqual([`uploads/${handleOf(other)}/manifest.json`]);
  });

  it('answers the same 404 to an expired token, on a moved clock rather than a sleep', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    const target = pathOf(upload.uploadUrls[0]?.url ?? '');
    const handle = handleOf(upload);

    const reference = shape(await putPart(`/v1/uploads/${handle}/parts/1`, bytes('a')));

    clockOffsetMs = TTL_SECONDS * 1_000 + 1;
    const expired = await putPart(target, bytes('a'));
    expect(expired.statusCode).toBe(404);
    expect(shape(expired)).toEqual(reference);
    expect(under(handle)).toEqual([`uploads/${handle}/manifest.json`]);

    // A second before the expiry, the same token lands.
    clockOffsetMs = TTL_SECONDS * 1_000 - 1_000;
    expect((await putPart(target, bytes('a'))).statusCode).toBe(200);
  });

  it('refuses a token minted under the session secret or the CSRF secret', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    const handle = handleOf(upload);
    const reference = shape(await putPart(`/v1/uploads/${handle}/parts/1`, bytes('a')));

    for (const secret of [CONFIG.sessionSecret, CONFIG.csrfSecret]) {
      const forged = mintPartToken(derivePartSigningKey(secret), {
        providerUploadId: handle,
        partNumber: 1,
        expiresAtMs: Date.now() + TTL_SECONDS * 1_000,
      });
      const response = await putPart(`/v1/uploads/${handle}/parts/1?t=${forged}`, bytes('a'));
      expect(response.statusCode).toBe(404);
      expect(shape(response)).toEqual(reference);
    }
    // And the real one, to prove the mint above is the shape the driver reads.
    expect((await putPart(pathOf(upload.uploadUrls[0]?.url ?? ''), bytes('a'))).statusCode).toBe(
      200,
    );
  });

  it('refuses a traversal, an absolute path or a non-handle in the handle with the one 404 body, and writes nothing anywhere', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    const token = new URL(upload.uploadUrls[0]?.url ?? '').searchParams.get('t') as string;
    const before = walk(root);
    const reference = shape(await putPart(`/v1/uploads/${'0'.repeat(32)}/parts/1`, bytes('a')));

    for (const handle of ['..%2F..%2Fescape', '..', 'C:%5Cescape', '%2Fescape', 'not-a-handle']) {
      const response = await putPart(`/v1/uploads/${handle}/parts/1?t=${token}`, bytes('a'));
      expect(response.statusCode, handle).toBe(404);
      expect(shape(response), handle).toEqual(reference);
    }
    expect(walk(root)).toEqual(before);
    expect(existsSync(join(root, '..', 'escape'))).toBe(false);
  });

  it('refuses a body over the part size with 413 in our envelope — one byte over from the driver, one over the slack from the parser — and writes nothing', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    const target = pathOf(upload.uploadUrls[0]?.url ?? '');
    const handle = handleOf(upload);

    for (const length of [PART_SIZE + 1, PART_SIZE + PART_BODY_SLACK_BYTES + 1, PART_SIZE * 4]) {
      const response = await putPart(target, bytes('a', length));
      expect(response.statusCode, String(length)).toBe(413);
      const body = response.json<ErrorBody>();
      expect(body.error.code).toBe('validation_failed');
      expect(body.error.details?.[0]?.field).toBe('body');
    }
    expect(under(handle)).toEqual([`uploads/${handle}/manifest.json`]);
    // Exactly the part size is not over it.
    expect((await putPart(target, bytes('a', PART_SIZE))).statusCode).toBe(200);

    // A forged token learns nothing at all, not even that a ceiling exists: since the
    // security review of 2026-09-04 the parser admits the token before it reads a byte,
    // so a forged body of any size — under the slack, one over it, four parts' worth — is
    // the one 404, and none of it was buffered. Reversal: read the body before the
    // admission and the two larger ones answer 413 again.
    const forged = `/v1/uploads/${handle}/parts/1?t=pu1.1.x`;
    for (const length of [
      PART_SIZE + PART_BODY_SLACK_BYTES,
      PART_SIZE + PART_BODY_SLACK_BYTES + 1,
      PART_SIZE * 4,
    ]) {
      expect((await putPart(forged, bytes('a', length))).statusCode, String(length)).toBe(404);
    }
    expect(under(handle)).toEqual([
      `uploads/${handle}/manifest.json`,
      `uploads/${handle}/part-0001`,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The directory is the revocation
// ─────────────────────────────────────────────────────────────────────────────

describe('after cancel and after complete', () => {
  it('cancel, then PUT: 404, and nothing under the root for that upload', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    const handle = handleOf(upload);
    expect((await putPart(pathOf(upload.uploadUrls[0]?.url ?? ''), bytes('a'))).statusCode).toBe(
      200,
    );

    const cancelled = await send('POST', `/upload-sessions/${upload.id}/cancel`, studio);
    expect(cancelled.statusCode).toBe(200);

    // Reversal: an `abortMultipart` that only forgets state and leaves the directory —
    // the URL is still valid for fourteen minutes and this lands.
    const late = await putPart(pathOf(upload.uploadUrls[1]?.url ?? ''), bytes('b'));
    expect(late.statusCode).toBe(404);
    expect(under(handle)).toEqual([]);
    expect(walk(root).some((p) => p.includes(handle))).toBe(false);
  });

  it('a cancel during the assembly is 409, and the object is sealed once with the bytes counted once (the claim, real driver)', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    const parts = await putAll(upload);
    const before = objects();
    let cancel: { status: number; session: string; staging: number } | null = null;

    // The driver has read the manifest and is assembling when the opener cancels.
    // Reversal: drop the claim and the cancel answers 200, `abortMultipart` removes the
    // upload directory under the assembly, and the completion fails or seals an object
    // whose session is `cancelled` and whose bytes were given back.
    store.onComplete = async () => {
      const response = await send('POST', `/upload-sessions/${upload.id}/cancel`, studio);
      cancel = {
        status: response.statusCode,
        session: await sessionStatus(upload.id),
        staging: under(handleOf(upload)).length,
      };
    };

    const response = await complete(studio, upload, parts);
    expect(response.statusCode, response.body).toBe(202);
    expect(cancel).toEqual({ status: 409, session: 'completing', staging: 5 });
    expect(await sessionStatus(upload.id)).toBe('completed');
    expect(await counter()).toEqual({ used: DECLARED, reserved: 0 });
    expect(objects().filter((p) => !before.includes(p))).toHaveLength(1);
    expect(under(handleOf(upload))).toEqual([]);
    expect(await versionRows(upload.fileAssetId)).toHaveLength(1);
  });

  it('complete, then PUT: 404, and the sealed object is unchanged', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    const parts = await putAll(upload);
    const before = objects();
    expect((await complete(studio, upload, parts)).statusCode).toBe(202);
    const object = objects().find((p) => !before.includes(p)) as string;
    const sealed = readFileSync(join(root, object));

    const late = await putPart(pathOf(upload.uploadUrls[0]?.url ?? ''), bytes('z'));
    expect(late.statusCode).toBe(404);
    expect(readFileSync(join(root, object))).toEqual(sealed);
    expect(under(handleOf(upload))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A provider refusal at completion
// ─────────────────────────────────────────────────────────────────────────────

describe('what completion refuses', () => {
  it('a wrong etag is 422 on parts and the session stays reserved; the same etags, right, then complete it (decision 11)', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    const parts = await putAll(upload);
    expect(await counter()).toEqual({ used: 0, reserved: DECLARED });
    const before = objects();
    const wrong = parts.map((p) => (p.partNumber === 2 ? { ...p, etag: md5(bytes('x')) } : p));

    // Reversal: leave `completeMultipart` untried in the service and this is a 500; release
    // the session on a mismatch, as the first shape did, and the retry below is 422.
    const response = await complete(studio, upload, wrong);
    expect(response.statusCode).toBe(422);
    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toBe('The request body is invalid');
    expect(body.error.details?.[0]).toEqual({
      field: 'parts',
      message: 'part 2 does not match the etag presented for it',
    });

    // Nothing released, nothing written, nothing thrown away: the upload is still open.
    expect(await counter()).toEqual({ used: 0, reserved: DECLARED });
    expect(await versionRows(upload.fileAssetId)).toHaveLength(0);
    expect(await sessionStatus(upload.id)).toBe('reserved');
    expect(under(handleOf(upload))).toHaveLength(5);
    expect(objects()).toEqual(before);

    // The client's second try, with the etags the PUTs actually answered.
    const retried = await complete(studio, upload, parts);
    expect(retried.statusCode, retried.body).toBe(202);
    expect(await counter()).toEqual({ used: DECLARED, reserved: 0 });
    expect(await sessionStatus(upload.id)).toBe('completed');
    expect(under(handleOf(upload))).toEqual([]);
  });

  it('a part never sent is 422 on parts with the session still reserved; send it, then complete', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const upload = await open(studio);
    // Three of the four parts are PUT; the fourth is named at completion with an etag the
    // client could only have guessed.
    const sent = [];
    for (const target of upload.uploadUrls.slice(0, 3)) {
      const r = await putPart(pathOf(target.url), bytes(FILLS[target.partNumber - 1] ?? 'z'));
      sent.push({ partNumber: target.partNumber, etag: String(r.headers['etag']) });
    }
    const guessed = [...sent, { partNumber: 4, etag: md5(bytes('d')) }];

    const response = await complete(studio, upload, guessed);
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.details?.[0]).toEqual({
      field: 'parts',
      message: 'part 4 was never uploaded',
    });
    expect(await sessionStatus(upload.id)).toBe('reserved');
    expect(await counter()).toEqual({ used: 0, reserved: DECLARED });
    expect(await versionRows(upload.fileAssetId)).toHaveLength(0);
    expect(under(handleOf(upload))).toHaveLength(4); // the manifest and three parts

    // The missing part arrives; the same completion now succeeds.
    const fourth = await putPart(pathOf(upload.uploadUrls[3]?.url ?? ''), bytes('d'));
    expect(fourth.statusCode).toBe(200);
    expect(String(fourth.headers['etag'])).toBe(`"${md5(bytes('d'))}"`);
    const retried = await complete(studio, upload, guessed);
    expect(retried.statusCode, retried.body).toBe(202);
    expect(await counter()).toEqual({ used: DECLARED, reserved: 0 });
    expect(await sessionStatus(upload.id)).toBe('completed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The parser and the 413 mapping stay off every other route
// ─────────────────────────────────────────────────────────────────────────────

describe('what the octet-stream parser and the 413 mapping leave alone', () => {
  it('answers 415 to an octet-stream body on any route that is not the part route, whatever its size', async () => {
    // The parser is instance-wide, so it refuses by URL before it reads a byte. Reversal:
    // buffer first and a body over the parser's limit is a 413 here, and a small one is
    // handed to a route that never asked for bytes.
    const studio = await signIn(world.northstar.manager.id);
    for (const length of [8, PART_SIZE + PART_BODY_SLACK_BYTES + 1]) {
      const response = (await app.inject({
        method: 'POST',
        url: '/v1/organizations/northstar-studio/upload-sessions',
        headers: {
          'content-type': PART_CONTENT_TYPE,
          cookie: studio.cookie,
          [CSRF_HEADER]: studio.csrfToken,
          'idempotency-key': freshKey(),
        },
        payload: bytes('a', length),
      })) as unknown as InjectedResponse;
      expect(response.statusCode, String(length)).toBe(415);
      const body = response.json<ErrorBody>();
      expect(body.error.code).toBe('validation_failed');
      expect(body.error.details).toBeUndefined();
    }
  });

  it('answers a generic 413 to a JSON body over Fastify’s 1 MiB default on any other route', async () => {
    // Reversal: key the filter's mapping on the status alone and this names "the part size"
    // on a route that has no parts.
    const studio = await signIn(world.northstar.manager.id);
    const response = (await app.inject({
      method: 'POST',
      url: '/v1/organizations/northstar-studio/upload-sessions',
      headers: {
        'content-type': 'application/json',
        cookie: studio.cookie,
        [CSRF_HEADER]: studio.csrfToken,
        'idempotency-key': freshKey(),
      },
      payload: JSON.stringify({ padding: 'x'.repeat(1_100_000) }),
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(413);
    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toBe('The request could not be understood');
    expect(body.error.details).toBeUndefined();
  });
});
