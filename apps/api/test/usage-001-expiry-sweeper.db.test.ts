import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { FakeObjectStore } from '@tmanage/storage';
import type { AbortMultipartInput } from '@tmanage/storage';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/common/database/database.module.js';
import { StorageModule } from '../src/common/storage/storage.module.js';
import { apiConfigFrom } from '../src/common/http/api-config.js';
import type { ApiConfig } from '../src/common/http/api-config.js';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { uuidv7 } from '@tmanage/domain';
import {
  FILES_SERVICE,
  TENANT_DATABASE,
  UPLOAD_SESSIONS_REPOSITORY,
  UPLOAD_SESSION_SWEEPER,
} from '../src/common/http/tokens.js';
import type { TenantDatabase } from '../src/common/database/tenant-context.js';
import type { FilesService } from '../src/modules/files/files.service.js';
import type { UploadSessionsRepository } from '../src/modules/files/upload-sessions.repository.js';
import { sweeperContextFor, STALE_CLAIM_MS } from '../src/modules/files/upload-session-sweeper.js';
import type { UploadSessionSweeper } from '../src/modules/files/upload-session-sweeper.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * USAGE-001, slice 1 — the expiry sweeper, over the real API and a fake object store.
 *
 * Sessions are opened through the studio door exactly as the FILE-001 suite opens them,
 * then aged by moving `expires_at` with the admin credential (0016's trigger permits it:
 * a lifetime is not identity). The sweeper under test is the one `FilesModule` wired —
 * the instance `sweep.ts` would resolve — so what a pass does here is what a cron tick's
 * pass does.
 *
 * What only this suite proves:
 *
 * 1. **A pass takes the abandoned and leaves the live.** Past the cutoff: `expired`, the
 *    bytes back on the counter, the asset `expired`, one `usage.storage_released.v1`
 *    with cause `expired`, one audit row with no actor. Inside the lifetime, or inside
 *    the grace: untouched.
 * 2. **A pass is idempotent.** The second one scans nothing and moves nothing (QUOTA-02's
 *    expiry half).
 * 3. **The row is the gate.** A session cancelled between the sweeper's select and its
 *    release is skipped, and its bytes come back exactly once.
 * 4. **The abort is best-effort.** A provider that refuses to abandon the upload does not
 *    keep the reservation alive; the audit row says the abort failed.
 * 5. **Tenants do not mix.** Two organizations in one pass, each its own counter, each its
 *    own audit trail (QUOTA-03's adjacency).
 * 6. **Drift is recorded, not fatal.** A counter that refuses the release still lets the
 *    session expire, and the audit row says `counter_drift` (USAGE-001 decision 3).
 */

/**
 * The fake, with a hook on `abortMultipart`: the one place the sweeper yields between
 * selecting a row and moving it, which is where a racing cancel has to be injected. The
 * fake in `packages/storage` has a throw-once flag and no callback; the subclass is the
 * suite's, not the package's.
 */
class HookedObjectStore extends FakeObjectStore {
  onAbort: ((input: AbortMultipartInput) => Promise<void>) | null = null;

  override async abortMultipart(input: AbortMultipartInput): Promise<void> {
    const hook = this.onAbort;
    this.onAbort = null; // Once: the injected cancel aborts too, and must not re-enter.
    if (hook) await hook(input);
    await super.abortMultipart(input);
  }
}

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;
let store: HookedObjectStore;
let sweeper: UploadSessionSweeper;

const DECLARED = 1_000;
const ORG_LIMIT = 10_000;

const CONFIG: ApiConfig = {
  ...apiConfigFrom({
    NODE_ENV: 'test',
    ALLOW_DEV_SIGN_IN: true,
    SESSION_COOKIE_NAME: 'tmanage_session',
    SESSION_SECRET: 'local_dev_only_session_secret_for_the_sweeper_suite_xxx',
    SESSION_TTL_SECONDS: 900,
    REFRESH_TTL_SECONDS: 1_209_600,
    CSRF_SECRET: 'local_dev_only_csrf_secret_for_the_sweeper_suite_xxxxxx',
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

interface UploadSession {
  id: string;
  fileAssetId: string;
  status: string;
  reservedBytes: number;
}

let keyCounter = 0;
const freshKey = (): string => `sweep-key-${String(++keyCounter).padStart(12, '0')}`;

/** Open a session as a studio member — the ordinary reservation every case starts from. */
async function open(
  slug: string,
  session: Session,
  projectId: string,
  sizeBytes = DECLARED,
): Promise<UploadSession> {
  const response = await send(
    slug,
    'POST',
    '/upload-sessions',
    session,
    {
      projectId,
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

const openNorthstar = (session: Session, sizeBytes = DECLARED) =>
  open('northstar-studio', session, world.northstar.projectId, sizeBytes);

/** Move a session's `expires_at` into the past by `seconds` — what "abandoned" means here. */
async function age(uploadSessionId: string, seconds: number): Promise<void> {
  await db.admin.execute(
    'update upload_sessions set expires_at = date_sub(expires_at, interval ? second) where id = ?',
    [seconds, uploadSessionId],
  );
}

/** Past the session's whole lifetime and the sweeper's grace, with a day to spare. */
const A_DAY = 86_400;

/**
 * Put a session under a claim, as a completion does before it asks the provider, and
 * date the claim: `updated_at` is what marks a claim stale (migration 0017's header).
 * `ON UPDATE CURRENT_TIMESTAMP(3)` would restamp it, so the column is set in the same
 * statement — and set from a bound `Date`, not the admin connection's `current_timestamp`:
 * the application pool pins its session to `+00:00` and stamps `updated_at` in UTC, which
 * is what the sweeper's host clock is compared against; the admin pool's server clock is
 * `SYSTEM`, and a value stamped from it is hours off on this machine.
 */
async function claim(uploadSessionId: string, ageSeconds: number): Promise<void> {
  await db.admin.execute(
    "update upload_sessions set status = 'completing', updated_at = ? where id = ?",
    [new Date(Date.now() - ageSeconds * 1_000), uploadSessionId],
  );
}

async function counter(organizationId: string): Promise<{ used: number; reserved: number }> {
  const [row] = await observe(
    'select used_value as used, reserved_value as reserved from usage_counters where organization_id = ?',
    [organizationId],
  );
  return { used: Number(row?.['used'] ?? 0), reserved: Number(row?.['reserved'] ?? 0) };
}

async function statusOf(uploadSessionId: string): Promise<{ session: string; asset: string }> {
  const [row] = await observe(
    `select s.status as session, a.status as asset
       from upload_sessions s join file_assets a on a.id = s.file_asset_id
      where s.id = ?`,
    [uploadSessionId],
  );
  return { session: String(row?.['session']), asset: String(row?.['asset']) };
}

async function releasedEvents(uploadSessionId: string): Promise<{ cause: string }[]> {
  const rows = await observe(
    `select payload_json as p from outbox_events
      where aggregate_id = ? and type = 'usage.storage_released.v1' order by id`,
    [uploadSessionId],
  );
  return rows.map((r) => {
    const raw = r['p'];
    const payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { cause: string };
    return { cause: payload.cause };
  });
}

interface ExpiryAudit {
  readonly actor: string | null;
  readonly organizationId: string;
  readonly metadata: Record<string, unknown>;
}

async function expiryAudits(uploadSessionId?: string): Promise<ExpiryAudit[]> {
  const rows = await observe(
    `select actor_user_id as actor, organization_id as org, metadata_json as m
       from audit_events where action = 'upload_session.expired'
        ${uploadSessionId ? 'and object_id = ?' : ''} order by id`,
    uploadSessionId ? [uploadSessionId] : [],
  );
  return rows.map((r) => {
    const raw = r['m'];
    return {
      actor: r['actor'] === null ? null : String(r['actor']),
      organizationId: String(r['org']),
      metadata: (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>,
    };
  });
}

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
  sweeper = app.get<UploadSessionSweeper>(UPLOAD_SESSION_SWEEPER);
}, 300_000);

beforeEach(async () => {
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  store.began.length = 0;
  store.completed.length = 0;
  store.aborted.length = 0;
  store.sizeFor.clear();
  store.failNext = null;
  store.failNextAbort = null;
  store.onAbort = null;
});

afterAll(async () => {
  await app?.close();
  await db?.stop();
});

describe('one pass over abandoned reservations', () => {
  it('releases exactly the sessions past the cutoff and none of the live ones', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const abandoned = [
      await openNorthstar(studio, 1_000),
      await openNorthstar(studio, 1_500),
      await openNorthstar(studio, 2_000),
    ];
    const live = [await openNorthstar(studio, 700), await openNorthstar(studio, 800)];
    for (const session of abandoned) await age(session.id, A_DAY);
    // Past `expires_at` by half a minute — inside the sweeper's grace, so still the
    // client's to finish. Reversal: drop the grace from `sweepCutoff` and this one is taken.
    await age(live[1]!.id, 900 + 30);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 6_000 });

    const report = await sweeper.sweep();

    expect(report).toMatchObject({
      organizations: 1,
      scanned: 3,
      released: 3,
      skipped: 0,
      failed: 0,
      counterDrift: 0,
    });
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 1_500 });
    for (const session of abandoned) {
      expect(await statusOf(session.id)).toEqual({ session: 'expired', asset: 'expired' });
      expect(await releasedEvents(session.id)).toEqual([{ cause: 'expired' }]);
      const [audit] = await expiryAudits(session.id);
      expect(audit).toBeDefined();
      expect(audit!.actor).toBeNull();
      expect(audit!.organizationId).toBe(world.northstar.organizationId);
      expect(audit!.metadata).toMatchObject({
        project_id: world.northstar.projectId,
        purpose: 'deliverable',
        declared_bytes: session.reservedBytes,
        opened_by_user_id: world.northstar.manager.id,
        counter_drift: false,
        abort_failed: false,
      });
    }
    for (const session of live) {
      expect(await statusOf(session.id)).toEqual({ session: 'reserved', asset: 'created' });
      expect(await releasedEvents(session.id)).toEqual([]);
    }
    // One provider abort per expired session and none for the live ones.
    expect(store.aborted).toHaveLength(3);
  });

  it('a second pass scans nothing and moves no counter', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const session = await openNorthstar(studio);
    await age(session.id, A_DAY);

    const first = await sweeper.sweep();
    const second = await sweeper.sweep();

    expect(first).toMatchObject({ scanned: 1, released: 1 });
    expect(second).toMatchObject({ organizations: 0, scanned: 0, released: 0, skipped: 0 });
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
    expect(await releasedEvents(session.id)).toHaveLength(1);
    expect(await expiryAudits(session.id)).toHaveLength(1);
  });

  it('a session cancelled between select and release is skipped, and its bytes come back once', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const session = await openNorthstar(studio);
    await age(session.id, A_DAY);
    // The sweeper has selected the row and is asking the provider to abandon the upload
    // when the opener cancels. The cancel wins the row; the sweeper must find it gone.
    store.onAbort = async () => {
      const cancelled = await send(
        'northstar-studio',
        'POST',
        `/upload-sessions/${session.id}/cancel`,
        studio,
      );
      expect(cancelled.statusCode).toBe(200);
    };

    const report = await sweeper.sweep();

    expect(report).toMatchObject({ scanned: 1, released: 0, skipped: 1, failed: 0 });
    expect(await statusOf(session.id)).toEqual({ session: 'cancelled', asset: 'cancelled' });
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
    expect(await releasedEvents(session.id)).toEqual([{ cause: 'cancelled' }]);
    expect(await expiryAudits(session.id)).toEqual([]);
    // Two aborts reached the fake — the cancel's and the sweeper's — and one release.
    expect(store.aborted).toHaveLength(2);
  });

  it('a provider that refuses the abort still gets the bytes released, and the row says so', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const session = await openNorthstar(studio);
    await age(session.id, A_DAY);
    store.failNextAbort = new Error('the provider will not abandon this upload');

    const report = await sweeper.sweep();

    // Reversal: make the sweeper's abort `required` and this pass reports `failed 1`
    // with the session still `reserved`.
    expect(report).toMatchObject({ scanned: 1, released: 1, skipped: 0, failed: 0 });
    expect(await statusOf(session.id)).toEqual({ session: 'expired', asset: 'expired' });
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
    expect(store.aborted).toHaveLength(0);
    const [audit] = await expiryAudits(session.id);
    // The handle travels with the failure, so the upload the provider still holds can be
    // found. Reversal: leave it off and the row says only that something is out there.
    expect(audit?.metadata).toMatchObject({
      abort_failed: true,
      counter_drift: false,
      provider_upload_id: expect.stringMatching(/^fake-upload-\d+$/) as unknown as string,
    });
  });
});

