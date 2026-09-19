import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { FakeObjectStore } from '@tmanage/storage';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { StorageModule } from '../src/common/storage/storage.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { QUARANTINE_CLEANUP_JOB } from '../src/common/http/tokens.js';
import type { QuarantineCleanupJob } from '../src/modules/files/quarantine-cleanup.js';
import { STORAGE_BYTES_METRIC } from '../src/modules/files/usage-counters.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * FILE-003 — quarantine / rejected-object deletion and retention lifecycle, over the real API.
 *
 * UNEXECUTED in this slice (needs `db-e2e.lock`, held elsewhere); the lock owner runs it with
 * `pnpm --filter @tmanage/api test -- --project database --run file-003-lifecycle`. The five
 * cases are exactly NEXT-SCOPES-2 §Item 1's acceptance list, no more: (1) §6 step 8 — delete
 * bytes, then decrement + ledger + one audit row; (2) idempotent re-run; (3) provider-delete
 * failure decrements nothing; (4) trigger is rejection status + age alone; (5) two tenants
 * never mix. The rejected state is written by hand (driving a real rejection needs a scanner);
 * this proves the deletion lifecycle, not the rejection FILE-002 already proves.
 */

const DECLARED = 1_000;
const ORG_LIMIT = 100_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

const CONFIG: ApiConfig = {
  ...apiConfigFrom({
    NODE_ENV: 'test',
    SESSION_COOKIE_NAME: 'tmanage_session',
    SESSION_SECRET: 'local_dev_only_session_secret_for_file003_suite_xxx',
    SESSION_TTL_SECONDS: 900,
    REFRESH_TTL_SECONDS: 1_209_600,
    CSRF_SECRET: 'local_dev_only_csrf_secret_for_file003_suite_xxxxxxx',
    AUTH_MFA_SEED_KEYS: '1:local_dev_only_mfa_seed_key_change_me_00000',
    API_PUBLIC_URL: 'http://localhost:4000',
    AUTH_MAX_FAILURES_IN_WINDOW: 50,
    AUTH_FAILURE_WINDOW_SECONDS: 900,
    AUTH_TOTP_ISSUER: 'TManage',
    CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS: 180,
  }),
  storageOrgBytesLimit: ORG_LIMIT,
  uploadMaxBytes: 5_000,
  uploadUrlTtlSeconds: 900,
  // 30-day default retention window; the cases date rejections either side of it.
  fileRetentionRejectedDays: 30,
};

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;
let store: FakeObjectStore;
let job: QuarantineCleanupJob;

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

function cookieHeader(response: InjectedResponse): string {
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
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
    cookie: cookieHeader(response),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
  };
}

let keyCounter = 0;
const freshKey = (): string => `file003-key-${String(++keyCounter).padStart(12, '0')}`;

/** Open a session and complete it, leaving a quarantine version and DECLARED used bytes. */
async function openAndComplete(slug: string, session: Session, projectId: string): Promise<string> {
  const opened = (await app.inject({
    method: 'POST',
    url: `/v1/organizations/${slug}/upload-sessions`,
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      'idempotency-key': freshKey(),
    },
    payload: {
      projectId,
      fileName: 'brief.pdf',
      mimeType: 'application/pdf',
      sizeBytes: DECLARED,
      purpose: 'deliverable',
    },
  })) as unknown as InjectedResponse;
  if (opened.statusCode !== 201)
    throw new Error(`open failed: ${opened.statusCode} ${opened.body}`);
  const { id, fileAssetId } = opened.json<{ id: string; fileAssetId: string }>();

  const done = (await app.inject({
    method: 'POST',
    url: `/v1/organizations/${slug}/upload-sessions/${id}/complete`,
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
    },
    payload: { parts: [{ partNumber: 1, etag: 'etag-1' }] },
  })) as unknown as InjectedResponse;
  if (done.statusCode !== 202) throw new Error(`complete failed: ${done.statusCode} ${done.body}`);
  return fileAssetId;
}

interface CounterRow {
  used: number;
  reserved: number;
}

