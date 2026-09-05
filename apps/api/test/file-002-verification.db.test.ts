import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, truncateSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { FilesystemObjectStore, createPartAdmission } from '@tmanage/storage';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { StorageModule } from '../src/common/storage/storage.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { createFastifyAdapter, PART_CONTENT_TYPE } from '../src/common/http/fastify-adapter.js';
import { AUDIT_SERVICE, FILE_VERIFIER, TENANT_DATABASE } from '../src/common/http/tokens.js';
import type { TenantDatabase } from '../src/common/database/tenant-context.js';
import type { AuditService } from '../src/modules/audit/audit.service.js';
import { verifierContextFor } from '../src/modules/files/file-verifier.js';
import { STALE_VERIFYING_MS } from '../src/modules/files/file-verifier.js';
import type { FileVerifier, VerifyReport } from '../src/modules/files/file-verifier.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * FILE-002, slice A — the verification pass, over the real API and the real filesystem
 * driver: bytes are PUT through the public part route, completed, and then judged by the
 * pass `verify.ts` would resolve.
 *
 * What only this suite proves:
 *
 * 1. **A clean file is verified.** The digest of the bytes lands on the version, the
 *    detected type beside it, the asset goes `uploaded → verifying → scanning`, and one
 *    `file_asset.verified` row with no actor says so. Nothing is `ready`. A second pass
 *    finds nothing.
 * 2. **The declaration is held to.** A `contentHash` the bytes do not match is
 *    `hash_mismatch`: `rejected`, the code on the row, the digest still recorded, one
 *    `file_asset.rejected` row as `denied`, one `file.rejected.v1` naming no filename — and
 *    the bytes stay on disk and stay counted (decision F4).
 * 3. **The signature allowlist (SEC-06).** SVG declared as itself and HTML declared as PDF
 *    are `type_not_allowed`; PNG bytes declared PDF are `type_mismatch`; a real Office
 *    container declared as `.docx` passes; text passes and text with a NUL does not.
 * 4. **Tenants do not mix.** Two organizations in one pass, each judged under its own
 *    context, each with its own audit trail.
 * 5. **A dead pass is re-run** (decision 13). A `verifying` row older than the bound is
 *    taken by the next pass; a fresh one is not.
 * 6. **A missing object is an error, not a verdict** (REL-05). The row stays `verifying`,
 *    one `file_asset.scan_failed` row says `object_not_found`, and nothing else moves.
 * 7. **An object that is not the size the completion recorded is an error too.** A
 *    truncated object is never hashed into a verdict; the row waits.
 * 8. **A verdict is write-once at the engine** (migration 0018). The admin credential
 *    cannot rewrite `content_hash` once set; `size_bytes` stays immutable.
 * 9. **A rejection cannot be filed as allowed.** The audit repository refuses
 *    `file_asset.rejected` with any result but `denied`.
 */

let db: TestDatabase;
let store: FilesystemObjectStore;
let world: SeedWorld;
let app: NestFastifyApplication;
let verifier: FileVerifier;
let root: string;

const PART_SIZE = 16;
const DECLARED = 64; // four parts
const ORG_LIMIT = 10_000;
const PUBLIC_URL = 'http://localhost:4000';
const SIGNING_SECRET = 'a_storage_signing_secret_for_the_verification_suite_xx';
const OOXML = 'application/vnd.openxmlformats-officedocument';