describe('a claim (migration 0017)', () => {
  it('is not selected while it is fresh, even past the reservation’s expiry, and nothing touches it', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const session = await openNorthstar(studio);
    await age(session.id, A_DAY);
    await claim(session.id, 60);

    const report = await sweeper.sweep();

    // Reversal: select `completing` beside `reserved` in `listExpired` and the row is
    // expired under a completion that may be assembling the object at the provider.
    expect(report).toMatchObject({ organizations: 0, scanned: 0, released: 0, reclaimed: 0 });
    expect(await statusOf(session.id)).toEqual({ session: 'completing', asset: 'created' });
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: DECLARED });
    expect(store.aborted).toHaveLength(0);
    expect(await expiryAudits(session.id)).toEqual([]);
  });

  it('is reclaimed once it is stale, and then expired in the same pass when its reservation is also past the cutoff', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const stale = await openNorthstar(studio);
    await age(stale.id, A_DAY);
    await claim(stale.id, STALE_CLAIM_MS / 1_000 + 60);
    // A stale claim whose reservation is still inside its lifetime: reclaimed, not expired.
    const live = await openNorthstar(studio);
    await claim(live.id, STALE_CLAIM_MS / 1_000 + 60);

    const report = await sweeper.sweep();

    // Reversal: drop the reclaim from the pass (or its organization from the scan) and
    // both rows are `completing` for ever, the bytes held, the opener's slots taken.
    expect(report).toMatchObject({
      organizations: 1,
      reclaimed: 2,
      scanned: 1,
      released: 1,
      skipped: 0,
      failed: 0,
    });
    expect(await statusOf(stale.id)).toEqual({ session: 'expired', asset: 'expired' });
    expect(await statusOf(live.id)).toEqual({ session: 'reserved', asset: 'created' });
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: DECLARED });
    expect(await releasedEvents(stale.id)).toEqual([{ cause: 'expired' }]);
    expect(await expiryAudits(live.id)).toEqual([]);
    // The reclaimed live row completes as any reserved one does — the claim is taken again.
    const done = await send(
      'northstar-studio',
      'POST',
      `/upload-sessions/${live.id}/complete`,
      studio,
      {
        parts: [{ partNumber: 1, etag: 'etag-1' }],
      },
    );
    expect(done.statusCode, done.body).toBe(202);
    expect(await counter(world.northstar.organizationId)).toEqual({ used: DECLARED, reserved: 0 });
  });
});