async function counterOf(organizationId: string): Promise<CounterRow> {
  const [row] = await observe(
    `select used_value as used, reserved_value as reserved
       from usage_counters where organization_id = ? and metric_key = ?`,
    [organizationId, STORAGE_BYTES_METRIC],
  );
  return { used: Number(row?.['used'] ?? 0), reserved: Number(row?.['reserved'] ?? 0) };
}

async function latestVersion(
  fileAssetId: string,
): Promise<{ id: string; objectKey: string; size: number }> {
  const [row] = await observe(
    `select id, object_key as k, size_bytes as s from file_versions
      where file_asset_id = ? order by version_no desc limit 1`,
    [fileAssetId],
  );
  return { id: String(row?.['id']), objectKey: String(row?.['k']), size: Number(row?.['s']) };
}

/**
 * Drive a completed asset to `rejected`, dated `ageDays` ago, and place its bytes in the
 * quarantine zone of the fake store so the purge has an object to delete. The counter is left
 * at DECLARED used — the whole point of FILE-003 is that a rejection does not release the bytes.
 */
async function reject(fileAssetId: string, ageDays: number): Promise<{ objectKey: string }> {
  const version = await latestVersion(fileAssetId);
  store.objects.set(`quarantine/${version.objectKey}`, Buffer.alloc(version.size, 1));
  const at = new Date(Date.now() - ageDays * DAY_MS);
  await db.admin.execute(
    `update file_assets set status = 'rejected', rejection_code = 'malware_detected',
       updated_at = ? where id = ?`,
    [at, fileAssetId],
  );
  return { objectKey: version.objectKey };
}

async function purgeAudit(organizationId: string): Promise<RowDataPacket[]> {
  return observe(
    `select object_type as t, object_id as o, actor_user_id as a, result as r, metadata_json as m
       from audit_events
      where organization_id = ? and action = 'file_asset.purged' order by id`,
    [organizationId],
  );
}

async function purgeLedger(organizationId: string): Promise<RowDataPacket[]> {
  return observe(
    `select counter as c, delta as d, reason as reason from usage_ledger_entries
      where organization_id = ? and reason = 'purged' order by id`,
    [organizationId],
  );
}

beforeAll(async () => {
  db = await startTestDatabase();
  store = new FakeObjectStore(() => DECLARED);
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
  job = app.get<QuarantineCleanupJob>(QUARANTINE_CLEANUP_JOB);
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  store.objects.clear();
  store.removed.length = 0;
  store.failNext = null;
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

describe('a rejected object past its retention window', () => {
  it('deletes the provider bytes first, then decrements, ledgers and audits (§6 step 8)', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const assetId = await openAndComplete('northstar-studio', studio, world.northstar.projectId);
    const { objectKey } = await reject(assetId, 40);

    expect((await counterOf(world.northstar.organizationId)).used).toBe(DECLARED);
    expect(store.objects.has(`quarantine/${objectKey}`)).toBe(true);

    const report = await job.cleanup();
    expect(report).toMatchObject({ purged: 1, skipped: 0, failed: 0, counterDrift: 0 });

    // Provider bytes deleted, and the counter gave the bytes back.
    expect(store.removed).toContainEqual({ zone: 'quarantine', objectKey });
    expect(store.objects.has(`quarantine/${objectKey}`)).toBe(false);
    // Reversal (delete-before-decrement): decrement in files.service.purge before store.remove
    // and a remove that throws would leave `used` at 0 with the bytes still on the provider.
    expect((await counterOf(world.northstar.organizationId)).used).toBe(0);

    const ledger = await purgeLedger(world.northstar.organizationId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.['c']).toBe('used');
    expect(Number(ledger[0]?.['d'])).toBe(-DECLARED);

    const audit = await purgeAudit(world.northstar.organizationId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.['t']).toBe('file_asset');
    expect(audit[0]?.['o']).toBe(assetId);
    expect(audit[0]?.['a']).toBeNull();
    expect(audit[0]?.['r']).toBe('allowed');
    const metadata = audit[0]?.['m'] as Record<string, unknown>;
    expect(metadata).toMatchObject({ reason: 'retention_expired', size_bytes: DECLARED });
    // The detection name is never re-stated on this row (AC3).
    expect(JSON.stringify(metadata)).not.toContain('malware');
    // The row itself is kept — only the bytes are deleted (§6: never delete customer data).
    const [assetRow] = await observe(
      `select status, purged_at as p from file_assets where id = ?`,
      [assetId],
    );
    expect(assetRow?.['status']).toBe('rejected');
    expect(assetRow?.['p']).not.toBeNull();
  });

  it('is idempotent: a second pass touches nothing and the object stays gone', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const assetId = await openAndComplete('northstar-studio', studio, world.northstar.projectId);
    const { objectKey } = await reject(assetId, 40);

    await job.cleanup();
    const afterFirst = await counterOf(world.northstar.organizationId);
    store.removed.length = 0;

    const second = await job.cleanup();
    expect(second).toMatchObject({ scanned: 0, purged: 0, failed: 0 });
    expect(store.removed).toHaveLength(0);
    expect(store.objects.has(`quarantine/${objectKey}`)).toBe(false);
    expect(await counterOf(world.northstar.organizationId)).toEqual(afterFirst);
    expect(await purgeLedger(world.northstar.organizationId)).toHaveLength(1);
    expect(await purgeAudit(world.northstar.organizationId)).toHaveLength(1);
  });
});