const CONFIG: ApiConfig = {
  ...apiConfigFrom({
    NODE_ENV: 'test',
    SESSION_COOKIE_NAME: 'tmanage_session',
    SESSION_SECRET: 'local_dev_only_session_secret_for_the_verify_suite_xxxx',
    SESSION_TTL_SECONDS: 900,
    REFRESH_TTL_SECONDS: 1_209_600,
    CSRF_SECRET: 'local_dev_only_csrf_secret_for_the_verify_suite_xxxxxxx',
    API_PUBLIC_URL: PUBLIC_URL,
    AUTH_MAX_FAILURES_IN_WINDOW: 50,
    AUTH_FAILURE_WINDOW_SECONDS: 900,
    AUTH_TOTP_ISSUER: 'TManage',
    CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
  }),
  storageOrgBytesLimit: ORG_LIMIT,
  uploadMaxBytes: 5_000,
  uploadUrlTtlSeconds: 900,
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
  uploadUrls: { partNumber: number; url: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Bytes: sixty-four of each kind, so every object is four full parts
// ─────────────────────────────────────────────────────────────────────────────

function padTo(head: Buffer | string, length = DECLARED): Buffer {
  const start = Buffer.isBuffer(head) ? head : Buffer.from(head, 'latin1');
  return Buffer.concat([start, Buffer.alloc(length - start.length, 0x20)]);
}

const PDF = padTo('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n');
const PNG = padTo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]));
const SVG = padTo('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
const HTML = padTo('<!DOCTYPE html><html><script>alert(1)</script></html>');
const DOCX = padTo(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]));
const TEXT = padTo('name,total\nمشروع,12\n');
const TEXT_WITH_NUL = Buffer.concat([
  padTo('name,total\n', 40),
  Buffer.from([0x00]),
  Buffer.alloc(23, 0x41),
]);

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers, as the transport suite has them
// ─────────────────────────────────────────────────────────────────────────────

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
const freshKey = (): string => `verify-key-${String(++keyCounter).padStart(10, '0')}`;

interface Tenant {
  readonly slug: string;
  readonly projectId: string;
  readonly managerId: string;
  readonly organizationId: string;
}

const northstar = (): Tenant => ({
  slug: 'northstar-studio',
  projectId: world.northstar.projectId,
  managerId: world.northstar.manager.id,
  organizationId: world.northstar.organizationId,
});
const brightops = (): Tenant => ({
  slug: 'brightops-consulting',
  projectId: world.brightops.projectId,
  managerId: world.brightops.owner.id,
  organizationId: world.brightops.organizationId,
});

/**
 * Open, PUT every part and complete: an `uploaded` asset whose object holds `bytes`.
 * Returns the asset's id.
 */
