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
 * The partial-failure case is the reason this file exists. MariaDB commits each DDL
 * statement as it runs, so a migration that dies half way through leaves a schema that is
 * neither the old one nor the new one. The migrator's contract is that it *records* that
 * state precisely and then refuses to run again until a human resolves it â€” asserted here
 * rather than only described in a comment.
 */

let db: TestDatabase;
let connection: Connection;

beforeAll(async () => {
  // `scratch` because this suite drops every table between cases. Against the embedded
  // server that is harmless â€” each suite owns its own server. Against the shared CI
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
 * added â€” a red suite that says nothing about the migrator, and a standing invitation to
 * "fix" it by editing an expectation without reading it. What these cases are actually about
 * is that *every* file applies once, in order, with a checksum, and that a second run is a
 * no-op; none of that has a number in it.
 */
const realMigrations: readonly string[] = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();

/**
 * A CHECK violation naming `constraint`, in MariaDB's wording.
 *
 * MariaDB 11.8 (the project's only engine, and Hostinger's) says
 * "CONSTRAINT `name` failed for `db`.`table`". The match names the constraint rather than
 * loosening to any error, so it is the engine refusing the row on that constraint.
 */
function checkViolation(constraint: string): RegExp {
  return new RegExp(`CONSTRAINT \`${constraint}\` failed`);
}

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
    // contiguity the format never promises â€” exactly the hard-coded-number trap this file
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

describe('partial failure, because MariaDB DDL is not transactional', () => {
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
    // only what is left â€” 0012 against a table that already holds data.
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

    // The stored midnight-UTC instants read back as the calendar dates they always meant â€”
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
    const check = sql.slice(sql.indexOf('chk_project_memberships_role'));
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
    ).rejects.toThrow(checkViolation('chk_project_memberships_role'));

    // The comparison is byte-exact and NO PAD (CAST(role AS BINARY)): a case variant...
    await expect(
      connection.query(
        `INSERT INTO project_memberships (id, organization_id, project_id, user_id, role) VALUES (?, ?, ?, ?, 'OWNER')`,
        [id('fe'), id('a1'), id('a3'), id('c0')],
      ),
    ).rejects.toThrow(checkViolation('chk_project_memberships_role'));
    // ...and a trailing-pad variant are both rejected, not silently admitted by _unicode_ci.
    await expect(
      connection.query(
        `INSERT INTO project_memberships (id, organization_id, project_id, user_id, role) VALUES (?, ?, ?, ?, 'owner ')`,
        [id('fd'), id('a1'), id('a3'), id('c0')],
      ),
    ).rejects.toThrow(checkViolation('chk_project_memberships_role'));
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

    // The same id read under another tenant returns nothing â€” a cross-tenant job never appears.
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
        'audience',
        'body',
        'created_at',
        'created_by_user_id',
        'id',
        'organization_id',
        'project_id',
        'published_at',
        'published_by_user_id',
        'title',
        'updated_at',
      ].sort(),
    );
    // A document body is prose a person types â€” TEXT, and NOT NULL like conversations.body.
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

describe('0031: client_projections is tenant-scoped, append-only and immutable', () => {
  beforeAll(freshDatabase);

  const id = (n: string) => `00000000-0000-4000-8000-0000000003${n}`;

  it('creates the table and refuses a re-publish and any update at the engine', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    // Minimal parents the composite FKs require: a project in a tenant, a user, a version.
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'cp', 'CP')`, [
      id('01'),
    ]);
    await connection.query(
      `INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'W')`,
      [id('02'), id('01')],
    );
    await connection.query(
      `INSERT INTO projects (id, organization_id, workspace_id, name) VALUES (?, ?, ?, 'P')`,
      [id('03'), id('01'), id('02')],
    );
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'cp@e.test', 'CP')`,
      [id('04')],
    );
    const hash = 'a'.repeat(64);
    await connection.query(
      `INSERT INTO deliverable_versions
         (id, organization_id, project_id, deliverable_id, content_hash, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id('05'), id('01'), id('03'), id('06'), hash, id('04')],
    );

    const projection = JSON.stringify({
      title: 'Concept',
      summary: null,
      milestoneState: null,
      forecastDate: null,
      publishedRisk: null,
      decision: null,
      approvedContacts: [],
    });
    await connection.query(
      `INSERT INTO client_projections
         (id, organization_id, project_id, deliverable_id, deliverable_version_id,
          content_hash, projection, published_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id('07'), id('01'), id('03'), id('06'), id('05'), hash, projection, id('04')],
    );

    // Append-only: a second projection of the same version is a duplicate-key error, not a row.
    await expect(
      connection.query(
        `INSERT INTO client_projections
           (id, organization_id, project_id, deliverable_id, deliverable_version_id,
            content_hash, projection, published_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('08'), id('01'), id('03'), id('06'), id('05'), hash, projection, id('04')],
      ),
    ).rejects.toThrow(/[Dd]uplicate/);

    // Immutable: the trigger refuses any UPDATE outright.
    await expect(
      connection.query(`UPDATE client_projections SET content_hash = ? WHERE id = ?`, [
        'b'.repeat(64),
        id('07'),
      ]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('0032: import_rows applies and a job commits with a per-row receipt', () => {
  beforeAll(freshDatabase);

  it('creates import_rows, transitions a job to committed, and binds a receipt to its own tenant', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    const id = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
    const orgA = id('c1');
    const orgB = id('c2');
    const user = id('c3');
    const jobA = id('c4');
    const rowA = id('c5');

    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'cmt-a', 'A')`, [
      orgA,
    ]);
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'cmt-b', 'B')`, [
      orgB,
    ]);
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'cmt@e.test', 'C')`,
      [user],
    );

    // A validated attempt in org A, then the commit-half transition: status moves to a terminal
    // committed value and the receipt-summary columns 0032 adds are stamped in place (UPDATE).
    await connection.query(
      `INSERT INTO import_jobs
          (id, organization_id, created_by_user_id, source_kind, status,
           total_count, valid_count, invalid_count)
        VALUES (?, ?, ?, 'project', 'validated_with_errors', 2, 1, 1)`,
      [jobA, orgA, user],
    );
    await connection.query(
      `UPDATE import_jobs
          SET status = 'committed_with_errors', committed_count = 1, failed_count = 1,
              committed_at = CURRENT_TIMESTAMP(3)
        WHERE organization_id = ? AND id = ?`,
      [orgA, jobA],
    );

    // One created receipt and one failed receipt for the job, the per-row anchor ADM-10 reads.
    await connection.query(
      `INSERT INTO import_rows
          (id, organization_id, job_id, source_index, outcome, created_entity_id)
        VALUES (?, ?, ?, 0, 'created', ?)`,
      [rowA, orgA, jobA, id('c6')],
    );
    await connection.query(
      `INSERT INTO import_rows
          (id, organization_id, job_id, source_index, outcome, error_detail)
        VALUES (?, ?, ?, 1, 'failed', 'name: must be a non-empty string')`,
      [id('c7'), orgA, jobA],
    );

    // The tenant-scoped read round-trips the transitioned job and both receipts, in source order.
    const [jobRows] = await connection.query<RowDataPacket[]>(
      `SELECT status AS s, committed_count AS c, failed_count AS f
         FROM import_jobs WHERE organization_id = ? AND id = ?`,
      [orgA, jobA],
    );
    expect(String(jobRows[0]?.['s'])).toBe('committed_with_errors');
    expect(Number(jobRows[0]?.['c'])).toBe(1);
    expect(Number(jobRows[0]?.['f'])).toBe(1);

    const [receiptRows] = await connection.query<RowDataPacket[]>(
      `SELECT outcome AS o FROM import_rows
         WHERE organization_id = ? AND job_id = ? ORDER BY source_index`,
      [orgA, jobA],
    );
    expect(receiptRows.map((r) => String(r['o']))).toEqual(['created', 'failed']);

    // The same job id read under another tenant returns no receipts â€” never a cross-tenant path.
    const [foreign] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM import_rows WHERE organization_id = ? AND job_id = ?`,
      [orgB, jobA],
    );
    expect(foreign).toHaveLength(0);

    // The composite (organization_id, job_id) foreign key binds a receipt to a job of the SAME
    // tenant: a receipt in org B citing org A's job is refused, so a receipt can never cite
    // another organization's job.
    await expect(
      connection.query(
        `INSERT INTO import_rows
            (id, organization_id, job_id, source_index, outcome)
          VALUES (?, ?, ?, 0, 'created')`,
        [id('c8'), orgB, jobA],
      ),
    ).rejects.toThrow(/foreign key|constraint/i);
  });
});

describe('0033: meeting_notes is a tenant-scoped, meeting-owned, append-only table', () => {
  beforeAll(freshDatabase);

  it('applies, round-trips a note and a decision, and refuses a cross-tenant meeting or any update', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    // The table exists with exactly the columns the Drizzle schema (schema.db.test.ts) mirrors.
    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT column_name AS col, is_nullable AS nullable, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'meeting_notes'`,
    );
    const byName = new Map(columns.map((row) => [String(row['col']), row]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'author_user_id',
        'body',
        'created_at',
        'id',
        'kind',
        'meeting_id',
        'organization_id',
      ].sort(),
    );
    // `kind` is an ENUM('note','decision'); `body` is TEXT and NOT NULL.
    expect(String(byName.get('kind')?.['type'])).toBe('enum');
    expect(String(byName.get('body')?.['type'])).toBe('text');
    expect(String(byName.get('body')?.['nullable'])).toBe('NO');
    expect(String(byName.get('organization_id')?.['nullable'])).toBe('NO');

    const id = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'note', 'N')`, [
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
      `INSERT INTO users (id, email, display_name) VALUES (?, 'note@e.test', 'N')`,
      [id('c4')],
    );
    await connection.query(
      `INSERT INTO meetings (id, organization_id, project_id, title, starts_at, created_by_user_id)
       VALUES (?, ?, ?, 'Kickoff', '2026-10-01 14:00:00.000', ?)`,
      [id('c5'), id('c1'), id('c3'), id('c4')],
    );

    // A tenant-scoped insert/select round-trips a note and a decision.
    await connection.query(
      `INSERT INTO meeting_notes (id, organization_id, meeting_id, kind, body, author_user_id)
       VALUES (?, ?, ?, 'note', 'a loose note', ?)`,
      [id('c6'), id('c1'), id('c5'), id('c4')],
    );
    await connection.query(
      `INSERT INTO meeting_notes (id, organization_id, meeting_id, kind, body, author_user_id)
       VALUES (?, ?, ?, 'decision', 'we ship Friday', ?)`,
      [id('c7'), id('c1'), id('c5'), id('c4')],
    );
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT kind, body FROM meeting_notes WHERE organization_id = ? AND meeting_id = ? ORDER BY id`,
      [id('c1'), id('c5')],
    );
    expect(rows.map((r) => String(r['kind']))).toEqual(['note', 'decision']);
    expect(String(rows[0]?.['body'])).toBe('a loose note');

    // The composite foreign key refuses a meeting id from outside the note's tenant: the pair
    // (a non-existent org, this meeting) does not exist even though the meeting id does.
    await expect(
      connection.query(
        `INSERT INTO meeting_notes (id, organization_id, meeting_id, kind, body, author_user_id)
         VALUES (?, 'ffffffff-0000-4000-8000-000000000001', ?, 'note', 'x', ?)`,
        [id('c8'), id('c5'), id('c4')],
      ),
    ).rejects.toThrow(/foreign key/i);

    // The value list is closed: a kind outside the ENUM is rejected by STRICT mode.
    await expect(
      connection.query(
        `INSERT INTO meeting_notes (id, organization_id, meeting_id, kind, body, author_user_id)
         VALUES (?, ?, ?, 'action', 'x', ?)`,
        [id('c9'), id('c1'), id('c5'), id('c4')],
      ),
    ).rejects.toThrow();

    // A captured note is append-only: the trigger refuses every UPDATE at the engine.
    await expect(
      connection.query(`UPDATE meeting_notes SET body = 'edited' WHERE id = ?`, [id('c6')]),
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
    // MariaDB's JSON is an alias for LONGTEXT that the engine guards with an automatic CHECK
    // (json_valid(config)), so the guard is what is asserted.
    expect(String(byName.get('config')?.['type'])).toBe('longtext');
    const [checks] = await connection.query<RowDataPacket[]>(
      `SELECT check_clause AS clause
         FROM information_schema.check_constraints
        WHERE constraint_schema = DATABASE() AND table_name = 'saved_views'`,
    );
    expect(checks.map((row) => String(row['clause']))).toContainEqual(
      expect.stringMatching(/json_valid\(`config`\)/i),
    );
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
    // An org-wide view (NULL project_id) is allowed â€” the composite FK skips a NULL under MATCH SIMPLE.
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

describe('0035: saved_context is tenant- and user-scoped (HOME-05)', () => {
  beforeAll(freshDatabase);

  it('creates the pin table with the tenant key, the idempotency key and the entity-type enum', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    // Columns, nullability and the key types. project_id is the only nullable column (a future
    // org-level pin); everything else that identifies the pin is NOT NULL.
    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT column_name AS c, is_nullable AS n, data_type AS d
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'saved_context'
        ORDER BY ordinal_position`,
    );
    const byName = new Map(columns.map((row) => [String(row['c']), row]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'created_at',
        'entity_id',
        'entity_type',
        'id',
        'organization_id',
        'project_id',
        'user_id',
      ].sort(),
    );
    expect(byName.get('project_id')?.['n']).toBe('YES');
    for (const notNull of [
      'id',
      'organization_id',
      'user_id',
      'entity_type',
      'entity_id',
      'created_at',
    ]) {
      expect(byName.get(notNull)?.['n'], notNull).toBe('NO');
    }
    expect(String(byName.get('entity_type')?.['d'])).toBe('enum');

    // The enum admits exactly the four kinds HOME-05 names — read from the migration so the
    // constraint and the schema union cannot drift into two independently edited copies.
    const sql = await readFile(join(migrationsDirectory, '0035_saved_context.sql'), 'utf8');
    const enumDef = sql.slice(sql.indexOf("ENUM('message'"));
    const kinds = [...enumDef.slice(0, enumDef.indexOf(')')).matchAll(/'([a-z]+)'/g)].map(
      (m) => m[1],
    );
    expect(kinds.sort()).toEqual(['doc', 'file', 'message', 'work']);

    // The two unique keys: the composite tenant key every tenant table carries, and the
    // idempotency key that makes a re-pin collide rather than duplicate.
    const [indexes] = await connection.query<RowDataPacket[]>(
      `SELECT DISTINCT index_name AS i
         FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'saved_context' AND non_unique = 0`,
    );
    const uniqueNames = indexes.map((row) => String(row['i']));
    expect(uniqueNames).toContain('uq_saved_context_org_id');
    expect(uniqueNames).toContain('uq_saved_context_pin');
  });
});

describe('0036: document_versions is tenant-scoped, append-only and forward-only', () => {
  beforeAll(freshDatabase);

  const id = (n: string) => `00000000-0000-4000-8000-0000000004${n}`;

  it('applies, round-trips a scoped version, and refuses cross-tenant, mutation and identity change', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    // The table has exactly the columns the Drizzle schema mirrors.
    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT column_name AS col, is_nullable AS nullable, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'document_versions'`,
    );
    const byName = new Map(columns.map((row) => [String(row['col']), row]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'body',
        'created_at',
        'document_id',
        'edited_by_user_id',
        'id',
        'organization_id',
        'version_no',
      ].sort(),
    );
    expect(String(byName.get('body')?.['type'])).toBe('text');
    expect(String(byName.get('body')?.['nullable'])).toBe('NO');
    expect(String(byName.get('version_no')?.['nullable'])).toBe('NO');

    // Minimal parents the composite FK requires: a project in a tenant, a user, and a document.
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'dv', 'DV')`, [
      id('01'),
    ]);
    await connection.query(
      `INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'W')`,
      [id('02'), id('01')],
    );
    await connection.query(
      `INSERT INTO projects (id, organization_id, workspace_id, name) VALUES (?, ?, ?, 'P')`,
      [id('03'), id('01'), id('02')],
    );
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'dv@e.test', 'DV')`,
      [id('04')],
    );
    await connection.query(
      `INSERT INTO documents (id, organization_id, project_id, title, body, created_by_user_id)
       VALUES (?, ?, ?, 'Brief', 'v0', ?)`,
      [id('05'), id('01'), id('03'), id('04')],
    );

    // A tenant-scoped version insert/select round-trips, and the body is preserved.
    await connection.query(
      `INSERT INTO document_versions
         (id, organization_id, document_id, version_no, body, edited_by_user_id)
       VALUES (?, ?, ?, 1, 'first save', ?)`,
      [id('06'), id('01'), id('05'), id('04')],
    );
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT version_no AS v, body AS b FROM document_versions
        WHERE organization_id = ? AND document_id = ? ORDER BY version_no DESC`,
      [id('01'), id('05')],
    );
    expect(Number(rows[0]?.['v'])).toBe(1);
    expect(String(rows[0]?.['b'])).toBe('first save');

    // Forward-only: a second version at the same number for the same document is a duplicate-key
    // error (the concurrency guard), not a silent second row.
    await expect(
      connection.query(
        `INSERT INTO document_versions
           (id, organization_id, document_id, version_no, body, edited_by_user_id)
         VALUES (?, ?, ?, 1, 'clash', ?)`,
        [id('07'), id('01'), id('05'), id('04')],
      ),
    ).rejects.toThrow(/[Dd]uplicate/);

    // The composite foreign key refuses a document id from outside the version's tenant: the pair
    // (a non-existent org, this document) does not exist even though the document id does. So a
    // version can never reference another tenant's document.
    await expect(
      connection.query(
        `INSERT INTO document_versions
           (id, organization_id, document_id, version_no, body, edited_by_user_id)
         VALUES (?, 'ffffffff-0000-4000-8000-000000000001', ?, 1, 'x', ?)`,
        [id('08'), id('05'), id('04')],
      ),
    ).rejects.toThrow(/foreign key/i);

    // Immutable: the trigger refuses any UPDATE outright — history is append-only.
    await expect(
      connection.query(`UPDATE document_versions SET body = 'tamper' WHERE id = ?`, [id('06')]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('0037: decisions is a tenant-scoped, project-owned, append-only register', () => {
  beforeAll(freshDatabase);

  const id = (n: string) => `00000000-0000-4000-8000-0000000037${n}`;

  it('applies, round-trips, guards the nullable meeting link, and pins its identity columns', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    // The table exists with exactly the columns the Drizzle schema (schema.db.test.ts) mirrors.
    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT column_name AS col, is_nullable AS nullable, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'decisions'`,
    );
    const byName = new Map(columns.map((row) => [String(row['col']), row]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'created_at',
        'decided_at',
        'decided_by',
        'id',
        'meeting_id',
        'organization_id',
        'project_id',
        'statement',
        'status',
        'title',
      ].sort(),
    );
    // A decision's statement is prose a person types — TEXT, and NOT NULL like documents.body.
    expect(String(byName.get('statement')?.['type'])).toBe('text');
    expect(String(byName.get('statement')?.['nullable'])).toBe('NO');
    expect(String(byName.get('status')?.['type'])).toBe('enum');
    expect(String(byName.get('organization_id')?.['nullable'])).toBe('NO');
    expect(String(byName.get('project_id')?.['nullable'])).toBe('NO');
    // The meeting link is optional.
    expect(String(byName.get('meeting_id')?.['nullable'])).toBe('YES');

    // Minimal parents the composite FKs require.
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'dec', 'D')`, [
      id('01'),
    ]);
    await connection.query(
      `INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'W')`,
      [id('02'), id('01')],
    );
    await connection.query(
      `INSERT INTO projects (id, organization_id, workspace_id, name) VALUES (?, ?, ?, 'P')`,
      [id('03'), id('01'), id('02')],
    );
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'dec@e.test', 'D')`,
      [id('04')],
    );
    await connection.query(
      `INSERT INTO meetings (id, organization_id, project_id, title, starts_at, created_by_user_id)
       VALUES (?, ?, ?, 'M', '2026-10-01 14:00:00.000', ?)`,
      [id('05'), id('01'), id('03'), id('04')],
    );

    // A tenant-scoped insert/select round-trips, with the meeting linked.
    await connection.query(
      `INSERT INTO decisions
         (id, organization_id, project_id, meeting_id, title, statement, status, decided_by, decided_at)
       VALUES (?, ?, ?, ?, 'Ship v1', 'we ship', 'accepted', ?, '2026-06-01 09:00:00.000')`,
      [id('06'), id('01'), id('03'), id('05'), id('04')],
    );
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT title, status, meeting_id FROM decisions WHERE organization_id = ? AND id = ?`,
      [id('01'), id('06')],
    );
    expect(rows[0]?.['title']).toBe('Ship v1');
    expect(rows[0]?.['status']).toBe('accepted');
    expect(rows[0]?.['meeting_id']).toBe(id('05'));

    // A decision with no meeting is allowed — the nullable half of the composite key is not checked.
    await connection.query(
      `INSERT INTO decisions
         (id, organization_id, project_id, title, statement, status, decided_by, decided_at)
       VALUES (?, ?, ?, 'No meeting', 'decided by email', 'proposed', ?, '2026-06-02 09:00:00.000')`,
      [id('07'), id('01'), id('03'), id('04')],
    );

    // The composite foreign key refuses a project id from outside the decision's tenant.
    await expect(
      connection.query(
        `INSERT INTO decisions
           (id, organization_id, project_id, title, statement, status, decided_by, decided_at)
         VALUES (?, 'ffffffff-0000-4000-8000-000000000001', ?, 'X', 'y', 'proposed', ?, '2026-06-02 09:00:00.000')`,
        [id('08'), id('03'), id('04')],
      ),
    ).rejects.toThrow(/foreign key/i);

    // A non-null meeting id that does not exist in this tenant is refused by the guarded composite.
    await expect(
      connection.query(
        `INSERT INTO decisions
           (id, organization_id, project_id, meeting_id, title, statement, status, decided_by, decided_at)
         VALUES (?, ?, ?, 'ffffffff-0000-4000-8000-000000000002', 'X', 'y', 'proposed', ?, '2026-06-02 09:00:00.000')`,
        [id('09'), id('01'), id('03'), id('04')],
      ),
    ).rejects.toThrow(/foreign key/i);

    // After 0038 the trigger is a column-pinning one: `status` may move (that is the lifecycle),
    // but the decision's substance is pinned at the engine. A title rewrite is refused.
    await expect(
      connection.query(`UPDATE decisions SET title = 'Rewritten' WHERE id = ?`, [id('06')]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('0038: decision_supersessions is the tenant-scoped supersede-chain edge', () => {
  beforeAll(freshDatabase);

  const id = (n: string) => `00000000-0000-4000-8000-0000000038${n}`;

  it('applies, relaxes the decisions trigger to status, and refuses a cross-tenant or self edge', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT column_name AS col FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'decision_supersessions'`,
    );
    expect(columns.map((row) => String(row['col'])).sort()).toEqual(
      [
        'created_at',
        'created_by',
        'decision_id',
        'id',
        'organization_id',
        'superseded_by_decision_id',
      ].sort(),
    );

    // Minimal parents.
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'sup', 'S')`, [
      id('01'),
    ]);
    await connection.query(
      `INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'W')`,
      [id('02'), id('01')],
    );
    await connection.query(
      `INSERT INTO projects (id, organization_id, workspace_id, name) VALUES (?, ?, ?, 'P')`,
      [id('03'), id('01'), id('02')],
    );
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'sup@e.test', 'S')`,
      [id('04')],
    );
    // Two decisions of the same tenant/project: one to supersede, one that supersedes it.
    await connection.query(
      `INSERT INTO decisions
         (id, organization_id, project_id, title, statement, status, decided_by, decided_at)
       VALUES (?, ?, ?, 'Old', 'the old way', 'accepted', ?, '2026-06-01 09:00:00.000')`,
      [id('05'), id('01'), id('03'), id('04')],
    );
    await connection.query(
      `INSERT INTO decisions
         (id, organization_id, project_id, title, statement, status, decided_by, decided_at)
       VALUES (?, ?, ?, 'New', 'the new way', 'accepted', ?, '2026-06-02 09:00:00.000')`,
      [id('06'), id('01'), id('03'), id('04')],
    );

    // A tenant-scoped edge round-trips, and the superseded decision's status flips — proving the
    // relaxed trigger admits a status UPDATE that 0037's refused outright.
    await connection.query(
      `INSERT INTO decision_supersessions
         (id, organization_id, decision_id, superseded_by_decision_id, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [id('07'), id('01'), id('05'), id('06'), id('04')],
    );
    await connection.query(`UPDATE decisions SET status = 'superseded' WHERE id = ?`, [id('05')]);
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT status FROM decisions WHERE organization_id = ? AND id = ?`,
      [id('01'), id('05')],
    );
    expect(rows[0]?.['status']).toBe('superseded');

    // A decision is superseded at most once: a second edge for the same decision is refused.
    await expect(
      connection.query(
        `INSERT INTO decision_supersessions
           (id, organization_id, decision_id, superseded_by_decision_id, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [id('08'), id('01'), id('05'), id('06'), id('04')],
      ),
    ).rejects.toThrow(/duplicate/i);

    // A decision cannot supersede itself (the CHECK constraint).
    await expect(
      connection.query(
        `INSERT INTO decision_supersessions
           (id, organization_id, decision_id, superseded_by_decision_id, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [id('09'), id('01'), id('06'), id('06'), id('04')],
      ),
    ).rejects.toThrow(checkViolation('chk_decision_supersessions_not_self'));

    // The composite foreign key refuses an edge naming a decision id from outside this tenant.
    await expect(
      connection.query(
        `INSERT INTO decision_supersessions
           (id, organization_id, decision_id, superseded_by_decision_id, created_by)
         VALUES (?, ?, 'ffffffff-0000-4000-8000-000000000001', ?, ?)`,
        [id('0a'), id('01'), id('06'), id('04')],
      ),
    ).rejects.toThrow(/foreign key/i);

    // The edge is itself immutable.
    await expect(
      connection.query(`UPDATE decision_supersessions SET created_by = ? WHERE id = ?`, [
        id('04'),
        id('07'),
      ]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('0039: document_templates is tenant-scoped, org-owned and identity-immutable', () => {
  beforeAll(freshDatabase);

  const id = (n: string) => `00000000-0000-4000-8000-0000000005${n}`;

  it('applies, round-trips a scoped template, and refuses cross-tenant and identity change', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    // The table has exactly the columns the Drizzle schema mirrors.
    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT column_name AS col, is_nullable AS nullable, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'document_templates'`,
    );
    const byName = new Map(columns.map((row) => [String(row['col']), row]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'body',
        'created_at',
        'created_by_user_id',
        'id',
        'name',
        'organization_id',
        'purpose',
      ].sort(),
    );
    expect(String(byName.get('body')?.['type'])).toBe('text');
    expect(String(byName.get('body')?.['nullable'])).toBe('NO');
    expect(String(byName.get('purpose')?.['nullable'])).toBe('NO');

    // Minimal parents the foreign keys require: an organization and a user.
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'dt', 'DT')`, [
      id('01'),
    ]);
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'dt@e.test', 'DT')`,
      [id('02')],
    );

    // A tenant-scoped template insert/select round-trips, and the body is preserved.
    await connection.query(
      `INSERT INTO document_templates (id, organization_id, name, purpose, body, created_by_user_id)
       VALUES (?, ?, 'Kickoff', 'Start a brief', 'template body', ?)`,
      [id('03'), id('01'), id('02')],
    );
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT name AS n, body AS b FROM document_templates
        WHERE organization_id = ? AND id = ?`,
      [id('01'), id('03')],
    );
    expect(String(rows[0]?.['n'])).toBe('Kickoff');
    expect(String(rows[0]?.['b'])).toBe('template body');

    // The foreign key refuses an organization id that does not exist: a template can only ever
    // belong to a real tenant, so it can never reference another (non-existent) organization.
    await expect(
      connection.query(
        `INSERT INTO document_templates (id, organization_id, name, purpose, body, created_by_user_id)
         VALUES (?, 'ffffffff-0000-4000-8000-000000000001', 'X', 'Y', 'Z', ?)`,
        [id('04'), id('02')],
      ),
    ).rejects.toThrow(/foreign key/i);

    // Identity is immutable: the trigger refuses moving a template to another tenant.
    await expect(
      connection.query(
        `UPDATE document_templates SET organization_id = 'ffffffff-0000-4000-8000-000000000001' WHERE id = ?`,
        [id('03')],
      ),
    ).rejects.toThrow(/immutable/);
  });
});

