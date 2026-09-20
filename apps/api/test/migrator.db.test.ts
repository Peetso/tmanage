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
    expect(report.alreadyApplied).toEqual(realMigrations.map((_file, index) => index + 1));
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
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'r@e.test', 'R')`,
      [id('a4')],
    );

    // Every internal role is accepted (one write, rows built from the union)...
    const rows = INTERNAL_ROLES.map((role, i) => [id(`1${i}`), id('a1'), id('a3'), id('a4'), role]);
    await connection.query(
      `INSERT INTO project_memberships (id, organization_id, project_id, user_id, role) VALUES ?`,
      [rows],
    );
    // ...and a string outside the set is rejected by the engine, not by a service check.
    await expect(
      connection.query(
        `INSERT INTO project_memberships (id, organization_id, project_id, user_id, role) VALUES (?, ?, ?, ?, 'client_admin')`,
        [id('ff'), id('a1'), id('a3'), id('a4')],
      ),
    ).rejects.toThrow(/[Cc]heck constraint/);

    // The comparison is byte-exact and NO PAD (COLLATE utf8mb4_0900_bin): a case variant...
    await expect(
      connection.query(
        `INSERT INTO project_memberships (id, organization_id, project_id, user_id, role) VALUES (?, ?, ?, ?, 'OWNER')`,
        [id('fe'), id('a1'), id('a3'), id('a4')],
      ),
    ).rejects.toThrow(/[Cc]heck constraint/);
    // ...and a trailing-pad variant are both rejected, not silently admitted by _unicode_ci.
    await expect(
      connection.query(
        `INSERT INTO project_memberships (id, organization_id, project_id, user_id, role) VALUES (?, ?, ?, ?, 'owner ')`,
        [id('fd'), id('a1'), id('a3'), id('a4')],
      ),
    ).rejects.toThrow(/[Cc]heck constraint/);
    // The exact lowercase literal still passes, so the binary comparison did not over-tighten.
    await connection.query(
      `INSERT INTO project_memberships (id, organization_id, project_id, user_id, role) VALUES (?, ?, ?, ?, 'owner')`,
      [id('fc'), id('a1'), id('a3'), id('a4')],
    );
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