describe('a provider-delete failure', () => {
  it('counts failed, decrements nothing, and leaves the row for the next pass', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const assetId = await openAndComplete('northstar-studio', studio, world.northstar.projectId);
    const { objectKey } = await reject(assetId, 40);
    store.failNext = new Error('provider is down');

    const report = await job.cleanup();
    expect(report).toMatchObject({ purged: 0, failed: 1 });

    // No counter move, no ledger row, no purge audit row — the object is still on the provider.
    expect((await counterOf(world.northstar.organizationId)).used).toBe(DECLARED);
    expect(store.objects.has(`quarantine/${objectKey}`)).toBe(true);
    expect(await purgeLedger(world.northstar.organizationId)).toHaveLength(0);
    expect(await purgeAudit(world.northstar.organizationId)).toHaveLength(0);
    // The row waits: still rejected, still not purged, so the next pass takes it.
    const [row] = await observe(`select purged_at as p from file_assets where id = ?`, [assetId]);
    expect(row?.['p']).toBeNull();
  });
});

describe('the trigger is rejection status and retention age alone', () => {
  it('leaves a rejected asset inside its window and a ready asset untouched', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const fresh = await openAndComplete('northstar-studio', studio, world.northstar.projectId);
    await reject(fresh, 1); // rejected yesterday — inside the 30-day window
    const ready = await openAndComplete('northstar-studio', studio, world.northstar.projectId);
    await db.admin.execute(`update file_assets set status = 'ready' where id = ?`, [ready]);

    const report = await job.cleanup();
    expect(report).toMatchObject({ scanned: 0, purged: 0 });
    // Both organizations' used bytes are intact: two completed uploads, nothing released.
    expect((await counterOf(world.northstar.organizationId)).used).toBe(DECLARED * 2);
    expect(await purgeAudit(world.northstar.organizationId)).toHaveLength(0);
  });
});

describe('two tenants', () => {
  it('purges each object under its own context and audits each to its own organization', async () => {
    const northstar = await signIn(world.northstar.manager.id);
    const nsAsset = await openAndComplete('northstar-studio', northstar, world.northstar.projectId);
    await reject(nsAsset, 40);

    const other = await signIn(world.brightops.owner.id);
    const boAsset = await openAndComplete('brightops-consulting', other, world.brightops.projectId);
    await reject(boAsset, 40);

    const report = await job.cleanup();
    expect(report).toMatchObject({ organizations: 2, purged: 2 });

    expect((await counterOf(world.northstar.organizationId)).used).toBe(0);
    expect((await counterOf(world.brightops.organizationId)).used).toBe(0);
    const nsAudit = await purgeAudit(world.northstar.organizationId);
    const boAudit = await purgeAudit(world.brightops.organizationId);
    expect(nsAudit).toHaveLength(1);
    expect(boAudit).toHaveLength(1);
    expect(nsAudit[0]?.['o']).toBe(nsAsset);
    expect(boAudit[0]?.['o']).toBe(boAsset);
  });
});