describe('QUOTA-03: two organizations in one pass', () => {
  it('charges each tenant its own counter and writes each its own audit row', async () => {
    const northstar = await signIn(world.northstar.manager.id);
    const brightops = await signIn(world.brightops.owner.id);
    const theirs = await openNorthstar(northstar, 1_000);
    const ours = await open('brightops-consulting', brightops, world.brightops.projectId, 2_000);
    const theirLive = await openNorthstar(northstar, 500);
    await age(theirs.id, A_DAY);
    await age(ours.id, A_DAY);

    const report = await sweeper.sweep();

    expect(report).toMatchObject({ organizations: 2, scanned: 2, released: 2, failed: 0 });
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 500 });
    expect(await counter(world.brightops.organizationId)).toEqual({ used: 0, reserved: 0 });
    expect(await statusOf(theirLive.id)).toEqual({ session: 'reserved', asset: 'created' });
    const audits = await expiryAudits();
    expect(audits.map((a) => a.organizationId).sort()).toEqual(
      [world.northstar.organizationId, world.brightops.organizationId].sort(),
    );
    expect(audits.every((a) => a.actor === null)).toBe(true);
  });
});

describe('a drifted counter', () => {
  it('is recorded on the audit row, and the session still expires', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const session = await openNorthstar(studio);
    await age(session.id, A_DAY);
    // The counter says nothing is outstanding — a hand-edited or repaired row. The
    // release guard (`reserved_value >= ?`) refuses; the sweeper records that and goes on.
    await db.admin.execute(
      'update usage_counters set reserved_value = 0 where organization_id = ?',
      [world.northstar.organizationId],
    );

    const report = await sweeper.sweep();

    // Reversal: discard `counters.release`'s answer again and `counter_drift` reads false.
    expect(report).toMatchObject({ released: 1, failed: 0, counterDrift: 1 });
    expect(await statusOf(session.id)).toEqual({ session: 'expired', asset: 'expired' });
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: 0 });
    const [audit] = await expiryAudits(session.id);
    expect(audit?.metadata).toMatchObject({ counter_drift: true });
  });
});