describe('0040: project_objectives is a tenant-scoped, project-owned table with a status lifecycle', () => {
  beforeAll(freshDatabase);

  const id = (n: string) => `00000000-0000-4000-8000-0000000040${n}`;

  it('applies, round-trips, moves status, and pins every other column at the engine', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    // The table exists with exactly the columns the Drizzle schema (schema.db.test.ts) mirrors.
    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT column_name AS col, is_nullable AS nullable, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'project_objectives'`,
    );
    const byName = new Map(columns.map((row) => [String(row['col']), row]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'created_at',
        'created_by',
        'description',
        'id',
        'name',
        'organization_id',
        'project_id',
        'status',
        'target',
      ].sort(),
    );
    expect(String(byName.get('status')?.['type'])).toBe('enum');
    expect(String(byName.get('organization_id')?.['nullable'])).toBe('NO');
    expect(String(byName.get('project_id')?.['nullable'])).toBe('NO');
    expect(String(byName.get('name')?.['nullable'])).toBe('NO');
    // Description and target are optional.
    expect(String(byName.get('description')?.['nullable'])).toBe('YES');
    expect(String(byName.get('target')?.['nullable'])).toBe('YES');

    // Minimal parents the composite FK requires.
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'obj', 'O')`, [
      id('01'),
    ]);
    await connection.query(
      `INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'W')`,
      [id('02'), id('01')],
    );
    await connection.query(
      `INSERT INTO projects (id, organization_id, workspace_id, name) VALUES (?, ?, ?, 'P')`,
      [id('03'), id('01'), id('02')],
    );
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'obj@e.test', 'O')`,
      [id('04')],
    );

    // A tenant-scoped insert/select round-trips, defaulting status to open.
    await connection.query(
      `INSERT INTO project_objectives
         (id, organization_id, project_id, name, description, target, created_by)
       VALUES (?, ?, ?, 'Cut lead time', 'Halve brief-to-draft', '<= 3 days', ?)`,
      [id('05'), id('01'), id('03'), id('04')],
    );
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT name, status, target FROM project_objectives WHERE organization_id = ? AND id = ?`,
      [id('01'), id('05')],
    );
    expect(rows[0]?.['name']).toBe('Cut lead time');
    expect(rows[0]?.['status']).toBe('open');
    expect(rows[0]?.['target']).toBe('<= 3 days');

    // The composite foreign key refuses a project id from outside the objective's tenant.
    await expect(
      connection.query(
        `INSERT INTO project_objectives
           (id, organization_id, project_id, name, created_by)
         VALUES (?, 'ffffffff-0000-4000-8000-000000000001', ?, 'X', ?)`,
        [id('06'), id('03'), id('04')],
      ),
    ).rejects.toThrow(/foreign key/i);

    // The status may move — that is the lifecycle.
    await connection.query(`UPDATE project_objectives SET status = 'met' WHERE id = ?`, [id('05')]);
    const [moved] = await connection.query<RowDataPacket[]>(
      `SELECT status FROM project_objectives WHERE organization_id = ? AND id = ?`,
      [id('01'), id('05')],
    );
    expect(moved[0]?.['status']).toBe('met');

    // But every other column is pinned at the engine: a name rewrite is refused.
    await expect(
      connection.query(`UPDATE project_objectives SET name = 'Rewritten' WHERE id = ?`, [id('05')]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('0041: project_updates is a tenant-scoped, project-owned, forward-only table', () => {
  beforeAll(freshDatabase);

  it('applies, holds a scoped round-trip, gates client visibility, and refuses a cross-tenant or identity change', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    // The table exists with exactly the columns the Drizzle schema (schema.db.test.ts) mirrors.
    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT column_name AS col, is_nullable AS nullable, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'project_updates'`,
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
        'published',
        'title',
        'updated_at',
      ].sort(),
    );
    // The body is prose a person types — TEXT, and NOT NULL like documents.body.
    expect(String(byName.get('body')?.['type'])).toBe('text');
    expect(String(byName.get('body')?.['nullable'])).toBe('NO');
    expect(String(byName.get('organization_id')?.['nullable'])).toBe('NO');
    expect(String(byName.get('project_id')?.['nullable'])).toBe('NO');
    // published is the client-visibility gate — a NOT NULL boolean (tinyint) defaulting to 0.
    expect(String(byName.get('published')?.['nullable'])).toBe('NO');

    const id = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'pu', 'PU')`, [
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
      `INSERT INTO users (id, email, display_name) VALUES (?, 'pu@e.test', 'PU')`,
      [id('c4')],
    );

    // A tenant-scoped insert/select round-trips; the client read predicate is published = 1.
    await connection.query(
      `INSERT INTO project_updates (id, organization_id, project_id, title, body, published, created_by_user_id)
       VALUES (?, ?, ?, 'Kickoff', 'we started', 1, ?)`,
      [id('c5'), id('c1'), id('c3'), id('c4')],
    );
    await connection.query(
      `INSERT INTO project_updates (id, organization_id, project_id, title, body, published, created_by_user_id)
       VALUES (?, ?, ?, 'Draft', 'not yet', 0, ?)`,
      [id('c6'), id('c1'), id('c3'), id('c4')],
    );
    const [published] = await connection.query<RowDataPacket[]>(
      `SELECT title FROM project_updates
        WHERE organization_id = ? AND project_id = ? AND published = 1
        ORDER BY created_at DESC`,
      [id('c1'), id('c3')],
    );
    expect(published.map((row) => String(row['title']))).toEqual(['Kickoff']);

    // The composite foreign key refuses a project id from outside the update's tenant: the pair
    // (a non-existent org, this project) does not exist even though the project id does.
    await expect(
      connection.query(
        `INSERT INTO project_updates (id, organization_id, project_id, title, body, published, created_by_user_id)
         VALUES (?, 'ffffffff-0000-4000-8000-000000000001', ?, 'X', 'y', 1, ?)`,
        [id('c7'), id('c3'), id('c4')],
      ),
    ).rejects.toThrow(/foreign key/i);

    // organization_id, project_id and created_by_user_id are immutable at the engine, not just
    // in the application — re-pointing an update would move it into another client's portal.
    await expect(
      connection.query(
        `UPDATE project_updates SET organization_id = 'ffffffff-0000-4000-8000-000000000001' WHERE id = ?`,
        [id('c5')],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      connection.query(`UPDATE project_updates SET project_id = ? WHERE id = ?`, [
        id('c3'),
        id('c6'),
      ]),
    ).resolves.toBeDefined(); // same project_id is a no-op change, not a move — allowed.
    await expect(
      connection.query(
        `UPDATE project_updates SET created_by_user_id = 'ffffffff-0000-4000-8000-000000000009' WHERE id = ?`,
        [id('c5')],
      ),
    ).rejects.toThrow(/immutable/);
  });
});

describe('0043: meeting_series is a tenant-scoped, org-owned, forward-only table', () => {
  beforeAll(freshDatabase);

  it('applies, round-trips a scoped series, and refuses a non-positive interval', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    // The table exists with exactly the columns the Drizzle schema (schema.db.test.ts) mirrors.
    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT column_name AS col, is_nullable AS nullable, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'meeting_series'`,
    );
    const byName = new Map(columns.map((row) => [String(row['col']), row]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'created_at',
        'created_by_user_id',
        'freq',
        'id',
        'organization_id',
        'recurrence_interval',
        'title',
        'until',
      ].sort(),
    );
    // freq is an ENUM; until is a nullable DATE (an open-ended series); org is not nullable.
    expect(String(byName.get('freq')?.['type'])).toBe('enum');
    expect(String(byName.get('until')?.['type'])).toBe('date');
    expect(String(byName.get('until')?.['nullable'])).toBe('YES');
    expect(String(byName.get('organization_id')?.['nullable'])).toBe('NO');

    const id = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'ser', 'S')`, [
      id('d1'),
    ]);
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'ser@e.test', 'S')`,
      [id('d2')],
    );

    // A tenant-scoped insert/select round-trips, and the open-ended series stores a NULL `until`.
    await connection.query(
      `INSERT INTO meeting_series (id, organization_id, title, freq, recurrence_interval, until, created_by_user_id)
       VALUES (?, ?, 'Weekly sync', 'weekly', 2, NULL, ?)`,
      [id('d3'), id('d1'), id('d2')],
    );
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT title, freq, recurrence_interval AS iv, until
         FROM meeting_series WHERE organization_id = ? AND id = ?`,
      [id('d1'), id('d3')],
    );
    expect(rows[0]?.['title']).toBe('Weekly sync');
    expect(String(rows[0]?.['freq'])).toBe('weekly');
    expect(Number(rows[0]?.['iv'])).toBe(2);
    expect(rows[0]?.['until']).toBeNull();

    // The CHECK refuses a non-positive interval at the engine — "every 0 periods" is not a recurrence.
    await expect(
      connection.query(
        `INSERT INTO meeting_series (id, organization_id, title, freq, recurrence_interval, created_by_user_id)
         VALUES (?, ?, 'Bad', 'daily', 0, ?)`,
        [id('d4'), id('d1'), id('d2')],
      ),
    ).rejects.toThrow(checkViolation('ck_meeting_series_interval_positive'));
  });
});

