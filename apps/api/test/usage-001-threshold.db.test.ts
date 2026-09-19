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
 * USAGE-001 slice 4 — threshold bands with hysteresis, over the real API.
 *
 * UNEXECUTED in this slice: it belongs to the `database` project, which needs `db-e2e.lock`;
 * this agent (x63) does not own the lock (x62 holds it and runs mysqld), so the integrator runs
 * it in the next chain. The four cases are exactly the acceptance list of the brief, no more:
 *
 * 1. A reserve that crosses 70% emits ONE `usage.threshold_reached.v1` (band 70) and stores the
 *    band on the counter row.
 * 2. A reconcile over the unchanged counter emits nothing (replay): the stored band is the
 *    idempotency gate.
 * 3. A cancel (release) then a reconcile drops the band below the 5-point hysteresis floor
 *    without emitting; a new reserve then crosses 70% again and emits a second event (re-arm).
 * 4. Tenant isolation: each organization's crossing is its own event, and an organization that
 *    stayed below 70% has none.
 *
 * The quota is small (`ORG_LIMIT`) so a single reservation crosses a real band. Only the reserve
 * path is exercised for the crossing; completion would keep used + reserved in the same band, so
 * it would not emit a second event — the "once" the first case asserts.
 */

const ORG_LIMIT = 1_000;
/** 72% of the quota in one reservation: over the 70 boundary, under the 85 one. */
const RESERVE = 720;

const CONFIG: ApiConfig = {
  ...apiConfigFrom({
    NODE_ENV: 'test',
    SESSION_COOKIE_NAME: 'tmanage_session',
    SESSION_SECRET: 'local_dev_only_session_secret_for_threshold_suite_x',
    SESSION_TTL_SECONDS: 900,
    REFRESH_TTL_SECONDS: 1_209_600,
    CSRF_SECRET: 'local_dev_only_csrf_secret_for_threshold_suite_xxxxx',
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
const freshKey = (): string => `threshold-key-${String(++keyCounter).padStart(12, '0')}`;

/** Open (reserve) a session of `sizeBytes` and return its id; never completed, so it stays reserved. */
async function reserveOnly(
  slug: string,
  session: Session,
  projectId: string,
  sizeBytes: number,
): Promise<string> {
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
      sizeBytes,
      purpose: 'deliverable',
    },
  })) as unknown as InjectedResponse;
  if (opened.statusCode !== 201)
    throw new Error(`open failed: ${opened.statusCode} ${opened.body}`);
  return opened.json<{ id: string }>().id;
}

async function cancelUpload(slug: string, session: Session, id: string): Promise<void> {
  const done = (await app.inject({
    method: 'POST',
    url: `/v1/organizations/${slug}/upload-sessions/${id}/cancel`,
    // No `content-type: application/json`: cancel carries no body, and declaring a JSON
    // content type with an empty body makes Fastify reject the request with a 400 before the
    // handler runs (FST_ERR_CTP_EMPTY_JSON_BODY). Mirrors the bodyless-POST wiring in
    // file-001-upload-sessions' `sendTo`.
    headers: {
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
    },
  })) as unknown as InjectedResponse;
  if (done.statusCode !== 200) throw new Error(`cancel failed: ${done.statusCode} ${done.body}`);
}

interface ThresholdEvent {
  band: number;
  used: number;
  reserved: number;
  quota: number;
  idempotencyKey: string;
}

async function thresholdEvents(organizationId: string): Promise<ThresholdEvent[]> {
  const rows = await observe(
    `select payload_json as p from outbox_events
      where organization_id = ? and type = 'usage.threshold_reached.v1' order by id`,
    [organizationId],
  );
  return rows.map((row) => {
    const payload = row['p'] as Record<string, unknown>;
    return {
      band: Number(payload['band']),
      used: Number(payload['used']),
      reserved: Number(payload['reserved']),
      quota: Number(payload['quota']),
      idempotencyKey: String(payload['idempotencyKey']),
    };
  });
}

async function bandOf(organizationId: string): Promise<number> {
  const [row] = await observe(
    `select threshold_band as b from usage_counters where organization_id = ? and metric_key = ?`,
    [organizationId, STORAGE_BYTES_METRIC],
  );
  return Number(row?.['b'] ?? 0);
}

