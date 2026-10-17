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
import { USAGE_RECONCILER } from '../src/common/http/tokens.js';
import type { UsageReconciler } from '../src/modules/files/usage-reconciler.js';
import { STORAGE_BYTES_METRIC } from '../src/modules/files/usage-counters.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * USAGE-001 slice 3 — reconciled counters, over the real API.
 *
 * UNEXECUTED in this slice: it belongs to the `database` project, which needs `db-e2e.lock`;
 * this agent does not own the lock, so the integrator runs it in the next chain. The four
 * cases are exactly the acceptance list of the brief, no more:
 *
 * 1. A drifted counter is corrected to its ledger sums, `reconciled_at` is stamped, `version`
 *    is bumped, and one `usage_counter.drift_corrected` audit row records the before/after.
 * 2. A counter that already matches its ledger has `reconciled_at` stamped (written on every
 *    run) but its values and version are left untouched and no audit row is written.
 * 3. (folded into 1 and 2) `reconciled_at` is written whether or not the counter drifted.
 * 4. Two tenants never mix — each counter is corrected to its own ledger, each audit row is
 *    its own organization's.
 *
 * The ledger is the source of truth (`49-PRICING` §6): a real completion writes the counter
 * and the ledger together, then a hand-edit of `usage_counters` alone (never the ledger)
 * stands in for the drift a repaired row or a mover bug would leave.
 */

const DECLARED = 1_000;
const ORG_LIMIT = 100_000;

const CONFIG: ApiConfig = {
  ...apiConfigFrom({
    NODE_ENV: 'test',
    ALLOW_DEV_SIGN_IN: true,
    SESSION_COOKIE_NAME: 'tmanage_session',
    SESSION_SECRET: 'local_dev_only_session_secret_for_reconcile_suite_xx',
    SESSION_TTL_SECONDS: 900,
    REFRESH_TTL_SECONDS: 1_209_600,
    CSRF_SECRET: 'local_dev_only_csrf_secret_for_reconcile_suite_xxxxxx',
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
};

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;
let store: FakeObjectStore;
let reconciler: UsageReconciler;

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
const freshKey = (): string => `reconcile-key-${String(++keyCounter).padStart(12, '0')}`;

interface UploadSession {
  id: string;
  fileAssetId: string;
}

async function openAndComplete(slug: string, session: Session, projectId: string): Promise<void> {
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
  const { id } = opened.json<UploadSession>();

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
}

interface CounterRow {
  used: number;
  reserved: number;
  version: number;
  reconciledAt: unknown;
}

async function counterOf(organizationId: string): Promise<CounterRow> {
  const [row] = await observe(
    `select used_value as used, reserved_value as reserved, version, reconciled_at as r
       from usage_counters where organization_id = ? and metric_key = ?`,
    [organizationId, STORAGE_BYTES_METRIC],
  );
  return {
    used: Number(row?.['used'] ?? 0),
    reserved: Number(row?.['reserved'] ?? 0),
    version: Number(row?.['version'] ?? 0),
    reconciledAt: row?.['r'] ?? null,
  };
}

async function driftAudit(organizationId: string): Promise<RowDataPacket[]> {
  return observe(
    `select object_type as t, object_id as o, actor_user_id as a, metadata_json as m
       from audit_events
      where organization_id = ? and action = 'usage_counter.drift_corrected' order by id`,
    [organizationId],
  );
}

/** Hand-edit the counter alone — never the ledger — to stand in for a drifted row. */
async function nudgeCounter(organizationId: string, usedDelta: number): Promise<void> {
  await db.admin.execute(
    `update usage_counters set used_value = used_value + ?
      where organization_id = ? and metric_key = ?`,
    [usedDelta, organizationId, STORAGE_BYTES_METRIC],
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
  reconciler = app.get<UsageReconciler>(USAGE_RECONCILER);
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

describe('a drifted counter', () => {
  it('is corrected to its ledger sums, stamped, version-bumped, and audited', async () => {
    const studio = await signIn(world.northstar.manager.id);
    await openAndComplete('northstar-studio', studio, world.northstar.projectId);

    const before = await counterOf(world.northstar.organizationId);
    expect(before).toMatchObject({ used: DECLARED, reserved: 0 });
    // Corrupt the counter alone: the ledger still sums to DECLARED used, 0 reserved.
    await nudgeCounter(world.northstar.organizationId, 500);
    expect((await counterOf(world.northstar.organizationId)).used).toBe(DECLARED + 500);

    const report = await reconciler.reconcile();
    expect(report).toMatchObject({ drifted: 1, failed: 0 });

    const after = await counterOf(world.northstar.organizationId);
    // Reversal: drop the `correct` call from the reconciler and `used` stays DECLARED + 500.
    expect(after).toMatchObject({ used: DECLARED, reserved: 0 });
    expect(after.reconciledAt).not.toBeNull();
    expect(after.version).toBe(before.version + 1);

    const audit = await driftAudit(world.northstar.organizationId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.['t']).toBe('usage_counter');
    // System-initiated: the actor is null, as an expiry's is.
    expect(audit[0]?.['a']).toBeNull();
    const metadata = audit[0]?.['m'] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      metric_key: STORAGE_BYTES_METRIC,
      used_before: DECLARED + 500,
      used_after: DECLARED,
      used_drift: -500,
      reserved_before: 0,
      reserved_after: 0,
      reserved_drift: 0,
    });
  });
});

describe('a counter that already matches its ledger', () => {
  it('is stamped on every run but its value, version, and audit are untouched', async () => {
    const studio = await signIn(world.northstar.manager.id);
    await openAndComplete('northstar-studio', studio, world.northstar.projectId);
    const before = await counterOf(world.northstar.organizationId);

    const report = await reconciler.reconcile();
    expect(report).toMatchObject({ counters: 1, reconciled: 1, drifted: 0, failed: 0 });

    const after = await counterOf(world.northstar.organizationId);
    // reconciled_at is written on every run (brief §b)…
    expect(after.reconciledAt).not.toBeNull();
    // …but nothing about the value moved, so version does not advance.
    expect(after.used).toBe(before.used);
    expect(after.reserved).toBe(before.reserved);
    expect(after.version).toBe(before.version);
    // A clean reconcile writes no drift audit row.
    expect(await driftAudit(world.northstar.organizationId)).toHaveLength(0);
  });
});

describe('two tenants', () => {
  it('never mix — each counter is corrected to its own ledger, each audit is its own', async () => {
    const northstar = await signIn(world.northstar.manager.id);
    const brightops = await signIn(world.brightops.owner.id);
    await openAndComplete('northstar-studio', northstar, world.northstar.projectId);
    await openAndComplete('brightops-consulting', brightops, world.brightops.projectId);

    // Both drift, by different amounts, so a cross-tenant correction would be visible.
    await nudgeCounter(world.northstar.organizationId, 700);
    await nudgeCounter(world.brightops.organizationId, 250);

    const report = await reconciler.reconcile();
    expect(report).toMatchObject({ drifted: 2, failed: 0 });

    expect((await counterOf(world.northstar.organizationId)).used).toBe(DECLARED);
    expect((await counterOf(world.brightops.organizationId)).used).toBe(DECLARED);

    const theirs = await driftAudit(world.northstar.organizationId);
    const ours = await driftAudit(world.brightops.organizationId);
    expect(theirs).toHaveLength(1);
    expect(ours).toHaveLength(1);
    expect((theirs[0]?.['m'] as Record<string, unknown>)['used_drift']).toBe(-700);
    expect((ours[0]?.['m'] as Record<string, unknown>)['used_drift']).toBe(-250);
  });
});
