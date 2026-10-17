import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { FakeObjectStore } from '@tmanage/storage';
import { uuidv7 } from '@tmanage/domain';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { StorageModule } from '../src/common/storage/storage.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import {
  TENANT_DATABASE,
  UPLOAD_SESSION_SWEEPER,
  USAGE_LEDGER_REPOSITORY,
} from '../src/common/http/tokens.js';
import type { TenantDatabase } from '../src/common/database/tenant-context.js';
import type { UploadSessionSweeper } from '../src/modules/files/upload-session-sweeper.js';
import { sweeperContextFor } from '../src/modules/files/upload-session-sweeper.js';
import type { UsageLedgerRepository } from '../src/modules/files/usage-ledger.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * USAGE-001 slice 2 — the append-only storage usage ledger, over the real API.
 *
 * UNEXECUTED in this slice: it belongs to the `database` project, which needs `db-e2e.lock`;
 * this agent does not own the lock, so the integrator runs it in the next chain. The five
 * cases are exactly the acceptance list of the brief, no more:
 *
 * 1. One immutable ledger row per counter move, joined to its producing outbox row.
 * 2. The ledger sums to the counter after a mixed sequence including an expiry.
 * 3. A replayed idempotency key inserts nothing and does not throw.
 * 4. The app credential can INSERT and SELECT but never UPDATE or DELETE a row.
 * 5. Two tenants never mix — each ledger row is its own organization's.
 */

const DECLARED = 1_000;
const ORG_LIMIT = 100_000;
const A_DAY = 86_400;

const CONFIG: ApiConfig = {
  ...apiConfigFrom({
    NODE_ENV: 'test',
    ALLOW_DEV_SIGN_IN: true,
    SESSION_COOKIE_NAME: 'tmanage_session',
    SESSION_SECRET: 'local_dev_only_session_secret_for_the_ledger_suite_xxxx',
    SESSION_TTL_SECONDS: 900,
    REFRESH_TTL_SECONDS: 1_209_600,
    CSRF_SECRET: 'local_dev_only_csrf_secret_for_the_ledger_suite_xxxxxxx',
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
let sweeper: UploadSessionSweeper;

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
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
      ...headers,
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

let keyCounter = 0;
const freshKey = (): string => `ledger-key-${String(++keyCounter).padStart(12, '0')}`;

interface UploadSession {
  id: string;
  fileAssetId: string;
}

async function open(slug: string, session: Session, projectId: string): Promise<UploadSession> {
  const response = await send(
    slug,
    'POST',
    '/upload-sessions',
    session,
    {
      projectId,
      fileName: 'brief.pdf',
      mimeType: 'application/pdf',
      sizeBytes: DECLARED,
      purpose: 'deliverable',
    },
    { 'idempotency-key': freshKey() },
  );
  if (response.statusCode !== 201)
    throw new Error(`open failed: ${response.statusCode} ${response.body}`);
  return response.json<UploadSession>();
}

const openNorthstar = (session: Session) =>
  open('northstar-studio', session, world.northstar.projectId);

async function complete(id: string, session: Session): Promise<void> {
  const done = await send('northstar-studio', 'POST', `/upload-sessions/${id}/complete`, session, {
    parts: [{ partNumber: 1, etag: 'etag-1' }],
  });
  if (done.statusCode !== 202) throw new Error(`complete failed: ${done.statusCode} ${done.body}`);
}

async function age(id: string, seconds: number): Promise<void> {
  await db.admin.execute(
    'update upload_sessions set expires_at = date_sub(expires_at, interval ? second) where id = ?',
    [seconds, id],
  );
}

interface LedgerRow {
  counter: string;
  delta: number;
  reason: string;
  idempotencyKey: string;
  sourceEventId: string;
  organizationId: string;
}

async function ledgerFor(organizationId: string): Promise<LedgerRow[]> {
  const rows = await observe(
    `select counter, delta, reason, idempotency_key as k, source_event_id as s, organization_id as o
       from usage_ledger_entries where organization_id = ? order by id`,
    [organizationId],
  );
  return rows.map((r) => ({
    counter: String(r['counter']),
    delta: Number(r['delta']),
    reason: String(r['reason']),
    idempotencyKey: String(r['k']),
    sourceEventId: String(r['s']),
    organizationId: String(r['o']),
  }));
}

async function counter(organizationId: string): Promise<{ used: number; reserved: number }> {
  const [row] = await observe(
    'select used_value as used, reserved_value as reserved from usage_counters where organization_id = ?',
    [organizationId],
  );
  return { used: Number(row?.['used'] ?? 0), reserved: Number(row?.['reserved'] ?? 0) };
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
  sweeper = app.get<UploadSessionSweeper>(UPLOAD_SESSION_SWEEPER);
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

describe('one row per counter move, joined to its outbox row', () => {
  it('writes a reserved row on open and a used+reserved pair on completion, each citing its event', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const session = await openNorthstar(studio);

    let rows = await ledgerFor(world.northstar.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ counter: 'reserved', delta: DECLARED, reason: 'reserve' });
    expect(rows[0]!.idempotencyKey).toBe(`${session.id}:reserve`);
    // The cited event exists, is this session's reservation, and is this tenant's.
    const reservedEvent = await observe(
      `select type from outbox_events where organization_id = ? and id = ?`,
      [world.northstar.organizationId, rows[0]!.sourceEventId],
    );
    expect(reservedEvent[0]?.['type']).toBe('usage.storage_reserved.v1');

    await complete(session.id, studio);

    rows = await ledgerFor(world.northstar.organizationId);
    expect(rows).toHaveLength(3);
    // Completion appends two rows in one transaction — the reservation retired and the used
    // bytes added — each its own row citing the one committed event. Their relative order has
    // no business meaning: production reads the ledger only through the per-counter SUM
    // (`UsageLedgerRepository.sumByCounter`), and the ordering key `usage_ledger_entries.id`
    // (UUIDv7) is monotonic only across milliseconds, so two rows written in the same
    // millisecond have no defined `order by id`. Assert the pair as a set — both rows present
    // with the right counter/delta/reason/idempotency key — rather than as a sequence.
    const committed = rows.slice(1);
    const release = committed.find((r) => r.reason === 'commit_release');
    const commit = committed.find((r) => r.reason === 'commit');
    expect(release).toMatchObject({
      counter: 'reserved',
      delta: -DECLARED,
      reason: 'commit_release',
    });
    expect(release!.idempotencyKey).toBe(`${session.id}:commit_release`);
    expect(commit).toMatchObject({ counter: 'used', delta: DECLARED, reason: 'commit' });
    expect(commit!.idempotencyKey).toBe(`${session.id}:commit`);
    // Both completion rows cite the one committed event, and it is joinable in-tenant.
    expect(release!.sourceEventId).toBe(commit!.sourceEventId);
    const committedEvent = await observe(
      `select type from outbox_events where organization_id = ? and id = ?`,
      [world.northstar.organizationId, release!.sourceEventId],
    );
    expect(committedEvent[0]?.['type']).toBe('usage.storage_committed.v1');
  });
});

describe('the ledger sums to the counter', () => {
  it('after a mixed sequence of a completion and an expiry', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const completed = await openNorthstar(studio);
    await complete(completed.id, studio);
    const expiring = await openNorthstar(studio);
    await age(expiring.id, A_DAY);

    const report = await sweeper.sweep();
    expect(report).toMatchObject({ released: 1, failed: 0, counterDrift: 0 });

    const rows = await ledgerFor(world.northstar.organizationId);
    const sumOf = (c: string): number =>
      rows.filter((r) => r.counter === c).reduce((total, r) => total + r.delta, 0);
    const live = await counter(world.northstar.organizationId);
    // Reversal: drop the ledger write from `releaseInTransaction` and the reserved sum is
    // DECLARED while the counter is 0.
    expect({ used: sumOf('used'), reserved: sumOf('reserved') }).toEqual(live);
    expect(live).toEqual({ used: DECLARED, reserved: 0 });
    // The expiry recorded its own reason on the giving-back row.
    expect(rows.some((r) => r.reason === 'expired' && r.delta === -DECLARED)).toBe(true);
  });
});

describe('a replayed idempotency key', () => {
  it('inserts nothing and does not throw', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const session = await openNorthstar(studio);
    const [existing] = await ledgerFor(world.northstar.organizationId);
    expect(existing).toBeDefined();

    const database = app.get<TenantDatabase>(TENANT_DATABASE);
    const ledger = app.get<UsageLedgerRepository>(USAGE_LEDGER_REPOSITORY);
    const context = sweeperContextFor(world.northstar.organizationId, uuidv7());
    // The same (uploadSessionId, reason) for this tenant — a replay of the reserve move.
    await database.transaction(context, (tx) =>
      ledger.record(tx, context, {
        uploadSessionId: session.id,
        counter: 'reserved',
        deltaBytes: DECLARED,
        reason: 'reserve',
        sourceEventId: existing!.sourceEventId,
      }),
    );

    const rows = await ledgerFor(world.northstar.organizationId);
    expect(rows.filter((r) => r.idempotencyKey === `${session.id}:reserve`)).toHaveLength(1);
  });
});