async function uploaded(
  tenant: Tenant,
  bytes: Buffer,
  mimeType: string,
  contentHash?: string,
): Promise<{ fileAssetId: string; uploadSessionId: string }> {
  const session = await signIn(tenant.managerId);
  const opened = await send(
    tenant.slug,
    'POST',
    '/upload-sessions',
    session,
    {
      projectId: tenant.projectId,
      fileName: 'brief.bin',
      mimeType,
      sizeBytes: bytes.length,
      purpose: 'deliverable',
      ...(contentHash ? { contentHash } : {}),
    },
    { 'idempotency-key': freshKey() },
  );
  if (opened.statusCode !== 201) throw new Error(`open: ${opened.statusCode} ${opened.body}`);
  const upload = opened.json<UploadSession>();

  const parts: { partNumber: number; etag: string }[] = [];
  for (const target of upload.uploadUrls) {
    const url = new URL(target.url);
    const body = bytes.subarray((target.partNumber - 1) * PART_SIZE, target.partNumber * PART_SIZE);
    const response = (await app.inject({
      method: 'PUT',
      url: `${url.pathname}${url.search}`,
      headers: { 'content-type': PART_CONTENT_TYPE },
      payload: body,
    })) as unknown as InjectedResponse;
    if (response.statusCode !== 200)
      throw new Error(`PUT: ${response.statusCode} ${response.body}`);
    parts.push({ partNumber: target.partNumber, etag: String(response.headers['etag']) });
  }
  const completed = await send(
    tenant.slug,
    'POST',
    `/upload-sessions/${upload.id}/complete`,
    session,
    {
      parts,
    },
  );
  if (completed.statusCode !== 202) {
    throw new Error(`complete: ${completed.statusCode} ${completed.body}`);
  }
  return { fileAssetId: upload.fileAssetId, uploadSessionId: upload.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Observations
// ─────────────────────────────────────────────────────────────────────────────

interface AssetRow {
  status: string;
  rejectionCode: string | null;
  contentHash: string | null;
  detectedMimeType: string | null;
  objectKey: string;
}

async function asset(fileAssetId: string): Promise<AssetRow> {
  const [row] = await observe(
    `select a.status as s, a.rejection_code as r, v.content_hash as h, v.detected_mime_type as d,
            v.object_key as k
       from file_assets a join file_versions v on v.file_asset_id = a.id
      where a.id = ?`,
    [fileAssetId],
  );
  return {
    status: String(row?.['s']),
    rejectionCode: row?.['r'] === null ? null : String(row?.['r']),
    contentHash: row?.['h'] === null ? null : String(row?.['h']),
    detectedMimeType: row?.['d'] === null ? null : String(row?.['d']),
    objectKey: String(row?.['k']),
  };
}

interface Audit {
  readonly action: string;
  readonly result: string;
  readonly actor: string | null;
  readonly organizationId: string;
  readonly metadata: Record<string, unknown>;
}

async function audits(fileAssetId: string): Promise<Audit[]> {
  const rows = await observe(
    `select action, result, actor_user_id as actor, organization_id as org, metadata_json as m
       from audit_events where object_type = 'file_asset' and object_id = ?
        and action <> 'file_asset.uploaded' order by id`,
    [fileAssetId],
  );
  return rows.map((r) => {
    const raw = r['m'];
    return {
      action: String(r['action']),
      result: String(r['result']),
      actor: r['actor'] === null ? null : String(r['actor']),
      organizationId: String(r['org']),
      metadata: (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>,
    };
  });
}

async function rejectedEvents(fileAssetId: string): Promise<Record<string, unknown>[]> {
  const rows = await observe(
    `select payload_json as p, aggregate_type as t from outbox_events
      where aggregate_id = ? and type = 'file.rejected.v1' order by id`,
    [fileAssetId],
  );
  return rows.map((r) => {
    const raw = r['p'];
    expect(String(r['t'])).toBe('file_asset');
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
  });
}

async function counter(organizationId: string): Promise<{ used: number; reserved: number }> {
  const [row] = await observe(
    'select used_value as used, reserved_value as reserved from usage_counters where organization_id = ?',
    [organizationId],
  );
  return { used: Number(row?.['used'] ?? 0), reserved: Number(row?.['reserved'] ?? 0) };
}

function objects(): string[] {
  const directory = join(root, 'objects', 'quarantine');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Age a `verifying` row by `ms`, from a bound Date — never the admin session's clock. */
async function ageVerifying(fileAssetId: string, ms: number): Promise<void> {
  await db.admin.query('update file_assets set updated_at = ? where id = ?', [
    new Date(Date.now() - ms),
    fileAssetId,
  ]);
}

const pass = (): Promise<VerifyReport> => verifier.verify();

beforeAll(async () => {
  db = await startTestDatabase();
  root = mkdtempSync(join(tmpdir(), 'tmanage-verify-'));
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
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  for (const path of objects()) unlinkSync(path);
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a clean file', () => {
  it('is hashed, sniffed and moved to scanning — never ready — with one verified row and no actor', async () => {
    const { fileAssetId } = await uploaded(northstar(), PDF, 'application/pdf', sha256(PDF));
    expect((await asset(fileAssetId)).status).toBe('uploaded');

    const report = await pass();
    expect(report).toEqual({
      organizations: 1,
      scanned: 1,
      verified: 1,
      rejected: 0,
      skipped: 0,
      failed: 0,
      reran: 0,
    });

    const row = await asset(fileAssetId);
    expect(row.status).toBe('scanning');
    expect(row.rejectionCode).toBeNull();
    expect(row.contentHash).toBe(sha256(PDF));
    expect(row.detectedMimeType).toBe('application/pdf');

    const trail = await audits(fileAssetId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: 'file_asset.verified',
      result: 'allowed',
      actor: null,
      organizationId: world.northstar.organizationId,
    });
    expect(trail[0]?.metadata).toMatchObject({
      sha256: sha256(PDF),
      detected_type: 'pdf',
      declared_hash_present: true,
      size_bytes: DECLARED,
      purpose: 'deliverable',
    });
    expect(JSON.stringify(trail[0]?.metadata)).not.toContain('brief');
    expect(await rejectedEvents(fileAssetId)).toEqual([]);

    // A second pass finds nothing: the row left `uploaded` and is not stale.
    expect(await pass()).toMatchObject({ organizations: 0, scanned: 0 });
  });

  it('accepts a file declared without a content hash, and the audit row says the proof is weaker', async () => {
    const { fileAssetId } = await uploaded(northstar(), PDF, 'application/pdf');
    await pass();
    expect((await asset(fileAssetId)).status).toBe('scanning');
    expect((await audits(fileAssetId))[0]?.metadata).toMatchObject({
      declared_hash_present: false,
    });
  });
});

describe('the declaration is held to', () => {
  it('rejects a hash mismatch: the code on the row, the digest still recorded, a denied row, one event, and the bytes still counted', async () => {
    const { fileAssetId } = await uploaded(northstar(), PDF, 'application/pdf', sha256(PNG));
    const before = await counter(world.northstar.organizationId);
    expect(before).toEqual({ used: DECLARED, reserved: 0 });
    const objectsBefore = objects();

    // Reversal: skip the comparison with `declared_content_hash` and this is verified.
    const report = await pass();
    expect(report).toMatchObject({ verified: 0, rejected: 1, failed: 0 });

    const row = await asset(fileAssetId);
    expect(row.status).toBe('rejected');
    expect(row.rejectionCode).toBe('hash_mismatch');
    expect(row.contentHash).toBe(sha256(PDF));
    expect(row.detectedMimeType).toBeNull();

    const trail = await audits(fileAssetId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: 'file_asset.rejected',
      result: 'denied',
      actor: null,
    });
    expect(trail[0]?.metadata).toMatchObject({
      rejection_code: 'hash_mismatch',
      sha256: sha256(PDF),
      declared_hash_present: true,
    });
    expect(trail[0]?.metadata).not.toHaveProperty('detected_type');

    const events = await rejectedEvents(fileAssetId);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      fileAssetId,
      fileVersionId: expect.any(String),
      projectId: world.northstar.projectId,
      purpose: 'deliverable',
      objectId: null,
      rejectionCode: 'hash_mismatch',
    });

    // Decision F4: the object is evidence. Still on disk, still counted.
    expect(objects()).toEqual(objectsBefore);
    expect(await counter(world.northstar.organizationId)).toEqual(before);
    // And terminal: a second pass does not touch it.
    expect(await pass()).toMatchObject({ scanned: 0 });
  });
});

