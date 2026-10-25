import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { CSRF_HEADER } from '../src/common/http/csrf.js';
import { parseGrantScript } from '../src/common/database/grants.js';
import { TABLES } from '../src/common/database/schema.js';
import { TENANT_TABLES } from '../src/common/database/tenant-guard.js';
import { PRIVACY_PASS } from '../src/modules/privacy/privacy.module.js';
import type { PrivacyPass } from '../src/modules/privacy/privacy-job.js';
import type { TestDatabase } from './support/test-database.js';
import type { SeedWorld } from './seed-two-tenants.js';
import {
  bootHttpHarness,
  reseed,
  signIn as harnessSignIn,
  stopHarness,
} from './support/http-harness.js';
import type { InjectedResponse, Session } from './support/http-harness.js';

/**
 * PRIV-001 over real HTTP — D5 (migration 0231): data export and deletion requests.
 *
 * 1. **Registry.** `privacy_exports` and `privacy_deletion_requests` are tenant tables in all four
 *    places; the runtime holds INSERT and UPDATE, never DELETE.
 * 2. **Exports.** The owner asks for a company or a member export; a second while one is preparing
 *    is a 409; a non-owner is a 403 at the owner door; every member may ask for their own.
 * 3. **Deletions.** The company needs its name typed; one active request per subject; a request can
 *    be cancelled; the only owner cannot delete their account.
 * 4. **The privacy job** carries out a due account deletion: the membership is offboarded, the row
 *    is `executed`, and the twin's people are untouched.
 * 5. **Tenant isolation.** The twin sees none of Northstar's requests; the FKs refuse unknown parents.
 */

let db: TestDatabase;
let world: SeedWorld;
let app: NestFastifyApplication;

const HERE = dirname(fileURLToPath(import.meta.url));
const intents = parseGrantScript(
  readFileSync(resolve(HERE, '../../../scripts/db/users.sql'), 'utf8'),
);

const NORTHSTAR = 'northstar-studio';
const TWIN = 'northstar-studios';

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function signIn(userId: string): Promise<Session> {
  return harnessSignIn(app, userId);
}

async function send(
  method: 'GET' | 'POST',
  path: string,
  session: Session,
  payload?: unknown,
  slug = NORTHSTAR,
): Promise<InjectedResponse> {
  const body = payload ?? (method === 'POST' ? {} : undefined);
  return (await app.inject({
    method,
    url: `/v1/organizations/${slug}${path}`,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      cookie: session.cookie,
      ...(method === 'GET' ? {} : { [CSRF_HEADER]: session.csrfToken }),
    },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  })) as unknown as InjectedResponse;
}

interface ExportView {
  id: string;
  kind: string;
  state: string;
  subject: { userId: string } | null;
}

interface OverviewView {
  companyExports: ExportView[];
  memberExports: ExportView[];
  deletion: { id: string; kind: string; daysLeft: number } | null;
}

interface MineView {
  export: ExportView | null;
  deletion: { id: string; kind: string } | null;
}

