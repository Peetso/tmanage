import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { startTestDatabase, truncateAll } from './support/test-database.js';
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
/**
 * ER_BINLOG_CREATE_ROUTINE_NEED_SUPER — creating a stored program needs SUPER (or
 * SET_USER_ID) while binary logging is on. Still the privilege system refusing, checked
 * ahead of the object privilege; see the CREATE TRIGGER case for why both are accepted.
 */
const ER_BINLOG_CREATE_ROUTINE_NEED_SUPER = 'ER_BINLOG_CREATE_ROUTINE_NEED_SUPER';

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

// Skipped where there is no least-privilege credential to test. That is not necessarily a
// containerised run: any long-lived server which has had `scripts/db/users.sql` applied to
// the database named by `TMANAGE_TEST_APP_DATABASE_URL` will do, including a single
// embedded MySQL started outside the per-file lifecycle. `guards CI against a silent skip`
// below is NOT skipped, and fails the build if CI ever reaches this file without the
// credential configured.
const withCredential = describe.skipIf(!usingLeastPrivilegeCredential);

describe('ADR-0001 layer 2 — least-privilege runtime credential', () => {
  it('guards CI against a silent skip', () => {
    if (process.env['CI']) {
      expect(
        usingLeastPrivilegeCredential,
        'TMANAGE_TEST_APP_DATABASE_URL must be set in CI: without it every case in this ' +
          'file is skipped and ADR-0001 layer 2 stays unproven while the suite reports green',
      ).toBe(true);
    } else if (usingLeastPrivilegeCredential) {
      // Reported rather than assumed. An earlier revision warned unconditionally outside
      // CI, so the first local run that *did* supply the credential still printed
      // "skipped" beside twenty cases that had in fact executed — a log line that would
      // have made a genuine result look like a non-result.
      console.warn(
        '[least privilege] running against TMANAGE_TEST_APP_DATABASE_URL. ' +
          'ADR-0001 layer 2 is under test in this run.',
      );
    } else {
      console.warn(
        '[least privilege] skipped — no TMANAGE_TEST_APP_DATABASE_URL. ' +
          'ADR-0001 layer 2 is not under test in this run. To run it, point ' +
          'TMANAGE_TEST_DATABASE_URL and TMANAGE_TEST_APP_DATABASE_URL at a long-lived ' +
          'server whose `tmanage` database has had scripts/db/users.sql applied.',
      );
    }
  });
});

