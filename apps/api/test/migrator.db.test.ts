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
  // MariaDB it would destroy the schema the isolation corpus and the least-privilege suite
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