async function truncatePrivacy(): Promise<void> {
  await db.admin.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    await db.admin.query('TRUNCATE TABLE `privacy_exports`');
    await db.admin.query('TRUNCATE TABLE `privacy_deletion_requests`');
  } finally {
    await db.admin.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

async function organizationName(organizationId: string): Promise<string> {
  const [row] = await observe('select name from organizations where id = ?', [organizationId]);
  return String(row!['name']);
}

const owner = () => world.northstar.owner;
const designer = () => world.northstar.designer;

beforeAll(async () => {
  ({ app, db } = await bootHttpHarness({ secretTag: 'the_priv_001_suite', guardMode: 'enforce' }));
}, 300_000);

beforeEach(async () => {
  world = await reseed(db);
  await truncatePrivacy();
});

afterAll(async () => {
  await stopHarness({ app, db });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('0231 — registry: the privacy tables in all four places', () => {
  it.each(['privacy_exports', 'privacy_deletion_requests'])(
    '%s is in TABLES and TENANT_TABLES, and users.sql grants the runtime INSERT and UPDATE only',
    (table) => {
      expect(Object.keys(TABLES)).toContain(table);
      expect(TENANT_TABLES[table]).toBe('organization_id');
      const onTable = (user: string) =>
        [...(intents.get(`'${user}'@'%'`)?.privileges ?? [])]
          .filter((key) => key.startsWith(`tmanage.${table}:`))
          .sort();
      expect(onTable('tmanage_app')).toEqual([
        `tmanage.${table}:INSERT`,
        `tmanage.${table}:UPDATE`,
      ]);
      expect(onTable('tmanage_worker')).toEqual([]);
    },
  );
});

describe('0231 — exports', () => {
  it('records a company export as preparing, refuses a second, and audits the request', async () => {
    const session = await signIn(owner().id);
    const first = await send('POST', '/admin/privacy/exports', session, { kind: 'company' });
    expect(first.statusCode, first.body).toBe(201);
    const view = first.json<OverviewView>();
    expect(view.companyExports).toHaveLength(1);
    expect(view.companyExports[0]).toMatchObject({ kind: 'company', state: 'preparing' });

    const again = await send('POST', '/admin/privacy/exports', session, { kind: 'company' });
    expect(again.statusCode).toBe(409);

    const rows = await observe(
      'select organization_id, status, requested_by_user_id, subject_user_id from privacy_exports',
    );
    expect(rows).toEqual([
      {
        organization_id: world.northstar.organizationId,
        status: 'preparing',
        requested_by_user_id: owner().id,
        subject_user_id: null,
      },
    ]);
    const audits = await observe(
      `select id from audit_events where organization_id = ? and action = 'privacy_export.requested'`,
      [world.northstar.organizationId],
    );
    expect(audits).toHaveLength(1);
  });

  it('records a member export about that member', async () => {
    const session = await signIn(owner().id);
    const response = await send('POST', '/admin/privacy/exports', session, {
      kind: 'member',
      membershipId: designer().membershipId,
    });
    expect(response.statusCode, response.body).toBe(201);
    const [row] = await observe('select kind, subject_user_id from privacy_exports');
    expect(row).toEqual({ kind: 'member', subject_user_id: designer().id });
  });

  it('refuses the twin’s membership as a member to export, with nothing written', async () => {
    const session = await signIn(owner().id);
    const response = await send('POST', '/admin/privacy/exports', session, {
      kind: 'member',
      membershipId: world.twin.owner.membershipId,
    });
    expect(response.statusCode).toBe(404);
    expect(await observe('select id from privacy_exports')).toHaveLength(0);
  });

  it('keeps the owner door to the owner', async () => {
    for (const person of [world.northstar.manager, designer()]) {
      const session = await signIn(person.id);
      expect((await send('GET', '/admin/privacy', session)).statusCode, person.role).toBe(403);
      const response = await send('POST', '/admin/privacy/exports', session, { kind: 'company' });
      expect(response.statusCode, person.role).toBe(403);
    }
    expect(await observe('select id from privacy_exports')).toHaveLength(0);
  });

  it('lets a member ask for their own data', async () => {
    const session = await signIn(designer().id);
    const response = await send('POST', '/me/privacy/exports', session);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<MineView>().export).toMatchObject({ kind: 'member', state: 'preparing' });
    const [row] = await observe(
      'select kind, subject_user_id, requested_by_user_id from privacy_exports',
    );
    expect(row).toEqual({
      kind: 'member',
      subject_user_id: designer().id,
      requested_by_user_id: designer().id,
    });
  });
});

describe('0231 — deletion requests', () => {
  it('schedules a company deletion only with the name typed, once, and cancels it', async () => {
    const session = await signIn(owner().id);
    const wrong = await send('POST', '/admin/privacy/deletion', session, {
      confirmName: 'Northstar',
    });
    expect(wrong.statusCode).toBe(400);
    expect(await observe('select id from privacy_deletion_requests')).toHaveLength(0);

    const name = await organizationName(world.northstar.organizationId);
    const scheduled = await send('POST', '/admin/privacy/deletion', session, { confirmName: name });
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    expect(scheduled.json<OverviewView>().deletion).toMatchObject({ kind: 'company' });

    const twice = await send('POST', '/admin/privacy/deletion', session, { confirmName: name });
    expect(twice.statusCode).toBe(409);

    const [row] = await observe(
      `select status, datediff(scheduled_for, requested_at) as days from privacy_deletion_requests`,
    );
    expect(row!['status']).toBe('scheduled');
    expect(Number(row!['days'])).toBe(30);

    const cancelled = await send('POST', '/admin/privacy/deletion/cancel', session);
    expect(cancelled.statusCode, cancelled.body).toBe(201);
    expect(cancelled.json<OverviewView>().deletion).toBeNull();
    const [after] = await observe(
      'select status, cancelled_by_user_id from privacy_deletion_requests',
    );
    expect(after).toEqual({ status: 'cancelled', cancelled_by_user_id: owner().id });
  });

  it('lets a member schedule and cancel their own account deletion', async () => {
    const session = await signIn(designer().id);
    const scheduled = await send('POST', '/me/privacy/deletion', session);
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    expect(scheduled.json<MineView>().deletion).toMatchObject({ kind: 'account' });
    expect((await send('POST', '/me/privacy/deletion', session)).statusCode).toBe(409);

    const cancelled = await send('POST', '/me/privacy/deletion/cancel', session);
    expect(cancelled.statusCode, cancelled.body).toBe(201);
    expect(cancelled.json<MineView>().deletion).toBeNull();
    // Nothing left to cancel.
    expect((await send('POST', '/me/privacy/deletion/cancel', session)).statusCode).toBe(404);
  });

  it('refuses the only owner’s account deletion', async () => {
    const session = await signIn(owner().id);
    const response = await send('POST', '/me/privacy/deletion', session);
    expect(response.statusCode).toBe(409);
    expect(await observe('select id from privacy_deletion_requests')).toHaveLength(0);
  });
});

describe('0231 — the privacy job carries out a due account deletion', () => {
  it('offboards the member once the grace period has passed, and only them', async () => {
    const session = await signIn(designer().id);
    expect((await send('POST', '/me/privacy/deletion', session)).statusCode).toBe(201);

    const pass = app.get<symbol, PrivacyPass>(PRIVACY_PASS, { strict: false });
    // Not due yet: nothing happens.
    const early = await pass.run();
    expect(early.deletionsExecuted).toBe(0);

    await db.admin.execute(
      `update privacy_deletion_requests
          set scheduled_for = date_sub(utc_timestamp(3), interval 1 day),
              requested_at = date_sub(utc_timestamp(3), interval 31 day)`,
    );
    const due = await pass.run();
    expect(due.deletionsExecuted).toBe(1);

    const [request] = await observe('select status, executed_at from privacy_deletion_requests');
    expect(request!['status']).toBe('executed');
    expect(request!['executed_at']).not.toBeNull();

    const [membership] = await observe('select status from memberships where id = ?', [
      designer().membershipId,
    ]);
    expect(membership!['status']).toBe('offboarded');
    const others = await observe(`select status from memberships where id in (?, ?)`, [
      owner().membershipId,
      world.twin.owner.membershipId,
    ]);
    expect(others.map((row) => row['status'])).toEqual(['active', 'active']);

    const audits = await observe(
      `select id from audit_events where organization_id = ? and action = 'privacy_deletion.executed'`,
      [world.northstar.organizationId],
    );
    expect(audits).toHaveLength(1);
  });
});

describe('0231 — tenant isolation', () => {
  it('shows the adversarial twin none of Northstar’s requests', async () => {
    const session = await signIn(owner().id);
    expect(
      (await send('POST', '/admin/privacy/exports', session, { kind: 'company' })).statusCode,
    ).toBe(201);
    const name = await organizationName(world.northstar.organizationId);
    expect(
      (await send('POST', '/admin/privacy/deletion', session, { confirmName: name })).statusCode,
    ).toBe(201);

    const twin = await signIn(world.twin.owner.id);
    const overview = await send('GET', '/admin/privacy', twin, undefined, TWIN);
    expect(overview.statusCode, overview.body).toBe(200);
    const view = overview.json<OverviewView>();
    expect(view.companyExports).toEqual([]);
    expect(view.deletion).toBeNull();
    // The twin cannot cancel Northstar's deletion through its own door.
    expect(
      (await send('POST', '/admin/privacy/deletion/cancel', twin, undefined, TWIN)).statusCode,
    ).toBe(404);
    const [row] = await observe('select status from privacy_deletion_requests');
    expect(row!['status']).toBe('scheduled');
  });

  it('refuses a request row for an organization or a person that does not exist', async () => {
    await expect(
      db.admin.execute(
        `insert into privacy_exports (id, organization_id, kind, requested_by_user_id, requested_at)
         values (?, ?, 'company', ?, utc_timestamp(3))`,
        [uuidv7(), uuidv7(), owner().id],
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      db.admin.execute(
        `insert into privacy_deletion_requests
           (id, organization_id, kind, subject_user_id, requested_by_user_id, requested_at, scheduled_for)
         values (?, ?, 'account', ?, ?, utc_timestamp(3), utc_timestamp(3))`,
        [uuidv7(), world.northstar.organizationId, uuidv7(), owner().id],
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});