describe('the release door is bound to its context', () => {
  it('refuses a row from another organization before the provider is asked', async () => {
    const studio = await signIn(world.northstar.manager.id);
    const session = await openNorthstar(studio);
    await age(session.id, A_DAY);
    const database = app.get<TenantDatabase>(TENANT_DATABASE);
    const sessions = app.get<UploadSessionsRepository>(UPLOAD_SESSIONS_REPOSITORY);
    const files = app.get<FilesService>(FILES_SERVICE);
    const northstar = sweeperContextFor(world.northstar.organizationId, uuidv7());
    const row = await database.read(northstar, (runner) =>
      sessions.findById(runner, northstar, session.id),
    );
    if (!row) throw new Error('the session was just opened');

    // Reversal: drop the check at the top of `expire` and the provider is told to abandon
    // the upload under the wrong tenant's context before the release refuses it.
    const brightops = sweeperContextFor(world.brightops.organizationId, uuidv7());
    await expect(files.expire(brightops, row)).rejects.toMatchObject({
      name: 'SessionOutsideContextError',
    });
    expect(store.aborted).toHaveLength(0);
    expect((await statusOf(session.id)).session).toBe('reserved');
    expect(await counter(world.northstar.organizationId)).toEqual({ used: 0, reserved: DECLARED });
  });
});
