import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { createMigrationConnection } from '../src/common/database/connection.js';
import {
  MigrationError,
  PartialMigrationError,
  migrate,
  migrationStatus,
  readLedger,
  resetDatabase,
} from '../src/common/database/migrator.js';
import { migrationsDirectory, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { INTERNAL_ROLES } from '@tmanage/domain';

/**
 * Migrator behaviour against a real server.
 *
 * The partial-failure case is the reason this file exists. MySQL commits each DDL
 * statement as it runs, so a migration that dies half way through leaves a schema that is
 * neither the old one nor the new one. The migrator's contract is that it *records* that
 * state precisely and then refuses to run again until a human resolves it — asserted here
 * rather than only described in a comment.
 */

let db: TestDatabase;
let connection: Connection;

beforeAll(async () => {
  // `scratch` because this suite drops every table between cases. Against the embedded
  // server that is harmless — each suite owns its own server. Against the shared CI
  // server it would destroy the schema the isolation corpus and the least-privilege suite
  // run on, so this suite gets a database of its own there.
  db = await startTestDatabase({ applyMigrations: false, scratch: true });
  connection = await createMigrationConnection(db.url);
});

afterAll(async () => {
  await connection?.end();
  await db?.stop();
});

async function freshDatabase(): Promise<void> {
  await resetDatabase(connection);
}

async function migrationDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tmanage-migrations-'));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents, 'utf8');
  }
  return dir;
}

/**
 * The real migration set, read from disk rather than listed here.
 *
 * Hard-coding the filenames made every one of these cases fail the moment a migration was
 * added — a red suite that says nothing about the migrator, and a standing invitation to
 * "fix" it by editing an expectation without reading it. What these cases are actually about
 * is that *every* file applies once, in order, with a checksum, and that a second run is a
 * no-op; none of that has a number in it.
 */
const realMigrations: readonly string[] = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();

/** Copy the real migration set into a temporary directory, optionally adding files. */
async function copyRealMigrations(extra: Record<string, string> = {}): Promise<string> {
  const files: Record<string, string> = {};
  for (const name of realMigrations) {
    files[name] = await readFile(join(migrationsDirectory, name), 'utf8');
  }
  return migrationDir({ ...files, ...extra });
}

describe('applying the real migrations', () => {
  beforeAll(freshDatabase);

  it('has at least one migration to apply', () => {
    // Guards the cases below: every assertion in this block is vacuously true against an
    // empty directory, and a mis-resolved path would produce exactly that.
    expect(realMigrations.length).toBeGreaterThan(0);
  });

  it('applies every file from an empty database and records the ledger', async () => {
    const report = await migrate(connection, {
      directory: migrationsDirectory,
      appliedBy: 'migrator.db.test',
    });
    expect(report.applied.map((f) => f.filename)).toEqual(realMigrations);

    const ledger = await readLedger(connection);
    expect(ledger).toHaveLength(realMigrations.length);
    for (const row of ledger) {
      expect(row.status).toBe('applied');
      expect(row.statementsApplied).toBe(row.statementsTotal);
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(row.failedStatementIndex).toBeNull();
    }
  });

  it('is a no-op on a second run', async () => {
    const report = await migrate(connection, { directory: migrationsDirectory });
    expect(report.applied).toEqual([]);
    // `alreadyApplied` reports the version parsed from each filename, not a 1..n position, so
    // the assertion is derived the same way the migrator derives it. Migration numbering may
    // legitimately have gaps (a version reserved by a parallel branch, e.g. 0025), and the
    // migrator treats versions as a set; an `index + 1` expectation would encode a
    // contiguity the format never promises — exactly the hard-coded-number trap this file
    // avoids elsewhere.
    expect(report.alreadyApplied).toEqual(realMigrations.map((name) => Number.parseInt(name, 10)));
  });

  it('reports every file as applied', async () => {
    const status = await migrationStatus(connection, migrationsDirectory);
    expect(status.map((s) => s.state)).toEqual(realMigrations.map(() => 'applied'));
  });

  it('rejects an edited migration rather than silently skipping it', async () => {
    // Same versions, different bytes: the live schema no longer matches what the files say.
    const decoys = Object.fromEntries(
      realMigrations.map((name, index) => [name, `CREATE TABLE decoy_${index} (a INT);`]),
    );
    const dir = await migrationDir(decoys);
    await expect(migrate(connection, { directory: dir })).rejects.toThrow(/Checksum mismatch/);
  });

  it('rejects a migration numbered below one already applied', async () => {
    const dir = await copyRealMigrations({ '0000_backfill.sql': 'CREATE TABLE backfill (a INT);' });
    await expect(migrate(connection, { directory: dir })).rejects.toThrow(/Out-of-order/);
  });
});