withCredential('the runtime user (tmanage_app)', () => {
  beforeAll(async () => {
    db = await startTestDatabase();
    // Every other seeding suite truncates first; this one did not, and against the
    // per-file embedded server that omission was invisible because each file received an
    // empty database of its own. On a shared long-lived server — the configuration this
    // file exists to exercise — the previous suite's rows are still present and
    // `seedTwoTenants`' fixed slugs collide with `uq_organizations_slug`.
    await truncateAll(db.admin);
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
  // ── The edit history ─────────────────────────────

  // `message_revisions` is engine-authored: `trg_messages_record_revision` (0008) writes it
  // with its definer's privileges, and `users.sql` grants the runtime user nothing here.
  // These cases prove both halves — the runtime user cannot touch the table itself, and its
  // ordinary UPDATE on `messages` still produces the revision it could never INSERT.

  it('cannot INSERT a message revision — history is not the application’s to write', async () => {
    const error = await refused(
      app,
      `insert into message_revisions
         (organization_id, message_id, revision_no, body, written_at, replaced_at)
       values (?, ?, 1, 'forged', now(3), now(3))`,
      [world.northstar.organizationId, uuidv7()],
    );
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
    expect(error.message).toMatch(/INSERT command denied/i);
  });

  it('cannot UPDATE a message revision — refused by privilege, before the trigger', async () => {
    const error = await refused(
      app,
      'update message_revisions set body = ? where message_id is not null',
      ['falsified'],
    );
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
    expect(error.message).not.toMatch(/immutable/i);
  });

  it('cannot DELETE a message revision — the history is as permanent as the audit log', async () => {
    const error = await refused(app, 'delete from message_revisions where message_id is not null');
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
  });

  it('editing a message still writes the revision it cannot write itself', async () => {
    // Fixture rows through the admin credential; the act under test through the runtime one.
    const conversationId = uuidv7();
    const messageId = uuidv7();
    await db.admin.query(
      `insert into conversations (id, organization_id, project_id, name, created_by_user_id)
       values (?, ?, ?, 'grant-proof', ?)`,
      [
        conversationId,
        world.northstar.organizationId,
        world.northstar.projectId,
        world.northstar.owner.id,
      ],
    );
    await db.admin.query(
      `insert into messages (id, organization_id, conversation_id, author_user_id, sequence_no, body)
       values (?, ?, ?, ?, 1, 'as first said')`,
      [messageId, world.northstar.organizationId, conversationId, world.northstar.owner.id],
    );

    await app.query('update messages set body = ? where id = ?', ['as edited', messageId]);

    const [revisions] = await app.query<RowDataPacket[]>(
      'select revision_no, body from message_revisions where message_id = ?',
      [messageId],
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.['body']).toBe('as first said');
  });

  // ── The migration ledger ───────────────────────────────────────────────────

  // The column names below are `version` / `name` / `status`, not `filename` / `state`. An
  // earlier revision of this file used the latter, which do not exist: the SELECT died with
  // ER_BAD_FIELD_ERROR, and the INSERT would have been rejected for naming an unknown column
  // rather than for want of a privilege. The assertion could not have proved what it claimed
  // in any environment — the file had simply never been executed anywhere.
  it('can read the migration ledger but cannot append to it', async () => {
    await expect(app.query('select version, name from schema_migrations')).resolves.toBeDefined();
    const error = await refused(
      app,
      `insert into schema_migrations (version, name, checksum, statements_total, applied_by)
       values (9999, '9999_forged.sql', ?, 1, 'attacker')`,
      ['0'.repeat(64)],
    );
    expect(error.code).toBe(ER_TABLEACCESS_DENIED);
    expect(error.message).toMatch(/INSERT command denied/i);
  });

  it('cannot rewrite the migration ledger', async () => {
    const error = await refused(app, 'update schema_migrations set status = ? where 1 = 1', [
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
    // Two codes, both the privilege system and neither the append-only trigger, which is
    // the distinction this file exists to keep. `tmanage_app` holds no TRIGGER privilege on
    // any table — `SHOW GRANTS` confirms it — so the statement is refused either way. Which
    // refusal is reported depends on whether binary logging is on: with `log_bin = 1`
    // (the default for MySQL 8 and for the embedded server) MySQL evaluates the
    // SUPER/binlog requirement for stored programs *before* the TRIGGER privilege and
    // reports ER_BINLOG_CREATE_ROUTINE_NEED_SUPER; with binary logging off it reaches the
    // privilege check and reports ER_TABLEACCESS_DENIED_ERROR. Accepting only the latter
    // asserted a server configuration rather than a credential.
    expect([ER_TABLEACCESS_DENIED, ER_BINLOG_CREATE_ROUTINE_NEED_SUPER]).toContain(error.code);
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

  it('can still apply the session state the schema depends on', async () => {
    // Layer 2 must not cost layer 1: strict mode is a session setting, and a user without
    // the privilege to set it would silently fall back to truncating writes — a UUID
    // stored into CHAR(36) would become a different UUID rather than an error.
    //
    // What is asserted here is that `tmanage_app` can *establish* that state, because that
    // is the part the credential owns. An earlier revision instead read the session's
    // inherited `sql_mode` on a bare connection and required STRICT_ALL_TABLES to be
    // present already. That only ever held because `compose.yaml` launches its MariaDB with
    // `--sql-mode=STRICT_ALL_TABLES,...`; it was an assertion about a server's start-up
    // flags wearing a credential's clothing, and it fails on any server those flags cannot
    // be passed to — the embedded MySQL here, and Hostinger's shared MySQL in production,
    // which is the environment 50-BOOTSTRAP actually targets.
    //
    // One pinned connection rather than the pool: `SET SESSION` and the read that verifies
    // it must land on the same connection.
    const connection = await app.getConnection();
    try {
      await connection.query(
        `SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,` +
          `ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION', time_zone = '+00:00'`,
      );
      const [rows] = await connection.query<RowDataPacket[]>(
        'select @@session.sql_mode as m, @@session.time_zone as tz',
      );
      expect(String(rows[0]?.['m'])).toContain('STRICT_ALL_TABLES');
      expect(String(rows[0]?.['tz'])).toBe('+00:00');
    } finally {
      connection.release();
    }
  });

  it('gets that session state automatically on the pool the application actually uses', async () => {
    // The bare pool above is the leaked-credential scenario. This is the real one:
    // `createTenantPool` applies the session state on every connection it hands out, and in
    // this run that pool holds the least-privilege credential rather than the admin one —
    // so this is the production connect sequence, executed.
    expect(db.leastPrivilege).toBe(true);
    expect(db.connectionErrors).toEqual([]);
  });
});
