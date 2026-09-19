import 'reflect-metadata';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { FilesystemObjectStore, createPartAdmission } from '@tmanage/storage';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { StorageModule } from '../src/common/storage/storage.module.js';
import { ScannerModule } from '../src/common/scan/scanner.module.js';
import {
  EICAR,
  NoneScanner,
  ScanError,
  ScannerUnavailableError,
  StubScanner,
} from '../src/common/scan/malware-scanner.js';
import type { MalwareScanner, ScanInput, ScanResult } from '../src/common/scan/malware-scanner.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { createFastifyAdapter, PART_CONTENT_TYPE } from '../src/common/http/fastify-adapter.js';
import {
  AUDIT_SERVICE,
  FILE_ASSETS_REPOSITORY,
  FILE_SCANNER,
  FILE_VERIFIER,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
} from '../src/common/http/tokens.js';
import type { TenantDatabase } from '../src/common/database/tenant-context.js';
import type { AuditService } from '../src/modules/audit/audit.service.js';
import { AuditActionResultError } from '../src/modules/audit/audit-events.repository.js';
import type { OutboxEventsRepository } from '../src/modules/platform/outbox-events.repository.js';
import { FileAssetTransitionError } from '../src/modules/files/file-assets.repository.js';
import type { FileAssetsRepository } from '../src/modules/files/file-assets.repository.js';
import type { FileVerifier } from '../src/modules/files/file-verifier.js';
import {
  FileScanner,
  MAX_CONSECUTIVE_FAILURES,
  STALE_SCAN_CLAIM_MS,
  scannerContextFor,
} from '../src/modules/files/file-scanner.js';
import type { ScanReport } from '../src/modules/files/file-scanner.js';
import { startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';
import { reseed, signIn as harnessSignIn, stopHarness } from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';

/**
 * FILE-002, slice B — the scan pass, over the real API, the real filesystem driver and
 * the stub scanner (SEC-06's EICAR test file is what it finds): bytes are PUT through the
 * public part route, completed, verified by slice A's pass, and then scanned and promoted
 * by the pass `verify.ts` runs second.
 *
 * What only this suite proves:
 *
 * 1. **A clean file becomes ready.** The verdict, the time and the scanner land on the
 *    version with `trust_zone = private`; the private object is the bytes the scanner saw;
 *    the quarantine object is untouched; the asset goes `scanning → ready`; one
 *    `file_asset.scanned` row and one `file.ready.v1` — naming no filename, no type, no
 *    digest — share a correlation id. A second pass finds nothing.
 * 2. **An infected file is rejected** with `malware_detected` as the code, the engine's
 *    detection name on stderr and nowhere else, no private object, the bytes counted.
 * 3. **The `none` driver records the truth once** — `unscanned`, `scanning`, one
 *    `scan_failed` row saying `no_scanner` — and a real scanner later replaces it.
 * 4. **An object that is not the verified bytes is an error, never a verdict**, and the
 *    claim it leaves keeps the row out of the next pass until the bound (decision 13).
 * 5. **A scanner that fails on one object** is that object's `scan_failed`; one that cannot
 *    be reached stops the pass before any claim; one that fails every time stops it after
 *    {@link MAX_CONSECUTIVE_FAILURES}.
 * 6. **Two passes overlapping on a stale claim** cannot disagree in the rows: the standing
 *    verdict holds, the loser writes `scan_disputed`, and a rejected asset keeps no
 *    private object.
 * 7. **The engine's rules (0019)**: `ready` needs a clean, promoted latest version; a final
 *    verdict is write-once as a unit; `private` needs `clean`; a version is born in
 *    quarantine; the repository refuses `ready` without `clean` before any write; the
 *    audit repository refuses `file_asset.scanned` as anything but `allowed`.
 * 8. **Tenants do not mix.**
 */

let db: TestDatabase;
let store: FilesystemObjectStore;
let world: SeedWorld;
let app: NestFastifyApplication;
let verifier: FileVerifier;
let scanner: FileScanner;
let hooked: HookedScanner;
let database: TenantDatabase;
let assets: FileAssetsRepository;
let auditService: AuditService;
let outbox: OutboxEventsRepository;
let root: string;
let detections: { fileAssetId: string; correlationId: string; detection: string }[] = [];
let failures: { fileAssetId: string; error: unknown }[] = [];

const PART_SIZE = 16;
const DECLARED = 128; // eight parts: room for the EICAR string
const ORG_LIMIT = 10_000;
const PUBLIC_URL = 'http://localhost:4000';
const SIGNING_SECRET = 'a_storage_signing_secret_for_the_scanning_suite_xxxx';

const CONFIG: ApiConfig = {
  ...apiConfigFrom({
    NODE_ENV: 'test',
    SESSION_COOKIE_NAME: 'tmanage_session',
    SESSION_SECRET: 'local_dev_only_session_secret_for_the_scan_suite_xxxxxx',
    SESSION_TTL_SECONDS: 900,
    REFRESH_TTL_SECONDS: 1_209_600,
    CSRF_SECRET: 'local_dev_only_csrf_secret_for_the_scan_suite_xxxxxxxxx',
    AUTH_MFA_SEED_KEYS: '1:local_dev_only_mfa_seed_key_change_me_00000',
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

/** The stub, with the hooks the failure cases need. */
class HookedScanner implements MalwareScanner {
  readonly name = 'stub' as const;
  readonly kind = 'engine' as const;
  /** Thrown by the next `scan`, after the stream is drained, then cleared. */
  failNext: Error | null = null;
  /** Thrown by every `scan` while set. */
  failAlways: Error | null = null;
  /** Thrown by `probe` while set. */
  probeFails: Error | null = null;
  /** Awaited after the verdict is reached and before it is returned — the overlap case. */
  gate: Promise<void> | null = null;
  private readonly inner = new StubScanner();

  async probe(): Promise<void> {
    if (this.probeFails) throw this.probeFails;
  }

  async scan(input: ScanInput): Promise<ScanResult> {
    const result = await this.inner.scan(input);
    if (this.failAlways) throw this.failAlways;
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (this.gate) await this.gate;
    return result;
  }
}

interface UploadSession {
  id: string;
  fileAssetId: string;
  uploadUrls: { partNumber: number; url: string }[];
}

function padTo(head: Buffer | string, length = DECLARED): Buffer {
  const start = Buffer.isBuffer(head) ? head : Buffer.from(head, 'latin1');
  return Buffer.concat([start, Buffer.alloc(length - start.length, 0x20)]);
}

const PDF = padTo('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n');
/** Text whose bytes pass the verifier (UTF-8, no NUL, no markup) and carry the test string. */
const MALWARE = padTo(Buffer.concat([Buffer.from('notes: '), EICAR, Buffer.from('\n')]));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers, as slice A's suite has them
// ─────────────────────────────────────────────────────────────────────────────

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId);
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
const freshKey = (): string => `scan-key-${String(++keyCounter).padStart(10, '0')}`;

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

/** Open, PUT every part, complete, and run the verifier: a `scanning` asset. */
async function verified(tenant: Tenant, bytes: Buffer, mimeType: string): Promise<string> {
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
      contentHash: sha256(bytes),
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
  const report = await verifier.verify();
  if (report.verified + report.rejected + report.skipped === 0 && report.scanned === 0) {
    throw new Error('the verifier found nothing to verify');
  }
  return upload.fileAssetId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Observations
// ─────────────────────────────────────────────────────────────────────────────

interface AssetRow {
  status: string;
  rejectionCode: string | null;
  scanClaimedAt: Date | null;
  contentHash: string | null;
  scanVerdict: string | null;
  scannedAt: Date | null;
  scanner: string | null;
  trustZone: string;
  objectKey: string;
  versionId: string;
}

async function asset(fileAssetId: string): Promise<AssetRow> {
  const [row] = await observe(
    `select a.status as s, a.rejection_code as r, a.scan_claimed_at as c, v.content_hash as h,
            v.scan_verdict as sv, v.scanned_at as sa, v.scanner as sc, v.trust_zone as z,
            v.object_key as k, v.id as vid
       from file_assets a join file_versions v on v.file_asset_id = a.id
      where a.id = ? order by v.version_no desc limit 1`,
    [fileAssetId],
  );
  const nullable = (value: unknown) =>
    value === null || value === undefined ? null : String(value);
  const when = (value: unknown) =>
    value === null || value === undefined ? null : new Date(value as string);
  return {
    status: String(row?.['s']),
    rejectionCode: nullable(row?.['r']),
    scanClaimedAt: when(row?.['c']),
    contentHash: nullable(row?.['h']),
    scanVerdict: nullable(row?.['sv']),
    scannedAt: when(row?.['sa']),
    scanner: nullable(row?.['sc']),
    trustZone: String(row?.['z']),
    objectKey: String(row?.['k']),
    versionId: String(row?.['vid']),
  };
}

interface Audit {
  readonly action: string;
  readonly result: string;
  readonly actor: string | null;
  readonly organizationId: string;
  readonly correlationId: string;
  readonly metadata: Record<string, unknown>;
}

async function audits(fileAssetId: string): Promise<Audit[]> {
  const rows = await observe(
    `select action, result, actor_user_id as actor, organization_id as org, correlation_id as cid,
            metadata_json as m
       from audit_events where object_type = 'file_asset' and object_id = ?
        and action not in ('file_asset.uploaded', 'file_asset.verified') order by id`,
    [fileAssetId],
  );
  return rows.map((r) => {
    const raw = r['m'];
    return {
      action: String(r['action']),
      result: String(r['result']),
      actor: r['actor'] === null ? null : String(r['actor']),
      organizationId: String(r['org']),
      correlationId: String(r['cid']),
      metadata: (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>,
    };
  });
}

async function events(
  fileAssetId: string,
  type: string,
): Promise<{ payload: Record<string, unknown>; correlationId: string }[]> {
  const rows = await observe(
    `select payload_json as p, aggregate_type as t, correlation_id as cid from outbox_events
      where aggregate_id = ? and type = ? order by id`,
    [fileAssetId, type],
  );
  return rows.map((r) => {
    const raw = r['p'];
    expect(String(r['t'])).toBe('file_asset');
    return {
      payload: (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>,
      correlationId: String(r['cid']),
    };
  });
}

async function counter(organizationId: string): Promise<{ used: number; reserved: number }> {
  const [row] = await observe(
    'select used_value as used, reserved_value as reserved from usage_counters where organization_id = ?',
    [organizationId],
  );
  return { used: Number(row?.['used'] ?? 0), reserved: Number(row?.['reserved'] ?? 0) };
}

function objectsIn(zone: 'quarantine' | 'private'): string[] {
  const directory = join(root, 'objects', zone);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Age a scan claim by `ms`, from a bound Date — never the admin session's clock. */
async function ageClaim(fileAssetId: string, ms: number): Promise<void> {
  await db.admin.query('update file_assets set scan_claimed_at = ? where id = ?', [
    new Date(Date.now() - ms),
    fileAssetId,
  ]);
}

const pass = (): Promise<ScanReport> => scanner.scan();

function scannerWith(driver: MalwareScanner): FileScanner {
  return new FileScanner(
    database,
    assets,
    store,
    driver,
    auditService,
    outbox,
    () => new Date(),
    (fileAssetId, error) => failures.push({ fileAssetId, error }),
    (fileAssetId, correlationId, detection) =>
      detections.push({ fileAssetId, correlationId, detection }),
  );
}

beforeAll(async () => {
  db = await startTestDatabase();
  root = mkdtempSync(join(tmpdir(), 'tmanage-scan-'));
  store = new FilesystemObjectStore({
    root,
    signingSecret: SIGNING_SECRET,
    publicUrl: PUBLIC_URL,
    partSizeBytes: PART_SIZE,
  });
  hooked = new HookedScanner();
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: CONFIG,
      database: DatabaseModule.forPool({ pool: db.runtime, guardMode: 'enforce' }),
      storage: StorageModule.forLocalStore(store),
      scanner: ScannerModule.forScanner(hooked),
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
  database = app.get<TenantDatabase>(TENANT_DATABASE);
  assets = app.get<FileAssetsRepository>(FILE_ASSETS_REPOSITORY);
  auditService = app.get<AuditService>(AUDIT_SERVICE);
  outbox = app.get<OutboxEventsRepository>(OUTBOX_EVENTS_REPOSITORY);
  scanner = scannerWith(hooked);
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
  rmSync(join(root, 'objects'), { recursive: true, force: true, maxRetries: 3 });
  hooked.failNext = null;
  hooked.failAlways = null;
  hooked.probeFails = null;
  hooked.gate = null;
  detections = [];
  failures = [];
});

afterAll(async () => {
  await stopHarness({ app, db });
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a clean file', () => {
  it('is scanned, promoted under the same key and moved to ready — one scanned row and one file.ready.v1, sharing a correlation id', async () => {
    const fileAssetId = await verified(northstar(), PDF, 'application/pdf');
    const before = await asset(fileAssetId);
    expect(before).toMatchObject({
      status: 'scanning',
      scanVerdict: null,
      trustZone: 'quarantine',
    });
    expect(objectsIn('private')).toEqual([]);

    // The pass `verify.ts` resolves from the module, on the driver the module was given.
    const wired = app.get<FileScanner>(FILE_SCANNER);
    const report = await wired.scan();
    expect(report).toEqual({
      organizations: 1,
      scanned: 1,
      ready: 1,
      rejected: 0,
      unscanned: 0,
      skipped: 0,
      failed: 0,
      reran: 0,
    });

    const row = await asset(fileAssetId);
    expect(row).toMatchObject({
      status: 'ready',
      rejectionCode: null,
      scanVerdict: 'clean',
      scanner: 'stub',
      trustZone: 'private',
    });
    expect(row.scannedAt).not.toBeNull();
    // The private object is the bytes the scanner saw; the quarantine object stays.
    expect(readFileSync(store.objectPath('private', row.objectKey)).equals(PDF)).toBe(true);
    expect(readFileSync(store.objectPath('quarantine', row.objectKey)).equals(PDF)).toBe(true);
    expect(objectsIn('private').filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const trail = await audits(fileAssetId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: 'file_asset.scanned',
      result: 'allowed',
      actor: null,
      organizationId: world.northstar.organizationId,
    });
    expect(trail[0]?.metadata).toMatchObject({
      scanner: 'stub',
      verdict: 'clean',
      trust_zone: 'private',
      size_bytes: DECLARED,
      purpose: 'deliverable',
      file_version_id: row.versionId,
    });
    expect(JSON.stringify(trail[0]?.metadata)).not.toContain('brief');

    const ready = await events(fileAssetId, 'file.ready.v1');
    expect(ready).toHaveLength(1);
    expect(ready[0]?.payload).toEqual({
      fileAssetId,
      fileVersionId: row.versionId,
      projectId: world.northstar.projectId,
      purpose: 'deliverable',
      objectId: null,
      sizeBytes: DECLARED,
    });
    const serialized = JSON.stringify(ready[0]?.payload);
    expect(serialized).not.toContain('brief');
    expect(serialized).not.toContain('pdf');
    expect(serialized).not.toContain(sha256(PDF));
    // 35 :100's copy can name one id for the whole conclusion.
    expect(ready[0]?.correlationId).toBe(trail[0]?.correlationId);
    expect(await events(fileAssetId, 'file.rejected.v1')).toEqual([]);

    // A second pass finds nothing: `ready` is terminal.
    expect(await pass()).toMatchObject({ organizations: 0, scanned: 0 });
  });
});

describe('an infected file', () => {
  it('is rejected with a token, never the detection name; no private object; the bytes stay counted', async () => {
    const fileAssetId = await verified(northstar(), MALWARE, 'text/plain');
    expect((await asset(fileAssetId)).status).toBe('scanning');
    const used = (await counter(world.northstar.organizationId)).used;

    const report = await pass();
    expect(report).toMatchObject({ scanned: 1, ready: 0, rejected: 1, failed: 0 });

    const row = await asset(fileAssetId);
    expect(row).toMatchObject({
      status: 'rejected',
      rejectionCode: 'malware_detected',
      scanVerdict: 'infected',
      scanner: 'stub',
      trustZone: 'quarantine',
    });
    expect(objectsIn('private')).toEqual([]);
    expect(existsSync(store.objectPath('quarantine', row.objectKey))).toBe(true);
    expect((await counter(world.northstar.organizationId)).used).toBe(used);

    const trail = await audits(fileAssetId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: 'file_asset.rejected',
      result: 'denied',
      actor: null,
    });
    expect(trail[0]?.metadata).toMatchObject({
      rejection_code: 'malware_detected',
      verdict: 'infected',
      scanner: 'stub',
    });
    // The engine's name for the finding reaches stderr and nothing else.
    expect(JSON.stringify(trail[0]?.metadata)).not.toContain('Eicar');
    const rejected = await events(fileAssetId, 'file.rejected.v1');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload).toMatchObject({ fileAssetId, rejectionCode: 'malware_detected' });
    expect(JSON.stringify(rejected[0]?.payload)).not.toContain('Eicar');
    expect(detections).toEqual([
      { fileAssetId, correlationId: trail[0]?.correlationId, detection: 'Eicar-Test-Signature' },
    ]);
    expect(await events(fileAssetId, 'file.ready.v1')).toEqual([]);
    expect(await pass()).toMatchObject({ organizations: 0 });
  });

  it('withdraws a private object a crashed earlier run left under the key', async () => {
    const fileAssetId = await verified(northstar(), MALWARE, 'text/plain');
    const { objectKey } = await asset(fileAssetId);
    const orphan = store.objectPath('private', objectKey);
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, MALWARE);

    await pass();
    expect((await asset(fileAssetId)).status).toBe('rejected');
    // Reversal: skip the withdraw after a rejection and the orphan is served by slice C.
    expect(existsSync(orphan)).toBe(false);
  });
});

describe('the none driver (decision F3)', () => {
  it('records unscanned once, leaves the asset at scanning, and a real scanner later replaces the verdict', async () => {
    const none = scannerWith(new NoneScanner());
    const fileAssetId = await verified(northstar(), PDF, 'application/pdf');

    const first = await none.scan();
    expect(first).toMatchObject({ scanned: 1, unscanned: 1, ready: 0, rejected: 0, failed: 0 });
    const row = await asset(fileAssetId);
    expect(row).toMatchObject({
      status: 'scanning',
      scanVerdict: 'unscanned',
      scanner: 'none',
      trustZone: 'quarantine',
    });
    expect(row.scannedAt).not.toBeNull();
    expect(objectsIn('private')).toEqual([]);
    const trail = await audits(fileAssetId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: 'file_asset.scan_failed',
      result: 'error',
      actor: null,
    });
    expect(trail[0]?.metadata).toMatchObject({ cause: 'no_scanner', scanner: 'none' });

    // Once, not every tick: the selection skips a version already `unscanned` under `none`.
    expect(await none.scan()).toMatchObject({ organizations: 0, scanned: 0 });
    expect(await audits(fileAssetId)).toHaveLength(1);
    // And the write itself is conditional on no verdict at all: a second `unscanned`, from a
    // pass whose selection was older than this row's verdict, writes nothing rather than a
    // fresh `scanned_at`. Reversal: make `unscanned` conditional on "no final verdict" and
    // this returns true and moves the time.
    const later = new Date((row.scannedAt?.getTime() ?? 0) + 60_000);
    const context = scannerContextFor(
      world.northstar.organizationId,
      '019203a4-5b6c-7d8e-9f01-23456789abd0',
    );
    expect(
      await database.transaction(context, (tx) =>
        assets.recordScan(tx, context, row.versionId, {
          scanVerdict: 'unscanned',
          scannedAt: later,
          scanner: 'none',
        }),
      ),
    ).toBe(false);
    expect((await asset(fileAssetId)).scannedAt?.getTime()).toBe(row.scannedAt?.getTime());

    // A real scanner takes the parked version and the one replaceable verdict is replaced.
    expect(await pass()).toMatchObject({ scanned: 1, ready: 1, reran: 0 });
    const after = await asset(fileAssetId);
    expect(after).toMatchObject({
      status: 'ready',
      scanVerdict: 'clean',
      scanner: 'stub',
      trustZone: 'private',
    });
    expect(after.scannedAt?.getTime()).toBeGreaterThanOrEqual(row.scannedAt?.getTime() ?? 0);
  });
});

describe('an object that is not the verified bytes', () => {
  it('is an error, never a verdict: nothing moves, nothing lands in private, and the claim keeps the row out until the bound', async () => {
    const fileAssetId = await verified(northstar(), PDF, 'application/pdf');
    const { objectKey } = await asset(fileAssetId);
    // Same size, different bytes: the digest will not be the version's.
    writeFileSync(store.objectPath('quarantine', objectKey), padTo('%PDF-1.4 tampered'));

    const report = await pass();
    expect(report).toMatchObject({ scanned: 1, ready: 0, rejected: 0, failed: 1 });
    const row = await asset(fileAssetId);
    expect(row).toMatchObject({ status: 'scanning', scanVerdict: null, trustZone: 'quarantine' });
    expect(row.scanClaimedAt).not.toBeNull();
    expect(objectsIn('private')).toEqual([]);
    const trail = await audits(fileAssetId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ action: 'file_asset.scan_failed', result: 'error' });
    expect(trail[0]?.metadata).toMatchObject({ cause: 'hash_mismatch', scanner: 'stub' });
    expect(failures.map((f) => f.fileAssetId)).toEqual([fileAssetId]);

    // Reversal: select claimed rows again and this finds the row at once.
    expect(await pass()).toMatchObject({ organizations: 0, scanned: 0 });
    await ageClaim(fileAssetId, STALE_SCAN_CLAIM_MS + 1_000);
    expect(await pass()).toMatchObject({ scanned: 1, failed: 1, reran: 1 });
    expect(await audits(fileAssetId)).toHaveLength(2);
  });

  it('refuses a truncated object as a size mismatch before reading it', async () => {
    const fileAssetId = await verified(northstar(), PDF, 'application/pdf');
    const { objectKey } = await asset(fileAssetId);
    writeFileSync(store.objectPath('quarantine', objectKey), PDF.subarray(0, DECLARED - 1));
    expect(await pass()).toMatchObject({ failed: 1 });
    expect((await audits(fileAssetId))[0]?.metadata).toMatchObject({ cause: 'size_mismatch' });
    expect(objectsIn('private')).toEqual([]);
  });
});

describe('a scanner that fails', () => {
  it('on one object: that object waits with its claim, and the next pass after the bound succeeds', async () => {
    const fileAssetId = await verified(northstar(), PDF, 'application/pdf');
    hooked.failNext = new ScanError('timeout');
    expect(await pass()).toMatchObject({ scanned: 1, failed: 1, ready: 0 });
    expect((await asset(fileAssetId)).status).toBe('scanning');
    expect((await audits(fileAssetId))[0]?.metadata).toMatchObject({ cause: 'timeout' });
    expect(objectsIn('private')).toEqual([]);

    await ageClaim(fileAssetId, STALE_SCAN_CLAIM_MS + 1_000);
    expect(await pass()).toMatchObject({ scanned: 1, ready: 1, reran: 1 });
    expect((await asset(fileAssetId)).status).toBe('ready');
  });

  it('to be reached at all stops the pass before any row is claimed', async () => {
    const fileAssetId = await verified(northstar(), PDF, 'application/pdf');
    hooked.probeFails = new ScannerUnavailableError('ECONNREFUSED');
    await expect(pass()).rejects.toBeInstanceOf(ScannerUnavailableError);
    const row = await asset(fileAssetId);
    expect(row.status).toBe('scanning');
    expect(row.scanClaimedAt).toBeNull();
    expect(await audits(fileAssetId)).toEqual([]);
  });

  it('on every object stops the pass after the consecutive-failure bound, leaving the rest unclaimed', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 2; i += 1) {
      ids.push(await verified(northstar(), PDF, 'application/pdf'));
    }
    hooked.failAlways = new ScanError('engine_error');
    await expect(pass()).rejects.toBeInstanceOf(ScannerUnavailableError);
    const rows = await Promise.all(ids.map((id) => asset(id)));
    expect(rows.filter((r) => r.scanClaimedAt !== null)).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect(rows.every((r) => r.status === 'scanning')).toBe(true);
    expect(failures).toHaveLength(MAX_CONSECUTIVE_FAILURES);
  });
});