describe('the advisory lock', () => {
  beforeAll(freshDatabase);

  it('refuses to start while another session holds the lock', async () => {
    const other = await createMigrationConnection(db.url);
    try {
      // GET_LOCK is session-scoped, which is why the migrator takes a Connection and not a
      // Pool: a pool would hand the second call a different session and both would run.
      await other.query("SELECT GET_LOCK('tmanage:migrations', 5)");
      await expect(
        migrate(connection, { directory: migrationsDirectory, lockTimeoutSeconds: 1 }),
      ).rejects.toThrow(/Another migration is already running/);
    } finally {
      await other.query("SELECT RELEASE_LOCK('tmanage:migrations')");
      await other.end();
    }
  });

  it('releases the lock after a successful run', async () => {
    await migrate(connection, { directory: migrationsDirectory });
    const other = await createMigrationConnection(db.url);
    try {
      const [rows] = await other.query<RowDataPacket[]>(
        "SELECT GET_LOCK('tmanage:migrations', 1) AS got",
      );
      expect(Number(rows[0]?.['got'])).toBe(1);
      await other.query("SELECT RELEASE_LOCK('tmanage:migrations')");
    } finally {
      await other.end();
    }
  });
});

describe('partial failure, because MySQL DDL is not transactional', () => {
  beforeAll(freshDatabase);

  const partial = {
    '0001_partial.sql': [
      'CREATE TABLE alpha (a INT) ENGINE=InnoDB;',
      'CREATE TABLE beta (b INT) ENGINE=InnoDB;',
      // Fails: `alpha` already exists two statements earlier in the same file.
      'CREATE TABLE alpha (c INT) ENGINE=InnoDB;',
      'CREATE TABLE gamma (d INT) ENGINE=InnoDB;',
    ].join('\n'),
  };

  it('leaves the committed statements in place and says exactly which one failed', async () => {
    const dir = await migrationDir(partial);

    const error = await migrate(connection, { directory: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartialMigrationError);
    const failure = error as PartialMigrationError;
    expect(failure.statementIndex).toBe(2);
    expect(failure.statementsApplied).toBe(2);
    expect(failure.statementsTotal).toBe(4);
    expect(failure.message).toMatch(/not transactional/);

    // The first two CREATEs are committed and cannot be rolled back. The fourth never ran.
    const [tables] = await connection.query<RowDataPacket[]>(
      `SELECT table_name AS t FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name IN ('alpha','beta','gamma')`,
    );
    expect(tables.map((r) => String(r['t'])).sort()).toEqual(['alpha', 'beta']);
  });

  it('records the failure in the ledger with a resumable statement count', async () => {
    const ledger = await readLedger(connection);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.status).toBe('failed');
    expect(ledger[0]?.statementsApplied).toBe(2);
    expect(ledger[0]?.failedStatementIndex).toBe(2);
    expect(ledger[0]?.failureMessage).toMatch(/alpha/);
  });

  it('refuses every later run until a human resolves the row', async () => {
    const dir = await migrationDir(partial);
    const error = await migrate(connection, { directory: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect(error).not.toBeInstanceOf(PartialMigrationError);
    expect((error as MigrationError).message).toMatch(/partially-applied/);
    expect((error as MigrationError).message).toMatch(/2\/4 statements committed/);
  });

  it('reports the same state through db:status without throwing', async () => {
    const dir = await migrationDir(partial);
    const status = await migrationStatus(connection, dir);
    expect(status[0]?.state).toBe('failed');
    expect(status[0]?.detail).toBe('2/4 statements committed');
  });

  it('resumes once the operator clears the ledger row', async () => {
    // Standing in for the documented manual repair: the applied portion is undone and the
    // row deleted, after which the migrator proceeds normally.
    await connection.query('DROP TABLE alpha');
    await connection.query('DROP TABLE beta');
    await connection.query('DELETE FROM schema_migrations WHERE version = 1');

    const dir = await migrationDir({
      '0001_partial.sql':
        'CREATE TABLE alpha (a INT) ENGINE=InnoDB;\nCREATE TABLE beta (b INT) ENGINE=InnoDB;',
    });
    const report = await migrate(connection, { directory: dir });
    expect(report.applied).toHaveLength(1);
    expect((await readLedger(connection))[0]?.status).toBe('applied');
  });
});

describe('0012: calendar dates survive the DATETIME -> DATE conversion', () => {
  beforeAll(freshDatabase);

  it('truncates stored midnight-UTC instants to the calendar date they meant', async () => {
    // Apply everything up to 0012, then write rows the way production wrote them before the
    // migration existed: calendar dates stored as midnight UTC in DATETIME(3) columns.
    const before = realMigrations.filter((name) => name < '0012');
    expect(before.length).toBeLessThan(realMigrations.length);
    const files: Record<string, string> = {};
    for (const name of before) {
      files[name] = await readFile(join(migrationsDirectory, name), 'utf8');
    }
    await migrate(connection, { directory: await migrationDir(files) });

    const org = '00000000-0000-4000-8000-00000000d001';
    const ws = '00000000-0000-4000-8000-00000000d002';
    const project = '00000000-0000-4000-8000-00000000d003';
    const clientOrg = '00000000-0000-4000-8000-00000000d004';
    const user = '00000000-0000-4000-8000-00000000d005';
    const request = '00000000-0000-4000-8000-00000000d006';
    await connection.query(
      `INSERT INTO organizations (id, slug, name) VALUES (?, 'date-mig', 'Date Migration Co')`,
      [org],
    );
    await connection.query(
      `INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'W')`,
      [ws, org],
    );
    await connection.query(
      `INSERT INTO projects (id, organization_id, workspace_id, name, committed_at, forecast_at)
        VALUES (?, ?, ?, 'P', '2026-09-30 00:00:00.000', '2026-10-15 00:00:00.000')`,
      [project, org, ws],
    );
    await connection.query(
      `INSERT INTO client_organizations (id, organization_id, name) VALUES (?, ?, 'C')`,
      [clientOrg, org],
    );
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'date-mig@example.test', 'D')`,
      [user],
    );
    await connection.query(
      `INSERT INTO client_requests
          (id, organization_id, project_id, client_organization_id, submitted_by_user_id,
           title, description, state, desired_at, commitment, committed_at)
        VALUES (?, ?, ?, ?, ?, 'T', 'D', 'accepted',
           '2026-10-30 00:00:00.000', 'committed', '2026-11-14 00:00:00.000')`,
      [request, org, project, clientOrg, user],
    );

    // The same bytes were applied from the copy, so the checksums agree and this run applies
    // only what is left — 0012 against a table that already holds data.
    await migrate(connection, { directory: migrationsDirectory });

    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT table_name AS tbl, column_name AS col, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND ((table_name = 'projects' AND column_name IN ('committed_at', 'forecast_at'))
            OR (table_name = 'client_requests' AND column_name IN ('desired_at', 'committed_at')))`,
    );
    expect(columns).toHaveLength(4);
    for (const row of columns) {
      expect(String(row['type'])).toBe('date');
    }

    // The stored midnight-UTC instants read back as the calendar dates they always meant —
    // proven with DATE_FORMAT so no driver or session timezone can touch the comparison.
    const [projectRows] = await connection.query<RowDataPacket[]>(
      `SELECT DATE_FORMAT(committed_at, '%Y-%m-%d') AS c, DATE_FORMAT(forecast_at, '%Y-%m-%d') AS f
         FROM projects WHERE id = ?`,
      [project],
    );
    expect(projectRows[0]?.['c']).toBe('2026-09-30');
    expect(projectRows[0]?.['f']).toBe('2026-10-15');

    const [requestRows] = await connection.query<RowDataPacket[]>(
      `SELECT DATE_FORMAT(desired_at, '%Y-%m-%d') AS d, DATE_FORMAT(committed_at, '%Y-%m-%d') AS c
         FROM client_requests WHERE id = ?`,
      [request],
    );
    expect(requestRows[0]?.['d']).toBe('2026-10-30');
    expect(requestRows[0]?.['c']).toBe('2026-11-14');
  });
});