describe('the signature allowlist (SEC-06)', () => {
  it('refuses active content and spoofed labels, admits an Office container and text', async () => {
    const tenant = northstar();
    const svg = await uploaded(tenant, SVG, 'image/svg+xml');
    const htmlAsPdf = await uploaded(tenant, HTML, 'application/pdf');
    const pngAsPdf = await uploaded(tenant, PNG, 'application/pdf');
    const docx = await uploaded(tenant, DOCX, `${OOXML}.wordprocessingml.document`);
    const csv = await uploaded(tenant, TEXT, 'text/csv');
    const binaryAsText = await uploaded(tenant, TEXT_WITH_NUL, 'text/plain');

    const report = await pass();
    expect(report).toMatchObject({ scanned: 6, verified: 2, rejected: 4, failed: 0 });

    // Reversal: compare declared and sniffed types by equality and the .docx is refused.
    expect(await asset(svg.fileAssetId)).toMatchObject({
      status: 'rejected',
      rejectionCode: 'type_not_allowed',
    });
    expect(await asset(htmlAsPdf.fileAssetId)).toMatchObject({
      status: 'rejected',
      rejectionCode: 'type_not_allowed',
    });
    expect(await asset(pngAsPdf.fileAssetId)).toMatchObject({
      status: 'rejected',
      rejectionCode: 'type_mismatch',
    });
    expect(await asset(docx.fileAssetId)).toMatchObject({
      status: 'scanning',
      detectedMimeType: `${OOXML}.wordprocessingml.document`,
    });
    expect(await asset(csv.fileAssetId)).toMatchObject({
      status: 'scanning',
      detectedMimeType: 'text/csv',
    });
    expect(await asset(binaryAsText.fileAssetId)).toMatchObject({
      status: 'rejected',
      rejectionCode: 'type_mismatch',
    });

    // The rejected ones carry the digest (evidence) and no detected type; every row says
    // which code, and no metadata value carries a slash.
    for (const id of [svg, htmlAsPdf, pngAsPdf, binaryAsText].map((u) => u.fileAssetId)) {
      const row = await asset(id);
      expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.detectedMimeType).toBeNull();
      const [entry] = await audits(id);
      expect(entry?.result).toBe('denied');
      for (const value of Object.values(entry?.metadata ?? {})) {
        if (typeof value === 'string') expect(value).not.toContain('/');
      }
      expect(await rejectedEvents(id)).toHaveLength(1);
    }
    expect((await audits(docx.fileAssetId))[0]?.metadata).toMatchObject({ detected_type: 'docx' });
    expect((await audits(csv.fileAssetId))[0]?.metadata).toMatchObject({
      detected_type: 'text_csv',
    });
  });
});