describe('the runtime credential', () => {
  it('may append and read but can never UPDATE or DELETE a ledger row', async () => {
    const studio = await signIn(world.northstar.manager.id);
    await openNorthstar(studio);
    const [row] = await observe('select id from usage_ledger_entries limit 1');
    const id = String(row?.['id']);
    expect(id).toBeTruthy();

    // Only decisive when the runtime pool holds the least-privilege credential; on a machine
    // running the whole suite as admin the grant is not exercised (memory: DB suite runs as
    // admin locally). The `grant-reconciliation` suite proves the same 1142 shape.
    if (!db.leastPrivilege) return;

    let update: { errno?: number } | undefined;
    try {
      await db.runtime.execute('update usage_ledger_entries set delta = 0 where id = ?', [id]);
    } catch (error) {
      update = error as { errno?: number };
    }
    expect(update?.errno, 'the app credential could UPDATE a ledger row').toBe(1142);

    let remove: { errno?: number } | undefined;
    try {
      await db.runtime.execute('delete from usage_ledger_entries where id = ?', [id]);
    } catch (error) {
      remove = error as { errno?: number };
    }
    expect(remove?.errno, 'the app credential could DELETE a ledger row').toBe(1142);
  });
});

describe('two tenants', () => {
  it('never mix — each ledger row is its own organization’s', async () => {
    const northstar = await signIn(world.northstar.manager.id);
    const brightops = await signIn(world.brightops.owner.id);
    await openNorthstar(northstar);
    await open('brightops-consulting', brightops, world.brightops.projectId);

    const theirs = await ledgerFor(world.northstar.organizationId);
    const ours = await ledgerFor(world.brightops.organizationId);
    expect(theirs).toHaveLength(1);
    expect(ours).toHaveLength(1);
    expect(theirs.every((r) => r.organizationId === world.northstar.organizationId)).toBe(true);
    expect(ours.every((r) => r.organizationId === world.brightops.organizationId)).toBe(true);
    // Every source event a row cites belongs to the row's own tenant (the composite FK).
    const foreign = await observe(
      `select count(*) as n from usage_ledger_entries l
         left join outbox_events e
           on e.organization_id = l.organization_id and e.id = l.source_event_id
        where e.id is null`,
    );
    expect(Number(foreign[0]?.['n'])).toBe(0);
  });
});