describe('0026: project_memberships.role is constrained to the internal role set', () => {
  beforeAll(freshDatabase);

  it('admits exactly INTERNAL_ROLES and rejects any other string', async () => {
    // Anti-drift: the CHECK values are read from the migration, never restated here, so the
    // constraint and the packages/domain union cannot become two independently edited copies.
    const sql = await readFile(
      join(migrationsDirectory, '0026_project_membership_role_check.sql'),
      'utf8',
    );
    const check = sql.slice(sql.indexOf('CHECK (role'));
    const roles = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(roles.sort()).toEqual([...INTERNAL_ROLES].sort());

    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    const id = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'r', 'R')`, [
      id('a1'),
    ]);
    await connection.query(
      `INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'W')`,
      [id('a2'), id('a1')],
    );
    await connection.query(
      `INSERT INTO projects (id, organization_id, workspace_id, name) VALUES (?, ?, ?, 'P')`,
      [id('a3'), id('a1'), id('a2')],
    );
    // uq_project_memberships_identity is (organization_id, project_id, user_id), so every
    // membership below needs its own user: one per accepted role, one shared by the rejected
    // inserts (which never commit), and one for the final accepted 'owner'.
    const users = INTERNAL_ROLES.map((_, i) => [id(`b${i}`), `r${i}@e.test`, 'R']);
    users.push([id('c0'), 'rej@e.test', 'R'], [id('c1'), 'ok@e.test', 'R']);
    await connection.query(`INSERT INTO users (id, email, display_name) VALUES ?`, [users]);

    // Every internal role is accepted (one write), each on its own (project, user) identity...
    const rows = INTERNAL_ROLES.map((role, i) => [
      id(`1${i}`),
      id('a1'),
      id('a3'),
      id(`b${i}`),
      role,
    ]);
    await connection.query(
      `INSERT INTO project_memberships (id, organization_id, project_id, user_id, role) VALUES ?`,
      [rows],
    );
    // ...and a string outside the set is rejected by the engine, not by a service check.
    await expect(
      connection.query(
        `INSERT INTO project_memberships (id, organization_id, project_id, user_id, role) VALUES (?, ?, ?, ?, 'client_admin')`,
        [id('ff'), id('a1'), id('a3'), id('c0')],
      ),
    ).rejects.toThrow(/[Cc]heck constraint/);

    // The comparison is byte-exact and NO PAD (COLLATE utf8mb4_0900_bin): a case variant...
    await expect(
      connection.query(
        `INSERT INTO project_memberships (id, organization_id, project_id, user_id, role) VALUES (?, ?, ?, ?, 'OWNER')`,
        [id('fe'), id('a1'), id('a3'), id('c0')],
      ),
    ).rejects.toThrow(/[Cc]heck constraint/);
    // ...and a trailing-pad variant are both rejected, not silently admitted by _unicode_ci.
    await expect(
      connection.query(
        `INSERT INTO project_memberships (id, organization_id, project_id, user_id, role) VALUES (?, ?, ?, ?, 'owner ')`,
        [id('fd'), id('a1'), id('a3'), id('c0')],
      ),
    ).rejects.toThrow(/[Cc]heck constraint/);
    // The exact lowercase literal still passes, so the binary comparison did not over-tighten.
    await connection.query(
      `INSERT INTO project_memberships (id, organization_id, project_id, user_id, role) VALUES (?, ?, ?, ?, 'owner')`,
      [id('fc'), id('a1'), id('a3'), id('c1')],
    );
  });
});

describe('0028: import_jobs applies and round-trips within a tenant', () => {
  beforeAll(freshDatabase);

  it('creates the table and a tenant-scoped job insert/select round-trips; a cross-tenant read finds nothing', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    const id = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
    const orgA = id('b1');
    const orgB = id('b2');
    const user = id('b3');
    const jobA = id('b4');

    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'imp-a', 'A')`, [
      orgA,
    ]);
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'imp-b', 'B')`, [
      orgB,
    ]);
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'imp@e.test', 'I')`,
      [user],
    );

    // A validate-with-errors attempt in org A: the durable anchor for progress/receipt.
    await connection.query(
      `INSERT INTO import_jobs
          (id, organization_id, created_by_user_id, source_kind, status,
           total_count, valid_count, invalid_count)
        VALUES (?, ?, ?, 'project', 'validated_with_errors', 3, 2, 1)`,
      [jobA, orgA, user],
    );

    // The tenant-scoped read the repository issues round-trips the row exactly.
    const [ownRows] = await connection.query<RowDataPacket[]>(
      `SELECT status AS s, total_count AS t, valid_count AS v, invalid_count AS i
         FROM import_jobs WHERE organization_id = ? AND id = ?`,
      [orgA, jobA],
    );
    expect(ownRows).toHaveLength(1);
    expect(String(ownRows[0]?.['s'])).toBe('validated_with_errors');
    expect(Number(ownRows[0]?.['t'])).toBe(3);
    expect(Number(ownRows[0]?.['v'])).toBe(2);
    expect(Number(ownRows[0]?.['i'])).toBe(1);

    // The same id read under another tenant returns nothing — a cross-tenant job never appears.
    const [foreign] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM import_jobs WHERE organization_id = ? AND id = ?`,
      [orgB, jobA],
    );
    expect(foreign).toHaveLength(0);

    // The composite foreign key binds the row to its own tenant: a job citing org B's id but
    // org A's (nonexistent-in-B) shape cannot be inserted against a missing organization.
    await expect(
      connection.query(
        `INSERT INTO import_jobs
            (id, organization_id, created_by_user_id, source_kind, status,
             total_count, valid_count, invalid_count)
          VALUES (?, ?, ?, 'project', 'validated', 0, 0, 0)`,
        [id('b5'), id('ee'), user],
      ),
    ).rejects.toThrow(/foreign key|constraint/i);
  });
});

describe('0029: meetings is a tenant-scoped, project-owned, forward-only table', () => {
  beforeAll(freshDatabase);

  it('applies, holds a scoped round-trip, and refuses a cross-tenant or identity change', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    // The table exists with exactly the columns the Drizzle schema (schema.db.test.ts) mirrors.
    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT column_name AS col, is_nullable AS nullable, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'meetings'`,
    );
    const byName = new Map(columns.map((row) => [String(row['col']), row]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'agenda_note',
        'created_at',
        'created_by_user_id',
        'id',
        'organization_id',
        'project_id',
        'starts_at',
        'title',
        'updated_at',
      ].sort(),
    );
    // A meeting's start is an instant, not a DATE (that is the projects.forecast_at distinction).
    expect(String(byName.get('starts_at')?.['type'])).toBe('datetime');
    expect(String(byName.get('agenda_note')?.['nullable'])).toBe('YES');
    expect(String(byName.get('organization_id')?.['nullable'])).toBe('NO');

    const id = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'mtg', 'M')`, [
      id('a1'),
    ]);
    await connection.query(
      `INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'W')`,
      [id('a2'), id('a1')],
    );
    await connection.query(
      `INSERT INTO projects (id, organization_id, workspace_id, name) VALUES (?, ?, ?, 'P')`,
      [id('a3'), id('a1'), id('a2')],
    );
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'mtg@e.test', 'M')`,
      [id('a4')],
    );

    // A tenant-scoped insert/select round-trips, and the instant is preserved.
    await connection.query(
      `INSERT INTO meetings (id, organization_id, project_id, title, starts_at, agenda_note, created_by_user_id)
       VALUES (?, ?, ?, 'Kickoff', '2026-10-01 14:00:00.000', 'agenda', ?)`,
      [id('a5'), id('a1'), id('a3'), id('a4')],
    );
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT title, agenda_note AS note,
              DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i:%s') AS s
         FROM meetings WHERE organization_id = ? AND id = ?`,
      [id('a1'), id('a5')],
    );
    expect(rows[0]?.['title']).toBe('Kickoff');
    expect(rows[0]?.['note']).toBe('agenda');
    expect(rows[0]?.['s']).toBe('2026-10-01 14:00:00');

    // The composite foreign key refuses a project id from outside the meeting's tenant: the
    // pair (a non-existent org, this project) does not exist even though the project id does.
    await expect(
      connection.query(
        `INSERT INTO meetings (id, organization_id, project_id, title, starts_at, created_by_user_id)
         VALUES (?, 'ffffffff-0000-4000-8000-000000000001', ?, 'X', '2026-10-01 14:00:00.000', ?)`,
        [id('a6'), id('a3'), id('a4')],
      ),
    ).rejects.toThrow(/foreign key/i);

    // organization_id is immutable at the engine, not just in the application.
    await expect(
      connection.query(
        `UPDATE meetings SET organization_id = 'ffffffff-0000-4000-8000-000000000001' WHERE id = ?`,
        [id('a5')],
      ),
    ).rejects.toThrow(/immutable/);
  });
});

describe('0030: documents is a tenant-scoped, project-owned, forward-only table', () => {
  beforeAll(freshDatabase);

  it('applies, holds a scoped round-trip, and refuses a cross-tenant or identity change', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    // The table exists with exactly the columns the Drizzle schema (schema.db.test.ts) mirrors.
    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT column_name AS col, is_nullable AS nullable, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'documents'`,
    );
    const byName = new Map(columns.map((row) => [String(row['col']), row]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'body',
        'created_at',
        'created_by_user_id',
        'id',
        'organization_id',
        'project_id',
        'title',
        'updated_at',
      ].sort(),
    );
    // A document body is prose a person types — TEXT, and NOT NULL like conversations.body.
    expect(String(byName.get('body')?.['type'])).toBe('text');
    expect(String(byName.get('body')?.['nullable'])).toBe('NO');
    expect(String(byName.get('organization_id')?.['nullable'])).toBe('NO');
    expect(String(byName.get('project_id')?.['nullable'])).toBe('NO');

    const id = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'doc', 'D')`, [
      id('b1'),
    ]);
    await connection.query(
      `INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'W')`,
      [id('b2'), id('b1')],
    );
    await connection.query(
      `INSERT INTO projects (id, organization_id, workspace_id, name) VALUES (?, ?, ?, 'P')`,
      [id('b3'), id('b1'), id('b2')],
    );
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'doc@e.test', 'D')`,
      [id('b4')],
    );

    // A tenant-scoped insert/select round-trips, and the body is preserved.
    await connection.query(
      `INSERT INTO documents (id, organization_id, project_id, title, body, created_by_user_id)
       VALUES (?, ?, ?, 'Brief', 'the body prose', ?)`,
      [id('b5'), id('b1'), id('b3'), id('b4')],
    );
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT title, body FROM documents WHERE organization_id = ? AND id = ?`,
      [id('b1'), id('b5')],
    );
    expect(rows[0]?.['title']).toBe('Brief');
    expect(rows[0]?.['body']).toBe('the body prose');

    // The composite foreign key refuses a project id from outside the document's tenant: the
    // pair (a non-existent org, this project) does not exist even though the project id does.
    await expect(
      connection.query(
        `INSERT INTO documents (id, organization_id, project_id, title, body, created_by_user_id)
         VALUES (?, 'ffffffff-0000-4000-8000-000000000001', ?, 'X', 'y', ?)`,
        [id('b6'), id('b3'), id('b4')],
      ),
    ).rejects.toThrow(/foreign key/i);

    // organization_id is immutable at the engine, not just in the application.
    await expect(
      connection.query(
        `UPDATE documents SET organization_id = 'ffffffff-0000-4000-8000-000000000001' WHERE id = ?`,
        [id('b5')],
      ),
    ).rejects.toThrow(/immutable/);
  });
});

describe('0034: saved_views is a tenant- and owner-scoped, forward-only table', () => {
  beforeAll(freshDatabase);

  it('applies, holds a scoped round-trip (project-scoped and org-wide), and refuses a cross-tenant or identity change', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    // The table exists with exactly the columns the Drizzle schema (schema.db.test.ts) mirrors.
    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT column_name AS col, is_nullable AS nullable, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'saved_views'`,
    );
    const byName = new Map(columns.map((row) => [String(row['col']), row]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'config',
        'created_at',
        'id',
        'name',
        'organization_id',
        'owner_user_id',
        'project_id',
        'shared',
        'updated_at',
      ].sort(),
    );
    // config is JSON; project_id is NULL-able (an org-wide view names no project); owner and org are not.
    expect(String(byName.get('config')?.['type'])).toBe('json');
    expect(String(byName.get('project_id')?.['nullable'])).toBe('YES');
    expect(String(byName.get('owner_user_id')?.['nullable'])).toBe('NO');
    expect(String(byName.get('organization_id')?.['nullable'])).toBe('NO');

    const id = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'sv', 'S')`, [
      id('c1'),
    ]);
    await connection.query(
      `INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'W')`,
      [id('c2'), id('c1')],
    );
    await connection.query(
      `INSERT INTO projects (id, organization_id, workspace_id, name) VALUES (?, ?, ?, 'P')`,
      [id('c3'), id('c1'), id('c2')],
    );
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'sv@e.test', 'S')`,
      [id('c4')],
    );

    // A project-scoped view round-trips and its JSON config is preserved.
    await connection.query(
      `INSERT INTO saved_views (id, organization_id, owner_user_id, project_id, name, config, shared)
       VALUES (?, ?, ?, ?, 'Scoped', ?, 1)`,
      [
        id('c5'),
        id('c1'),
        id('c4'),
        id('c3'),
        JSON.stringify({ filters: [], grouping: null, columns: ['title'] }),
      ],
    );
    // An org-wide view (NULL project_id) is allowed — the composite FK skips a NULL under MATCH SIMPLE.
    await connection.query(
      `INSERT INTO saved_views (id, organization_id, owner_user_id, project_id, name, config, shared)
       VALUES (?, ?, ?, NULL, 'Org-wide', ?, 0)`,
      [id('c6'), id('c1'), id('c4'), JSON.stringify({ filters: [], grouping: null, columns: [] })],
    );
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT name, project_id AS pid, JSON_UNQUOTE(JSON_EXTRACT(config, '$.columns[0]')) AS col
         FROM saved_views WHERE organization_id = ? AND id = ?`,
      [id('c1'), id('c5')],
    );
    expect(rows[0]?.['name']).toBe('Scoped');
    expect(rows[0]?.['pid']).toBe(id('c3'));
    // JSON_UNQUOTE yields the string value the config remembers; mysql2 parses a bare
    // JSON_EXTRACT result to the same string, so unquoting keeps the assertion driver-independent.
    expect(String(rows[0]?.['col'])).toBe('title');

    // The composite foreign key refuses a project id from outside the view's tenant: the pair
    // (a non-existent org, this project) does not exist even though the project id does.
    await expect(
      connection.query(
        `INSERT INTO saved_views (id, organization_id, owner_user_id, project_id, name, config, shared)
         VALUES (?, 'ffffffff-0000-4000-8000-000000000001', ?, ?, 'X', ?, 0)`,
        [
          id('c7'),
          id('c4'),
          id('c3'),
          JSON.stringify({ filters: [], grouping: null, columns: [] }),
        ],
      ),
    ).rejects.toThrow(/foreign key/i);

    // owner_user_id is immutable at the engine, not just in the application.
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'sv2@e.test', 'S2')`,
      [id('c8')],
    );
    await expect(
      connection.query(`UPDATE saved_views SET owner_user_id = ? WHERE id = ?`, [
        id('c8'),
        id('c5'),
      ]),
    ).rejects.toThrow(/immutable/);

    // organization_id is immutable too.
    await expect(
      connection.query(
        `UPDATE saved_views SET organization_id = 'ffffffff-0000-4000-8000-000000000001' WHERE id = ?`,
        [id('c5')],
      ),
    ).rejects.toThrow(/immutable/);
  });
});

describe('file validation', () => {
  it('rejects a filename that does not match NNNN_snake_case.sql', async () => {
    const dir = await migrationDir({ 'add-things.sql': 'SELECT 1;' });
    await expect(migrate(connection, { directory: dir })).rejects.toThrow(/Migration filenames/);
  });

  it('rejects two files sharing a version', async () => {
    const dir = await migrationDir({
      '0001_one.sql': 'SELECT 1;',
      '0001_two.sql': 'SELECT 1;',
    });
    await expect(migrate(connection, { directory: dir })).rejects.toThrow(/Duplicate migration/);
  });

  it('rejects an empty migration', async () => {
    const dir = await migrationDir({ '0001_empty.sql': '-- nothing here\n' });
    await expect(migrate(connection, { directory: dir })).rejects.toThrow(/no statements/);
  });
});