async function thresholdAudit(organizationId: string): Promise<RowDataPacket[]> {
  return observe(
    `select actor_user_id as a, metadata_json as m from audit_events
      where organization_id = ? and action = 'usage.threshold_reached' order by id`,
    [organizationId],
  );
}

beforeAll(async () => {
  db = await startTestDatabase();
  store = new FakeObjectStore(() => RESERVE);
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

describe('a reserve that crosses a band', () => {
  it('emits exactly one threshold event and stores the band', async () => {
    const studio = await signIn(world.northstar.manager.id);
    await reserveOnly('northstar-studio', studio, world.northstar.projectId, RESERVE);

    const events = await thresholdEvents(world.northstar.organizationId);
    // Reversal: drop the `thresholds.evaluate` call from the reserve path and this is length 0.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ band: 70, used: 0, reserved: RESERVE, quota: ORG_LIMIT });
    expect(await bandOf(world.northstar.organizationId)).toBe(70);
    // 70 is not the 100 band, so no audit row.
    expect(await thresholdAudit(world.northstar.organizationId)).toHaveLength(0);
  });
});

describe('a reconcile over an unchanged counter', () => {
  it('emits nothing — the stored band is the idempotency gate (replay)', async () => {
    const studio = await signIn(world.northstar.manager.id);
    await reserveOnly('northstar-studio', studio, world.northstar.projectId, RESERVE);
    expect(await thresholdEvents(world.northstar.organizationId)).toHaveLength(1);

    await reconciler.reconcile();

    // Still one — the band did not move, so nothing re-fired.
    expect(await thresholdEvents(world.northstar.organizationId)).toHaveLength(1);
    expect(await bandOf(world.northstar.organizationId)).toBe(70);
  });
});

describe('a fall below the hysteresis floor then a fresh rise', () => {
  it('drops the band without emitting, then re-arms and emits again', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const first = await reserveOnly('northstar-studio', studio, world.northstar.projectId, RESERVE);
    expect(await thresholdEvents(world.northstar.organizationId)).toHaveLength(1);

    // Release the whole reservation: used + reserved → 0, far below 70 - 5. Cancel does not
    // re-evaluate the band (only reserve/commit/reconcile do), so the reconcile pass is what
    // formally lowers it.
    await cancelUpload('northstar-studio', studio, first);
    await reconciler.reconcile();
    expect(await bandOf(world.northstar.organizationId)).toBe(0);
    // A fall emits nothing.
    expect(await thresholdEvents(world.northstar.organizationId)).toHaveLength(1);

    // A fresh reservation crosses 70 again — the re-arm the hysteresis exists for.
    await reserveOnly('northstar-studio', studio, world.northstar.projectId, RESERVE);
    const events = await thresholdEvents(world.northstar.organizationId);
    expect(events).toHaveLength(2);
    expect(events[1]?.band).toBe(70);
    // The second crossing carries a different idempotency key (a later counter version).
    expect(events[1]?.idempotencyKey).not.toBe(events[0]?.idempotencyKey);
  });
});

describe('two tenants', () => {
  it('each crossing is its own; an organization below 70% has none', async () => {
    const northstar = await signIn(world.northstar.manager.id);
    const brightops = await signIn(world.brightops.owner.id);
    await reserveOnly('northstar-studio', northstar, world.northstar.projectId, RESERVE);
    await reserveOnly('brightops-consulting', brightops, world.brightops.projectId, RESERVE);
    // The twin stays well under 70%: 100 / 1000 = 10%.
    const twin = await signIn(world.twin.owner.id);
    await reserveOnly('northstar-studios', twin, world.twin.projectId, 100);

    const theirs = await thresholdEvents(world.northstar.organizationId);
    const ours = await thresholdEvents(world.brightops.organizationId);
    const twins = await thresholdEvents(world.twin.organizationId);
    expect(theirs).toHaveLength(1);
    expect(ours).toHaveLength(1);
    expect(twins).toHaveLength(0);
    expect(await bandOf(world.twin.organizationId)).toBe(0);
  });
});