describe('two passes overlapping on a stale claim', () => {
  it('cannot disagree in the rows: the standing verdict holds, the loser writes scan_disputed, and a rejected asset keeps no private object', async () => {
    const fileAssetId = await verified(northstar(), PDF, 'application/pdf');

    // Pass 1 reaches `clean` and then stalls before it can conclude.
    let release: () => void = () => undefined;
    hooked.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = pass();
    // Wait until pass 1 holds the claim and is inside the scan.
    for (let i = 0; i < 200 && (await asset(fileAssetId)).scanClaimedAt === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await asset(fileAssetId)).scanClaimedAt).not.toBeNull();

    // Its claim goes stale; pass 2, on a driver whose bytes now read as infected, concludes.
    await ageClaim(fileAssetId, STALE_SCAN_CLAIM_MS + 1_000);
    const infectedDriver: MalwareScanner = {
      name: 'stub',
      kind: 'engine',
      probe: async () => undefined,
      scan: async (input) => {
        for await (const _chunk of input.stream) {
          // drained
        }
        return { verdict: 'infected', detection: 'Test.Signature.Update' };
      },
    };
    const second = scannerWith(infectedDriver);
    expect(await second.scan()).toMatchObject({ scanned: 1, rejected: 1, reran: 1 });
    expect((await asset(fileAssetId)).status).toBe('rejected');

    release();
    const first = await slow;
    expect(first).toMatchObject({ scanned: 1, ready: 0, rejected: 0, failed: 1 });

    const row = await asset(fileAssetId);
    expect(row).toMatchObject({
      status: 'rejected',
      scanVerdict: 'infected',
      rejectionCode: 'malware_detected',
      trustZone: 'quarantine',
    });
    // Pass 1 had sealed the private object before it lost; it is withdrawn.
    expect(objectsIn('private')).toEqual([]);
    const trail = await audits(fileAssetId);
    expect(trail.map((a) => a.action).sort()).toEqual([
      'file_asset.rejected',
      'file_asset.scan_disputed',
    ]);
    const disputed = trail.find((a) => a.action === 'file_asset.scan_disputed');
    expect(disputed).toMatchObject({ result: 'error', actor: null });
    expect(disputed?.metadata).toMatchObject({
      standing_verdict: 'infected',
      new_verdict: 'clean',
    });
    expect(await events(fileAssetId, 'file.ready.v1')).toEqual([]);
    expect(await events(fileAssetId, 'file.rejected.v1')).toHaveLength(1);
  });
});