describe('tenants do not mix', () => {
  it('judges two organizations in one pass, each under its own context', async () => {
    const north = await uploaded(northstar(), PDF, 'application/pdf', sha256(PDF));
    const south = await uploaded(brightops(), PNG, 'image/png', sha256(PNG));

    const report = await pass();
    expect(report).toMatchObject({ organizations: 2, scanned: 2, verified: 2 });

    expect((await asset(north.fileAssetId)).status).toBe('scanning');
    expect((await asset(south.fileAssetId)).status).toBe('scanning');
    const [northAudit] = await audits(north.fileAssetId);
    const [southAudit] = await audits(south.fileAssetId);
    expect(northAudit?.organizationId).toBe(world.northstar.organizationId);
    expect(southAudit?.organizationId).toBe(world.brightops.organizationId);
    expect(southAudit?.metadata).toMatchObject({ detected_type: 'png' });
  });
});

describe('a dead pass is re-run (decision 13)', () => {
  it('re-runs a verifying row older than the bound, and leaves a fresh one alone', async () => {
    const stale = await uploaded(northstar(), PDF, 'application/pdf', sha256(PDF));
    const fresh = await uploaded(northstar(), PNG, 'image/png', sha256(PNG));
    // Both rows as a dying pass would have left them: claimed, never concluded.
    for (const id of [stale.fileAssetId, fresh.fileAssetId]) {
      await db.admin.query("update file_assets set status = 'verifying' where id = ?", [id]);
    }
    await ageVerifying(stale.fileAssetId, STALE_VERIFYING_MS + 60_000);
    await ageVerifying(fresh.fileAssetId, STALE_VERIFYING_MS - 60_000);

    // Reversal: select `uploaded` only and this pass finds no organization at all.
    const report = await pass();
    expect(report).toEqual({
      organizations: 1,
      scanned: 1,
      verified: 1,
      rejected: 0,
      skipped: 0,
      failed: 0,
      reran: 1,
    });
    expect((await asset(stale.fileAssetId)).status).toBe('scanning');
    expect((await asset(fresh.fileAssetId)).status).toBe('verifying');
    expect(await audits(fresh.fileAssetId)).toEqual([]);
  });
});