describe('0044: document_template_variables is tenant-scoped, template-owned and identity-immutable', () => {
  beforeAll(freshDatabase);

  const id = (n: string) => `00000000-0000-4000-8000-0000000006${n}`;

  it('applies, round-trips a scoped variable, and refuses cross-tenant and identity change', async () => {
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 'migrator.db.test' });

    // The table has exactly the columns the Drizzle schema mirrors.
    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT column_name AS col, is_nullable AS nullable, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'document_template_variables'`,
    );
    const byName = new Map(columns.map((row) => [String(row['col']), row]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'created_at',
        'id',
        'key',
        'label',
        'organization_id',
        'required',
        'template_id',
        'type',
      ].sort(),
    );
    expect(String(byName.get('type')?.['type'])).toBe('enum');
    expect(String(byName.get('required')?.['nullable'])).toBe('NO');

    // Minimal parents: an organization, a user, and a template that owns the variable.
    await connection.query(`INSERT INTO organizations (id, slug, name) VALUES (?, 'dtv', 'DTV')`, [
      id('01'),
    ]);
    await connection.query(
      `INSERT INTO users (id, email, display_name) VALUES (?, 'dtv@e.test', 'DTV')`,
      [id('02')],
    );
    await connection.query(
      `INSERT INTO document_templates (id, organization_id, name, purpose, body, created_by_user_id)
       VALUES (?, ?, 'Kickoff', 'Start', 'body', ?)`,
      [id('03'), id('01'), id('02')],
    );

    // A tenant-scoped variable insert/select round-trips.
    await connection.query(
      `INSERT INTO document_template_variables (id, organization_id, template_id, \`key\`, label, type, required)
       VALUES (?, ?, ?, 'client_name', 'Client name', 'text', 1)`,
      [id('04'), id('01'), id('03')],
    );
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT \`key\` AS k, required AS r FROM document_template_variables
        WHERE organization_id = ? AND id = ?`,
      [id('01'), id('04')],
    );
    expect(String(rows[0]?.['k'])).toBe('client_name');
    expect(Number(rows[0]?.['r'])).toBe(1);

    // A template cannot declare the same key twice: the unique index refuses it.
    await expect(
      connection.query(
        `INSERT INTO document_template_variables (id, organization_id, template_id, \`key\`, label, type, required)
         VALUES (?, ?, ?, 'client_name', 'Dup', 'text', 0)`,
        [id('05'), id('01'), id('03')],
      ),
    ).rejects.toThrow(/duplicate/i);

    // The composite foreign key refuses a template that does not exist in this tenant.
    await expect(
      connection.query(
        `INSERT INTO document_template_variables (id, organization_id, template_id, \`key\`, label, type, required)
         VALUES (?, ?, 'ffffffff-0000-4000-8000-000000000001', 'x', 'X', 'text', 0)`,
        [id('06'), id('01')],
      ),
    ).rejects.toThrow(/foreign key/i);

    // Identity is immutable: the trigger refuses moving a variable to another template.
    await expect(
      connection.query(
        `UPDATE document_template_variables SET template_id = 'ffffffff-0000-4000-8000-000000000001' WHERE id = ?`,
        [id('04')],
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