describe('tenants do not mix', () => {
  it('scans two organizations in one pass, each under its own context', async () => {
    const a = await verified(northstar(), PDF, 'application/pdf');
    const b = await verified(brightops(), MALWARE, 'text/plain');
    expect(await pass()).toMatchObject({ organizations: 2, scanned: 2, ready: 1, rejected: 1 });
    expect((await audits(a))[0]?.organizationId).toBe(world.northstar.organizationId);
    expect((await audits(b))[0]?.organizationId).toBe(world.brightops.organizationId);
    expect((await asset(a)).status).toBe('ready');
    expect((await asset(b)).status).toBe('rejected');
  });
});

describe("the engine's rules (migration 0019)", () => {
  it('refuses ready without a clean, promoted latest version; refuses private without clean; refuses a rewrite of a final verdict; admits a replacement of unscanned', async () => {
    const fileAssetId = await verified(northstar(), PDF, 'application/pdf');
    const { versionId } = await asset(fileAssetId);

    // Reversal: leave the ready trigger out and the admin credential marks it ready.
    await expect(
      db.admin.query("update file_assets set status = 'ready' where id = ?", [fileAssetId]),
    ).rejects.toThrow(/clean, promoted latest version/);
    await expect(
      db.admin.query("update file_versions set trust_zone = 'private' where id = ?", [versionId]),
    ).rejects.toThrow(/moves only quarantine to private/);
    await expect(
      db.admin.query(
        "update file_versions set scan_verdict = 'maybe', scanned_at = ?, scanner = 'x' where id = ?",
        [new Date(), versionId],
      ),
    ).rejects.toThrow(/not a verdict/);
    await expect(
      db.admin.query("update file_versions set scan_verdict = 'clean' where id = ?", [versionId]),
    ).rejects.toThrow(/needs scanned_at and scanner/);

    // A provisional verdict, then a final one, then nothing.
    await db.admin.query(
      "update file_versions set scan_verdict = 'unscanned', scanned_at = ?, scanner = 'none' where id = ?",
      [new Date(), versionId],
    );
    await db.admin.query(
      "update file_versions set scan_verdict = 'clean', scanned_at = ?, scanner = 'stub', trust_zone = 'private' where id = ?",
      [new Date(), versionId],
    );
    await expect(
      db.admin.query("update file_versions set scan_verdict = 'infected' where id = ?", [
        versionId,
      ]),
    ).rejects.toThrow(/write-once/);
    await expect(
      db.admin.query("update file_versions set scanner = 'clamav' where id = ?", [versionId]),
    ).rejects.toThrow(/write-once/);
    await expect(
      db.admin.query("update file_versions set trust_zone = 'quarantine' where id = ?", [
        versionId,
      ]),
    ).rejects.toThrow(/moves only quarantine to private/);
    // With a clean, promoted latest version, ready is admitted at the engine.
    await db.admin.query("update file_assets set status = 'ready' where id = ?", [fileAssetId]);
    expect((await asset(fileAssetId)).status).toBe('ready');
  });

  it('binds ready to the latest version: a clean first version does not vouch for an unscanned second', async () => {
    const fileAssetId = await verified(northstar(), PDF, 'application/pdf');
    await pass();
    expect((await asset(fileAssetId)).status).toBe('ready');
    const [version] = await observe(
      'select organization_id as o, object_key as k, size_bytes as s, declared_mime_type as d from file_versions where file_asset_id = ?',
      [fileAssetId],
    );
    await db.admin.query(
      `insert into file_versions (id, organization_id, file_asset_id, version_no, object_key, size_bytes, declared_mime_type)
       values (?, ?, ?, 2, ?, ?, ?)`,
      [
        '019203a4-5b6c-7d8e-9f01-23456789abcd',
        version?.['o'],
        fileAssetId,
        `${String(version?.['k'])}-2`,
        version?.['s'],
        version?.['d'],
      ],
    );
    await db.admin.query("update file_assets set status = 'scanning' where id = ?", [fileAssetId]);
    // Reversal: check "a version" instead of the latest and this succeeds on v1's verdict.
    await expect(
      db.admin.query("update file_assets set status = 'ready' where id = ?", [fileAssetId]),
    ).rejects.toThrow(/clean, promoted latest version/);
  });

  it('refuses a version born private or born with a verdict', async () => {
    const fileAssetId = await verified(northstar(), PDF, 'application/pdf');
    const [version] = await observe(
      'select organization_id as o, object_key as k, size_bytes as s, declared_mime_type as d from file_versions where file_asset_id = ?',
      [fileAssetId],
    );
    const insert = (extra: string, values: unknown[]) =>
      db.admin.query(
        `insert into file_versions (id, organization_id, file_asset_id, version_no, object_key, size_bytes, declared_mime_type${extra})
         values (?, ?, ?, 2, ?, ?, ?${values.map(() => ', ?').join('')})`,
        [
          '019203a4-5b6c-7d8e-9f01-23456789abce',
          version?.['o'],
          fileAssetId,
          `${String(version?.['k'])}-2`,
          version?.['s'],
          version?.['d'],
          ...values,
        ],
      );
    await expect(insert(', trust_zone', ['private'])).rejects.toThrow(/born in quarantine/);
    await expect(
      insert(', scan_verdict, scanned_at, scanner', ['clean', new Date(), 'stub']),
    ).rejects.toThrow(/born without a scan verdict/);
  });

  it('the repository refuses ready without a clean verdict before any write, and the audit repository refuses scanned as anything but allowed', async () => {
    const fileAssetId = await verified(northstar(), PDF, 'application/pdf');
    const context = scannerContextFor(
      world.northstar.organizationId,
      '019203a4-5b6c-7d8e-9f01-23456789abcf',
    );
    await expect(
      database.transaction(context, (tx) =>
        assets.transition(tx, context, fileAssetId, 'ready', {
          scanVerdict: 'infected',
          scannedAt: new Date(),
        }),
      ),
    ).rejects.toThrow(FileAssetTransitionError);
    expect((await asset(fileAssetId)).status).toBe('scanning');

    await expect(
      database.transaction(context, (tx) =>
        auditService.record(tx, context, {
          action: 'file_asset.scanned',
          objectId: fileAssetId,
          result: 'denied',
          actorUserId: null,
          metadata: { scanner: 'stub' },
        }),
      ),
    ).rejects.toBeInstanceOf(AuditActionResultError);
    expect(await audits(fileAssetId)).toEqual([]);
  });
});