describe('a missing object is an error, not a verdict (REL-05)', () => {
  it('leaves the row verifying, records scan_failed with the cause, and moves nothing else', async () => {
    const { fileAssetId } = await uploaded(northstar(), PDF, 'application/pdf', sha256(PDF));
    const key = (await asset(fileAssetId)).objectKey;
    unlinkSync(store.objectPath('quarantine', key));

    // The pass names the row on stderr by default; the count is what matters here.
    const report = await pass();
    expect(report).toMatchObject({ scanned: 1, verified: 0, rejected: 0, failed: 1 });

    const row = await asset(fileAssetId);
    expect(row.status).toBe('verifying');
    expect(row.rejectionCode).toBeNull();
    expect(row.contentHash).toBeNull();
    const trail = await audits(fileAssetId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: 'file_asset.scan_failed',
      result: 'error',
      actor: null,
    });
    expect(trail[0]?.metadata).toMatchObject({ cause: 'object_not_found' });
    expect(await rejectedEvents(fileAssetId)).toEqual([]);

    // Not stale yet: the next pass leaves it. Aged: it is tried again, and fails again.
    expect(await pass()).toMatchObject({ scanned: 0 });
    await ageVerifying(fileAssetId, STALE_VERIFYING_MS + 60_000);
    expect(await pass()).toMatchObject({ scanned: 1, failed: 1, reran: 1 });
    expect(await audits(fileAssetId)).toHaveLength(2);
  });
});

describe('an object that is not the size the row says', () => {
  it('is an error, never a verdict: a truncated object leaves the row verifying with scan_failed size_mismatch', async () => {
    const { fileAssetId } = await uploaded(northstar(), PDF, 'application/pdf', sha256(PDF));
    const key = (await asset(fileAssetId)).objectKey;
    truncateSync(store.objectPath('quarantine', key), DECLARED - 1);

    // Reversal: drop the size check and the sixty-three bytes are hashed into a verdict —
    // `scanning` with a digest no client ever declared.
    expect(await pass()).toMatchObject({ scanned: 1, verified: 0, rejected: 0, failed: 1 });
    const row = await asset(fileAssetId);
    expect(row.status).toBe('verifying');
    expect(row.contentHash).toBeNull();
    const [entry] = await audits(fileAssetId);
    expect(entry).toMatchObject({ action: 'file_asset.scan_failed', result: 'error' });
    expect(entry?.metadata).toMatchObject({ cause: 'size_mismatch' });
  });
});

describe('a rejection cannot be filed as allowed', () => {
  it('refuses file_asset.rejected with any result but denied, before any row is written', async () => {
    const database = app.get<TenantDatabase>(TENANT_DATABASE);
    const audit = app.get<AuditService>(AUDIT_SERVICE);
    const context = verifierContextFor(world.northstar.organizationId, uuidv7());
    // Reversal: drop the rule in `AuditEventsRepository.append` and this row lands.
    await expect(
      database.transaction(context, (tx) =>
        audit.record(tx, context, {
          action: 'file_asset.rejected',
          objectId: '00000000-0000-7000-8000-000000000001',
          result: 'allowed',
          actorUserId: null,
          metadata: { rejection_code: 'type_mismatch' },
        }),
      ),
    ).rejects.toThrow(/file_asset\.rejected/);
    expect(
      await observe("select id from audit_events where action = 'file_asset.rejected'"),
    ).toEqual([]);
  });
});

describe('a verdict is write-once at the engine (migration 0018)', () => {
  it('refuses to rewrite content_hash or detected_mime_type once set, and keeps size_bytes immutable', async () => {
    const { fileAssetId } = await uploaded(northstar(), PDF, 'application/pdf', sha256(PDF));
    await pass();
    const [version] = await observe('select id from file_versions where file_asset_id = ?', [
      fileAssetId,
    ]);
    const id = String(version?.['id']);

    // Reversal: leave 0018 out and the admin credential rewrites the verdict.
    await expect(
      db.admin.query('update file_versions set content_hash = ? where id = ?', [
        '0'.repeat(64),
        id,
      ]),
    ).rejects.toThrow(/write-once/);
    await expect(
      db.admin.query('update file_versions set detected_mime_type = ? where id = ?', [
        'image/png',
        id,
      ]),
    ).rejects.toThrow(/write-once/);
    await expect(
      db.admin.query('update file_versions set content_hash = NULL where id = ?', [id]),
    ).rejects.toThrow(/write-once/);
    await expect(
      db.admin.query('update file_versions set size_bytes = 1 where id = ?', [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.admin.query('update file_versions set etag = ? where id = ?', ['other', id]),
    ).rejects.toThrow(/immutable/);
    // The values stand.
    expect((await asset(fileAssetId)).contentHash).toBe(sha256(PDF));
  });
});
