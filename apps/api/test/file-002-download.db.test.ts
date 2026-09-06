import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, truncateSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { FilesystemObjectStore, createPartAdmission } from '@tmanage/storage';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { StorageModule } from '../src/common/storage/storage.module.js';
import { ScannerModule } from '../src/common/scan/scanner.module.js';
import { EICAR, StubScanner } from '../src/common/scan/malware-scanner.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { createFastifyAdapter, PART_CONTENT_TYPE } from '../src/common/http/fastify-adapter.js';
import { FILE_SCANNER, FILE_VERIFIER } from '../src/common/http/tokens.js';
import type { FileVerifier } from '../src/modules/files/file-verifier.js';
import type { FileScanner } from '../src/modules/files/file-scanner.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * FILE-002, slice C — the download gate, over the real API, the real filesystem driver,
 * slice A's verifier and slice B's scanner (the stub). Bytes are PUT through the public
 * part route, completed, verified, scanned and promoted; then `GET …/files/:id/content` is
 * the only way out.
 *
 * What only this suite proves:
 *
 * 1. **A ready file is served from the private zone**, byte for byte, with the detected type,
 *    `attachment`, `nosniff`, `private, no-store`, its length — and one `file_asset.downloaded`
 *    row (`allowed`) that names no filename.
 * 2. **Every refusal is one 404**: a file still `scanning`, a `rejected` file, an unknown id
 *    and another tenant's id answer byte-identical bodies; the cause is on the denied row's
 *    `audit_code` alone; the quarantine object is never served.
 * 3. **The latest version rules**: a `ready` asset whose newest version is still in
 *    quarantine is not served.
 * 4. **The client's door**: a client downloads their own request's attachment; a sibling
 *    client organization sharing the project does not; a client never downloads an internal
 *    deliverable; the studio downloads the client's file; a client cannot use the studio's
 *    route.
 * 5. **A missing or truncated private object is a refusal, never a quarantine fallback.**
 * 6. **An archived project** is readable by the studio and by no client (`authorize` rule 6).
 * 7. **The filename cannot break the header.**
 */

let db: TestDatabase;
let store: FilesystemObjectStore;
let world: SeedWorld;
let app: NestFastifyApplication;
let verifier: FileVerifier;
let scanner: FileScanner;
let root: string;

const PART_SIZE = 16;
const DECLARED = 128;
function padTo(head: Buffer | string, length = DECLARED): Buffer {
  const start = Buffer.isBuffer(head) ? head : Buffer.from(head, 'latin1');
  return Buffer.concat([start, Buffer.alloc(length - start.length, 0x20)]);
}
const PDF = padTo('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n');
const TEXT = padTo('minutes of the kickoff call\n');
const MALWARE = padTo(Buffer.concat([Buffer.from('notes: '), EICAR, Buffer.from('\n')]));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const PUBLIC_URL = 'http://localhost:4000';
const SIGNING_SECRET = 'a_storage_signing_secret_for_the_download_suite_xxxx';

const CONFIG: ApiConfig = {
  ...apiConfigFrom({
    NODE_ENV: 'test',
    SESSION_COOKIE_NAME: 'tmanage_session',
    SESSION_SECRET: 'local_dev_only_session_secret_for_the_dl_suite_xxxxxxxx',
    SESSION_TTL_SECONDS: 900,
    REFRESH_TTL_SECONDS: 1_209_600,
    CSRF_SECRET: 'local_dev_only_csrf_secret_for_the_download_suite_xxxxx',
    AUTH_MFA_SEED_KEYS: '1:local_dev_only_mfa_seed_key_change_me_00000',
    API_PUBLIC_URL: PUBLIC_URL,
    AUTH_MAX_FAILURES_IN_WINDOW: 50,
    AUTH_FAILURE_WINDOW_SECONDS: 900,
    AUTH_TOTP_ISSUER: 'TManage',
    CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
  }),
  storageOrgBytesLimit: 1_000_000,
  uploadMaxBytes: 5_000,
  uploadUrlTtlSeconds: 900,
  uploadPartSizeBytes: PART_SIZE,
};

interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly rawPayload: Buffer;
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
  uploadUrls: { partNumber: number; url: string }[];
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
async function send(
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
      ...(method !== 'GET' ? { [CSRF_HEADER]: session.csrfToken } : {}),
      ...headers,
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

let keyCounter = 0;
const freshKey = (): string => `dl-key-${String(++keyCounter).padStart(10, '0')}`;

const NORTHSTAR = 'northstar-studio';
const BRIGHTOPS = 'brightops-consulting';

interface Door {
  readonly session: Session;
  readonly prefix: '' | '/portal';
}

/** Open, PUT every part and complete through a door: an `uploaded` asset. */
async function uploaded(
  door: Door,
  bytes: Buffer,
  body: Record<string, unknown>,
): Promise<{
  fileAssetId: string;
  objectKey: string;
  /** Replays the completion: the view the door answers for a finished session. */
  replay: () => Promise<InjectedResponse>;
}> {
  const opened = await send(
    NORTHSTAR,
    'POST',
    `${door.prefix}/upload-sessions`,
    door.session,
    {
      fileName: 'brief.pdf',
      mimeType: 'application/pdf',
      ...body,
      sizeBytes: bytes.length,
      contentHash: sha256(bytes),
    },
    { 'idempotency-key': freshKey() },
  );
  if (opened.statusCode !== 201) throw new Error(`open: ${opened.statusCode} ${opened.body}`);
  const upload = opened.json<UploadSession>();
  const parts: { partNumber: number; etag: string }[] = [];
  for (const target of upload.uploadUrls) {
    const url = new URL(target.url);
    const part = bytes.subarray((target.partNumber - 1) * PART_SIZE, target.partNumber * PART_SIZE);
    const response = (await app.inject({
      method: 'PUT',
      url: `${url.pathname}${url.search}`,
      headers: { 'content-type': PART_CONTENT_TYPE },
      payload: part,
    })) as unknown as InjectedResponse;
    if (response.statusCode !== 200)
      throw new Error(`PUT: ${response.statusCode} ${response.body}`);
    parts.push({ partNumber: target.partNumber, etag: String(response.headers['etag']) });
  }
  const completed = await send(
    NORTHSTAR,
    'POST',
    `${door.prefix}/upload-sessions/${upload.id}/complete`,
    door.session,
    { parts },
  );
  if (completed.statusCode !== 202) {
    throw new Error(`complete: ${completed.statusCode} ${completed.body}`);
  }
  const [row] = await observe('select object_key as k from file_versions where file_asset_id = ?', [
    upload.fileAssetId,
  ]);
  return {
    fileAssetId: upload.fileAssetId,
    objectKey: String(row?.['k']),
    replay: () =>
      send(
        NORTHSTAR,
        'POST',
        `${door.prefix}/upload-sessions/${upload.id}/complete`,
        door.session,
        {
          parts,
        },
      ),
  };
}

const studio = async (): Promise<Door> => ({
  session: await signIn(world.northstar.manager.id),
  prefix: '',
});
const client = async (userId: string): Promise<Door> => ({
  session: await signIn(userId),
  prefix: '/portal',
});

async function submitRequest(door: Door): Promise<string> {
  const response = await send(NORTHSTAR, 'POST', '/portal/requests', door.session, {
    projectId: world.northstar.projectId,
    title: 'Add a careers page',
    description: 'We need a careers page before the recruitment round opens.',
  });
  if (response.statusCode !== 201)
    throw new Error(`submit: ${response.statusCode} ${response.body}`);
  return response.json<{ id: string }>().id;
}

const deliverableBody = () => ({ projectId: world.northstar.projectId, purpose: 'deliverable' });

async function verifyAndScan(): Promise<void> {
  await verifier.verify();
  await scanner.scan();
}

async function status(fileAssetId: string): Promise<string> {
  const [row] = await observe('select status as s from file_assets where id = ?', [fileAssetId]);
  return String(row?.['s']);
}

interface Audit {
  readonly result: string;
  readonly actor: string | null;
  readonly metadata: Record<string, unknown>;
}
async function downloads(fileAssetId: string): Promise<Audit[]> {
  const rows = await observe(
    `select result, actor_user_id as a, metadata_json as metadata from audit_events
      where action = 'file_asset.downloaded' and object_id = ? order by id`,
    [fileAssetId],
  );
  return rows.map((row) => ({
    result: String(row['result']),
    actor: row['a'] === null ? null : String(row['a']),
    metadata: (typeof row['metadata'] === 'string'
      ? JSON.parse(row['metadata'] as string)
      : row['metadata']) as Record<string, unknown>,
  }));
}
async function deniedCodes(): Promise<string[]> {
  const rows = await observe(
    `select metadata_json as metadata from audit_events where action = 'file_asset.downloaded' and result = 'denied' order by id`,
  );
  return rows.map((row) => {
    const metadata = (
      typeof row['metadata'] === 'string' ? JSON.parse(row['metadata'] as string) : row['metadata']
    ) as Record<string, unknown>;
    return String(metadata['audit_code']);
  });
}

const download = (door: Door, fileAssetId: string, slug = NORTHSTAR) =>
  send(slug, 'GET', `${door.prefix}/files/${fileAssetId}/content`, door.session);

beforeAll(async () => {
  db = await startTestDatabase();
  root = mkdtempSync(join(tmpdir(), 'tmanage-download-'));
  store = new FilesystemObjectStore({
    root,
    signingSecret: SIGNING_SECRET,
    publicUrl: PUBLIC_URL,
    partSizeBytes: PART_SIZE,
  });
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
      storage: StorageModule.forLocalStore(store),
      scanner: ScannerModule.forScanner(new StubScanner()),
    }),
    createFastifyAdapter({
      uploadPartSizeBytes: PART_SIZE,
      admitPart: createPartAdmission(SIGNING_SECRET, () => Date.now()),
    }),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  verifier = app.get<FileVerifier>(FILE_VERIFIER);
  scanner = app.get<FileScanner>(FILE_SCANNER);
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  rmSync(join(root, 'objects'), { recursive: true, force: true, maxRetries: 3 });
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('a ready file', () => {
  it('is served from the private zone, byte for byte, with the detected type and safe headers, and one allowed audit row', async () => {
    const door = await studio();
    const { fileAssetId, objectKey } = await uploaded(door, PDF, deliverableBody());
    await verifyAndScan();
    expect(await status(fileAssetId)).toBe('ready');

    const response = await download(door, fileAssetId);
    expect(response.statusCode, response.body).toBe(200);
    expect(Buffer.compare(response.rawPayload, PDF)).toBe(0);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-length']).toBe(String(PDF.length));
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="brief.pdf"; filename*=UTF-8''brief.pdf`,
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(JSON.stringify(response.headers)).not.toContain(objectKey);

    const trail = await downloads(fileAssetId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ result: 'allowed', actor: world.northstar.manager.id });
    expect(trail[0]?.metadata).toMatchObject({
      purpose: 'deliverable',
      size_bytes: PDF.length,
      principal_kind: 'internal',
      delivery: 'proxy',
    });
    expect(JSON.stringify(trail[0]?.metadata)).not.toContain('brief');

    // A second download is a second row: every disclosure is counted.
    expect((await download(door, fileAssetId)).statusCode).toBe(200);
    expect(await downloads(fileAssetId)).toHaveLength(2);
  });
});

describe('every refusal is one 404', () => {
  it('for a scanning file, a rejected file, an unknown id and another tenant, with the cause on the denied row alone', async () => {
    const door = await studio();
    const {
      fileAssetId: rejected,
      objectKey,
      replay,
    } = await uploaded(door, MALWARE, {
      ...deliverableBody(),
      fileName: 'notes.txt',
      mimeType: 'text/plain',
    });
    await verifyAndScan();
    expect(await status(rejected)).toBe('rejected');
    // The studio's view says why (TM-15): the code, never the engine's name.
    const view = await replay();
    expect(view.statusCode, view.body).toBe(202);
    expect(view.json<{ status: string; rejectionCode: string | null }>()).toMatchObject({
      status: 'rejected',
      rejectionCode: 'malware_detected',
    });
    expect(view.body).not.toContain('Test.Signature');
    // Verified but not yet scanned: the pass has not run since.
    const { fileAssetId: scanning } = await uploaded(door, PDF, deliverableBody());
    await verifier.verify();
    expect(await status(scanning)).toBe('scanning');

    const a = await download(door, scanning);
    const b = await download(door, rejected);
    const c = await download(door, '019203a4-5b6c-7d8e-9f01-23456789abcd');
    for (const response of [a, b, c]) {
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-disposition']).toBeUndefined();
    }
    // Byte-identical bodies but for the per-request correlation id: the response says
    // nothing about which door refused.
    const shape = (response: InjectedResponse): string => {
      expect(response.body).toContain('correlationId');
      return response.body.replace(/"correlationId":"[^"]*"/, '"correlationId":"…"');
    };
    expect(shape(b)).toBe(shape(a));
    expect(shape(c)).toBe(shape(a));
    // The quarantine object is untouched and nothing was promoted.
    expect(existsSync(store.objectPath('quarantine', objectKey))).toBe(true);
    expect(existsSync(store.objectPath('private', objectKey))).toBe(false);

    // Another tenant's principal, on their own slug, with our id.
    const stranger = await signIn(world.brightops.owner.id);
    const d = await download({ session: stranger, prefix: '' }, scanning, BRIGHTOPS);
    expect(d.statusCode).toBe(404);
    expect(shape(d)).toBe(shape(a));

    expect(await deniedCodes()).toEqual([
      'not_servable',
      'not_servable',
      'file_not_found',
      'file_not_found',
    ]);
    expect(await downloads(scanning)).toEqual([]);
  });

  it('for a ready asset whose latest version is still in quarantine', async () => {
    const door = await studio();
    const { fileAssetId } = await uploaded(door, PDF, deliverableBody());
    await verifyAndScan();
    expect((await download(door, fileAssetId)).statusCode).toBe(200);

    // A replacement version, born in quarantine with no verdict, as the admin.
    await db.admin.query('drop temporary table if exists v2');
    await db.admin.query(
      'create temporary table v2 as select * from file_versions where file_asset_id = ?',
      [fileAssetId],
    );
    await db.admin.query(
      `update v2 set id = ?, version_no = version_no + 1, object_key = concat(object_key, '-v2'),
              scan_verdict = null, scanned_at = null, scanner = null, trust_zone = 'quarantine',
              content_hash = null, detected_mime_type = null`,
      ['019203a4-5b6c-7d8e-9f01-23456789abd1'],
    );
    await db.admin.query('insert into file_versions select * from v2');

    const refused = await download(door, fileAssetId);
    expect(refused.statusCode).toBe(404);
    expect(await deniedCodes()).toEqual(['not_servable']);
  });
});

describe("the client's door", () => {
  it('serves their own request attachment, refuses a sibling client organization and an internal deliverable, and the studio reads the client file', async () => {
    const atlas = await client(world.atlas.reviewer.id);
    const requestId = await submitRequest(atlas);
    const { fileAssetId } = await uploaded(atlas, TEXT, {
      projectId: world.northstar.projectId,
      purpose: 'request_attachment',
      objectId: requestId,
      fileName: 'minutes.txt',
      mimeType: 'text/plain',
    });
    await verifyAndScan();
    expect(await status(fileAssetId)).toBe('ready');

    const own = await download(atlas, fileAssetId);
    expect(own.statusCode, own.body).toBe(200);
    expect(Buffer.compare(own.rawPayload, TEXT)).toBe(0);
    expect(own.headers['content-type']).toBe('text/plain');
    // The client's body carries no security metadata and no key.
    expect(JSON.stringify(own.headers)).not.toContain('tenant/');

    const meridian = await client(world.meridian.reviewer.id);
    const sibling = await download(meridian, fileAssetId);
    expect(sibling.statusCode).toBe(404);

    // The studio reads the client's file.
    const manager = await studio();
    expect((await download(manager, fileAssetId)).statusCode).toBe(200);

    // A client never downloads an internal deliverable, and cannot use the studio's route.
    const { fileAssetId: deliverable } = await uploaded(manager, PDF, deliverableBody());
    await verifyAndScan();
    expect((await download(atlas, deliverable)).statusCode).toBe(404);
    const wrongDoor = await download({ session: atlas.session, prefix: '' }, fileAssetId);
    expect(wrongDoor.statusCode).toBe(403);

    expect(await deniedCodes()).toEqual(['client_relation_mismatch', 'purpose_not_downloadable']);
    const trail = await downloads(fileAssetId);
    expect(trail.map((row) => row.result)).toEqual(['allowed', 'allowed']);
    expect(trail[0]?.metadata).toMatchObject({
      purpose: 'request_attachment',
      principal_kind: 'client',
    });
  });
});

describe('the private object', () => {
  it('missing or truncated is a refusal, never a fallback to quarantine', async () => {
    const door = await studio();
    const { fileAssetId, objectKey } = await uploaded(door, PDF, deliverableBody());
    await verifyAndScan();
    const privatePath = store.objectPath('private', objectKey);
    expect(existsSync(privatePath)).toBe(true);

    truncateSync(privatePath, PDF.length - 1);
    expect((await download(door, fileAssetId)).statusCode).toBe(404);

    unlinkSync(privatePath);
    expect((await download(door, fileAssetId)).statusCode).toBe(404);
    expect(existsSync(store.objectPath('quarantine', objectKey))).toBe(true);

    expect(await deniedCodes()).toEqual(['size_mismatch', 'private_object_missing']);
  });
});

describe('an archived project', () => {
  it('is readable by the studio and by no client', async () => {
    const atlas = await client(world.atlas.reviewer.id);
    const requestId = await submitRequest(atlas);
    const { fileAssetId, replay } = await uploaded(atlas, TEXT, {
      projectId: world.northstar.projectId,
      purpose: 'request_attachment',
      objectId: requestId,
      fileName: 'minutes.txt',
      mimeType: 'text/plain',
    });
    await verifyAndScan();
    expect((await download(atlas, fileAssetId)).statusCode).toBe(200);
    // The client's view of the finished upload: no security metadata, the detected type.
    const view = await replay();
    expect(view.statusCode, view.body).toBe(202);
    expect(view.body).not.toContain('rejectionCode');
    expect(view.json<{ status: string; mimeType: string }>()).toMatchObject({
      status: 'ready',
      mimeType: 'text/plain',
    });

    await db.admin.query('update projects set archived_at = current_timestamp(3) where id = ?', [
      world.northstar.projectId,
    ]);
    expect((await download(await studio(), fileAssetId)).statusCode).toBe(200);
    expect((await download(atlas, fileAssetId)).statusCode).toBe(404);
    expect(await deniedCodes()).toEqual(['resource_not_active']);
  });
});

describe('the filename', () => {
  it('cannot break the header: quotes and non-ASCII are carried only in the encoded form', async () => {
    const door = await studio();
    const { fileAssetId } = await uploaded(door, PDF, {
      ...deliverableBody(),
      fileName: 'brief "v2" — نسخة.pdf',
    });
    await verifyAndScan();
    const response = await download(door, fileAssetId);
    expect(response.statusCode, response.body).toBe(200);
    const disposition = String(response.headers['content-disposition']);
    expect(disposition).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
    expect(disposition).toContain('filename="brief _v2_ _ ____.pdf"');
    expect(disposition).toContain(`filename*=UTF-8''brief%20%22v2%22%20%E2%80%94%20`);
    expect(disposition).not.toMatch(/[\r\n]/);
  });
});
