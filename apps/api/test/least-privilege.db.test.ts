import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import {
  leastPrivilegeDatabaseUrl,
  usingLeastPrivilegeCredential,
} from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * ADR-0001 layer 2 — the credential boundary.
 *
 * This is the layer the other four cannot stand in for. Layers 3 (query guard) and 4 (lint
 * boundary) live inside the application process and do nothing for a direct SQL session, a
 * leaked connection string, or an injected statement that reaches the driver. Layer 1
 * (composite foreign keys) constrains *shape*, not *authority* — it says a work item may
 * not point at another tenant's project, not that the application may not drop the table.
 * What remains after application code is bypassed entirely is whatever the runtime
 * credential is permitted to do, and until this file ran, that had never been measured.
 *
 * `scripts/db/users.sql` had been written, reviewed, and never executed anywhere. Every
 * assertion below is therefore about the file as much as about the server: it is the first
 * evidence that the grants say what their comments claim.
 *
 * ## Two failure modes that look alike and are not
 *
 * `audit_events` is protected twice — by a trigger (`0002_platform_primitives.sql`) and by
 * a withheld privilege (this file's subject). The corpus already proves the trigger fires
 * for *any* credential, including the migrator. Here the expectation is different and
 * stronger: the runtime user is refused by the privilege system, so the statement is
 * rejected before a trigger is ever consulted. Asserting the error *code* rather than the
 * message is what keeps those two apart — a test that only matched /denied/i would pass on
 * the trigger and prove nothing about the grant.
 */

/** ER_TABLEACCESS_DENIED_ERROR — the privilege system refused, no trigger involved. */
const ER_TABLEACCESS_DENIED = 'ER_TABLEACCESS_DENIED_ERROR';
/** ER_DBACCESS_DENIED_ERROR — the user cannot reach the database at all. */
const ER_DBACCESS_DENIED = 'ER_DBACCESS_DENIED_ERROR';
/** ER_SPECIFIC_ACCESS_DENIED_ERROR — a global privilege (CREATE USER, RELOAD) is missing. */
const ER_SPECIFIC_ACCESS_DENIED = 'ER_SPECIFIC_ACCESS_DENIED_ERROR';

interface DriverError {
  readonly code?: string;
  readonly errno?: number;
  readonly message: string;
}

/**
 * Run a statement expected to be refused, and return the driver's error.
 *
 * Returning rather than asserting inside keeps each case's expectation at its own call
 * site, where the reason it is refused is visible.
 */
async function refused(pool: Pool, sql: string, params: unknown[] = []): Promise<DriverError> {
  try {
    await pool.query(sql, params);
  } catch (error) {
    return error as DriverError;
  }
  throw new Error(`expected this statement to be refused, but it succeeded:\n  ${sql}`);
}

let db: TestDatabase;
let world: SeedWorld;
let app: Pool;

// Skipped where there is no least-privilege credential to test — which on this machine is
// every run, because the credential is created by `scripts/db/users.sql` against the
// containerised MariaDB. `guards CI against a silent skip` below is NOT skipped, and fails
// the build if CI ever reaches this file without the credential configured.
const withCredential = describe.skipIf(!usingLeastPrivilegeCredential);

describe('ADR-0001 layer 2 — least-privilege runtime credential', () => {
  it('guards CI against a silent skip', () => {
    if (process.env['CI']) {
      expect(
        usingLeastPrivilegeCredential,
        'TMANAGE_TEST_APP_DATABASE_URL must be set in CI: without it every case in this ' +
          'file is skipped and ADR-0001 layer 2 stays unproven while the suite reports green',
      ).toBe(true);
    } else {
      console.warn(
        '[least privilege] skipped — no TMANAGE_TEST_APP_DATABASE_URL. ' +
          'ADR-0001 layer 2 is proven by the containerised CI job, not by this run.',
      );
    }
  });
});

withCredential('the runtime user (tmanage_app)', () => {
  beforeAll(async () => {
    db = await startTestDatabase();
    world = await seedTwoTenants(db.admin);

    // A bare pool, not `createTenantPool`: the tenant guard is layer 3 and would reject
    // most of these statements before the server ever saw them. This layer must hold when
    // the guard is absent, because a leaked credential does not come with the guard.
    app = createPool({
      uri: leastPrivilegeDatabaseUrl(),
      connectionLimit: 2,
      multipleStatements: false,
      timezone: 'Z',
      charset: 'utf8mb4_unicode_ci',
    });
  });

  afterAll(async () => {
    await app?.end();
    await db?.stop();
  });

  it('is a genuinely different user from the admin credential', async () => {
    const [asApp] = await app.query<RowDataPacket[]>('select current_user() as u');
    const [asAdmin] = await db.admin.query<RowDataPacket[]>('select current_user() as u');
    expect(String(asApp[0]?.['u'])).toMatch(/^tmanage_app@/);
    expect(String(asApp[0]?.['u'])).not.toBe(String(asAdmin[0]?.['u']));
  });

  // ── The audit log ──────────────────────────────────────────────────────────

  it('can append an audit event', async () => {
    const id = uuidv7();
    await app.query(
      `insert into audit_events
         (id, organization_id, actor_user_id, action, object_type, object_id, result,
          correlation_id, metadata_json)
       values (?, ?, ?, 'work_item.transition', 'work_item', ?, 'allowed', ?, ?)`,
      [
        id,
        world.northstar.organizationId,
        world.northstar.owner.id,
        world.northstar.workItemId,
        uuidv7(),
        JSON.stringify({ from: 'triage', to: 'in_progress' }),
      ],
    );
    const [rows] = await app.query<RowDataPacket[]>('select id from audit_events where id = ?', [
      id,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('cannot UPDATE an audit event — refused by privilege, not by the trigger', async () => {
    const error = await refused(app, 'update audit_events set result = ? where id is not null', [
      'denied',
    ]);
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
    expect(error.message).toMatch(/UPDATE command denied/i);
    // The trigger's message must NOT appear: reaching it would mean UPDATE was granted and
    // only a runtime check stood in the way.
    expect(error.message).not.toMatch(/append-only/i);
  });

  it('cannot DELETE an audit event — refused by privilege, not by the trigger', async () => {
    const error = await refused(app, 'delete from audit_events where id is not null');
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
    expect(error.message).toMatch(/DELETE command denied/i);
    expect(error.message).not.toMatch(/append-only/i);
  });

  it('cannot TRUNCATE the audit log to sidestep the trigger', async () => {
    // TRUNCATE is DDL and does not fire the append-only trigger — which is exactly how the
    // test harness empties the table. Withholding DROP is what stops the application doing
    // the same thing.
    const error = await refused(app, 'truncate table audit_events');
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
  });

  // ── The migration ledger ───────────────────────────────────────────────────

  it('can read the migration ledger but cannot append to it', async () => {
    await expect(app.query('select filename from schema_migrations')).resolves.toBeDefined();
    const error = await refused(
      app,
      `insert into schema_migrations (filename, checksum, statements_total, applied_by)
       values ('9999_forged.sql', ?, 1, 'attacker')`,
      ['0'.repeat(64)],
    );
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
    expect(error.message).toMatch(/INSERT command denied/i);
  });

  it('cannot rewrite the migration ledger', async () => {
    const error = await refused(app, 'update schema_migrations set state = ? where 1 = 1', [
      'applied',
    ]);
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
  });

  // ── Schema ─────────────────────────────────────────────────────────────────

  it('cannot ALTER a table', async () => {
    const error = await refused(app, 'alter table work_items add column smuggled varchar(16) null');
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
    expect(error.message).toMatch(/ALTER command denied/i);
  });

  it('cannot drop the composite foreign key that enforces layer 1', async () => {
    // The most direct attack on ADR-0001: remove the constraint, then write freely across
    // tenants. Layer 2 is what makes layer 1 non-negotiable at runtime.
    const error = await refused(
      app,
      'alter table work_items drop foreign key fk_work_items_project_tenant',
    );
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
  });

  it('cannot drop a table', async () => {
    const error = await refused(app, 'drop table work_items');
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
    expect(error.message).toMatch(/DROP command denied/i);
  });

  it('cannot create a table', async () => {
    const error = await refused(app, 'create table smuggled_side_channel (id char(36) not null)');
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
  });

  it('cannot create an index', async () => {
    const error = await refused(app, 'create index ix_smuggled on work_items (title)');
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
  });

  it('cannot create a trigger, so it cannot neutralise the append-only rule', async () => {
    const error = await refused(
      app,
      'create trigger trg_smuggled before insert on work_items for each row set @x = 1',
    );
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
  });

  it('cannot create a view that reads across tenants', async () => {
    const error = await refused(
      app,
      'create view v_all_projects as select organization_id, id, name from projects',
    );
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
  });

  // ── Authority ──────────────────────────────────────────────────────────────

  it('cannot grant itself more privilege', async () => {
    const error = await refused(
      app,
      "grant update on `tmanage`.`audit_events` to 'tmanage_app'@'%'",
    );
    // Missing GRANT OPTION surfaces as a table-level denial for the object named.
    expect([ER_TABLEACCESS_DENIED, ER_DBACCESS_DENIED, ER_SPECIFIC_ACCESS_DENIED]).toContain(
      error.code,
    );
  });

  it('cannot create a user', async () => {
    const error = await refused(app, "create user 'backdoor'@'%' identified by 'x'");
    expect([ER_SPECIFIC_ACCESS_DENIED, ER_TABLEACCESS_DENIED, ER_DBACCESS_DENIED]).toContain(
      error.code,
    );
  });

  it('cannot read the server’s credential store', async () => {
    const error = await refused(app, 'select user, host from mysql.user');
    expect([ER_TABLEACCESS_DENIED, ER_DBACCESS_DENIED]).toContain(error.code);
  });

  it('cannot reach another database on the same server', async () => {
    // 50-BOOTSTRAP §4 puts every environment on one server. "Cannot access other databases"
    // is therefore what separates staging data from production data, not a formality.
    await db.admin.query('CREATE DATABASE IF NOT EXISTS tmanage_neighbour');
    try {
      await db.admin.query(
        'CREATE TABLE IF NOT EXISTS tmanage_neighbour.secrets (id INT PRIMARY KEY)',
      );
      const error = await refused(app, 'select id from tmanage_neighbour.secrets');
      expect([ER_TABLEACCESS_DENIED, ER_DBACCESS_DENIED]).toContain(error.code);
    } finally {
      await db.admin.query('DROP DATABASE IF EXISTS tmanage_neighbour');
    }
  });

  // ── What it must still be able to do ───────────────────────────────────────

  it('can still do the DML the application needs', async () => {
    // A credential locked down until the application no longer works is not a control, it
    // is an outage. The corpus running green under this same credential is the broad form
    // of this assertion; this is the narrow, legible one.
    const id = uuidv7();
    await app.query(
      'insert into work_items (id, organization_id, project_id, title) values (?, ?, ?, ?)',
      [id, world.northstar.organizationId, world.northstar.projectId, 'Least-privilege smoke'],
    );
    await app.query('update work_items set title = ? where organization_id = ? and id = ?', [
      'Least-privilege smoke (edited)',
      world.northstar.organizationId,
      id,
    ]);
    const [rows] = await app.query<RowDataPacket[]>(
      'select title from work_items where organization_id = ? and id = ?',
      [world.northstar.organizationId, id],
    );
    expect(String(rows[0]?.['title'])).toBe('Least-privilege smoke (edited)');
    await app.query('delete from work_items where organization_id = ? and id = ?', [
      world.northstar.organizationId,
      id,
    ]);
  });

  it('still has the session state the schema depends on', async () => {
    // Layer 2 must not cost layer 1: strict mode is a session setting, and a user without
    // the privilege to set it would silently fall back to truncating writes.
    const [rows] = await app.query<RowDataPacket[]>(
      'select @@session.sql_mode as m, @@session.time_zone as tz',
    );
    expect(String(rows[0]?.['m'])).toContain('STRICT_ALL_TABLES');
    expect(String(rows[0]?.['tz'])).toBe('+00:00');
  });
});
