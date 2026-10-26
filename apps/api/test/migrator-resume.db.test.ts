import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { createMigrationConnection } from '../src/common/database/connection.js';
import {
  MigrationError,
  PartialMigrationError,
  loadMigrations,
  migrate,
  migrationStatus,
  readLedger,
  resetDatabase,
} from '../src/common/database/migrator.js';
import { startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';

/**
 * Resuming a migration a killed process left `running` — the 2026-10-26 release-night outage.
 *
 * Hostinger's deploy SIGTERMed the first process 64 ms into 0237. Nine statements had
 * committed, the counter said eight (the kill landed between a DDL commit and its counter
 * update), and every later start refused to migrate: 32 minutes down until a human repaired
 * the row. These cases put the ledger in exactly that state — the file's first `committed`
 * statements really applied, the row recording `recorded` of them — and assert the migrator
 * now finishes the file by itself, while everything a human must decide is still refused.
 */

let db: TestDatabase;
let connection: Connection;

beforeAll(async () => {
  db = await startTestDatabase({ applyMigrations: false, scratch: true });
  connection = await createMigrationConnection(db.url);
});

afterAll(async () => {
  await connection?.end();
  await db?.stop();
});

beforeEach(async () => {
  await resetDatabase(connection);
});

async function migrationDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tmanage-migrations-resume-'));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents, 'utf8');
  }
  return dir;
}

/**
 * Leave `version` exactly as a process killed mid-file leaves it: statements
 * `0 .. committed - 1` really applied, the ledger row `running` with `recorded` counted.
 * `recorded` is `committed` (killed before the next statement) or `committed - 1` (killed
 * between a DDL commit and its counter update — the release-night case).
 */
async function simulateKill(
  dir: string,
  version: number,
  committed: number,
  recorded: number,
): Promise<void> {
  const file = (await loadMigrations(dir)).find((f) => f.version === version);
  if (!file) throw new Error(`no file for version ${version}`);
  // Creates the ledger table, exactly as any run does first.
  await migrationStatus(connection, dir);
  for (const statement of file.statements.slice(0, committed)) {
    await connection.query(statement);
  }
  await connection.execute(
    `INSERT INTO schema_migrations
       (version, name, checksum, status, statements_total, statements_applied,
        applied_by, started_at)
     VALUES (?, ?, ?, 'running', ?, ?, 'killed-process', NOW(3))`,
    [file.version, file.name, file.checksum, file.statements.length, recorded],
  );
}

async function tables(): Promise<string[]> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name <> 'schema_migrations'`,
  );
  return rows.map((r) => String(r['t'])).sort();
}

async function triggers(): Promise<string[]> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT trigger_name AS t FROM information_schema.triggers
      WHERE trigger_schema = DATABASE()`,
  );
  return rows.map((r) => String(r['t'])).sort();
}

async function columns(table: string): Promise<string[]> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT column_name AS c FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => String(r['c']));
}

async function expectApplied(version: number, total: number): Promise<void> {
  const row = (await readLedger(connection)).find((r) => r.version === version);
  expect(row?.status).toBe('applied');
  expect(row?.statementsApplied).toBe(total);
  expect(row?.statementsTotal).toBe(total);
  expect(row?.failedStatementIndex).toBeNull();
}

const THREE_TABLES = {
  '0001_three_tables.sql': [
    'CREATE TABLE alpha (a INT) ENGINE=InnoDB;',
    'CREATE TABLE beta (b INT) ENGINE=InnoDB;',
    'CREATE TABLE gamma (c INT) ENGINE=InnoDB;',
  ].join('\n'),
};

const trigger = (name: string, table: string): string =>
  `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} FOR EACH ROW
BEGIN
  IF NEW.id <> OLD.id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${name}: id is immutable';
  END IF;
END$$`;

// The shape of 0237: tables, then one immutability trigger per table.
const TABLES_AND_TRIGGERS = {
  '0001_tables_and_triggers.sql': [
    'CREATE TABLE guests (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB;',
    'CREATE TABLE attachments (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB;',
    'DELIMITER $$',
    trigger('trg_guests_immutable', 'guests'),
    trigger('trg_attachments_immutable', 'attachments'),
    'DELIMITER ;',
  ].join('\n'),
};

const ALTERS = {
  '0001_alters.sql': [
    'CREATE TABLE meetings (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB;',
    'ALTER TABLE meetings ADD COLUMN calendar_id INT NULL;',
    'ALTER TABLE meetings ADD INDEX ix_meetings_calendar (calendar_id);',
    'ALTER TABLE meetings ADD COLUMN synced_at DATETIME(3) NULL;',
  ].join('\n'),
};

describe('resuming a running row left by a killed process', () => {
  it('CREATE TABLE, lag 0: continues from the recorded statement', async () => {
    const dir = await migrationDir(THREE_TABLES);
    await simulateKill(dir, 1, 1, 1);

    const report = await migrate(connection, { directory: dir });
    expect(report.resumed).toBe(1);
    expect(report.applied.map((f) => f.version)).toEqual([1]);
    expect(await tables()).toEqual(['alpha', 'beta', 'gamma']);
    await expectApplied(1, 3);
  });

  it('CREATE TABLE, lag 1: the statement that landed uncounted is recognised, not refused', async () => {
    const dir = await migrationDir(THREE_TABLES);
    await simulateKill(dir, 1, 2, 1);

    const lines: string[] = [];
    const report = await migrate(connection, { directory: dir, log: (l) => lines.push(l) });
    expect(report.resumed).toBe(1);
    expect(await tables()).toEqual(['alpha', 'beta', 'gamma']);
    await expectApplied(1, 3);
    expect(lines.join('\n')).toMatch(/resuming 0001_three_tables\.sql at statement 2 of 3/);
    expect(lines.join('\n')).toMatch(/statement 2 had landed before the previous process died/);
  });

  it('lag 1 on the very first statement (killed before its first counter update)', async () => {
    const dir = await migrationDir(THREE_TABLES);
    await simulateKill(dir, 1, 1, 0);

    await migrate(connection, { directory: dir });
    expect(await tables()).toEqual(['alpha', 'beta', 'gamma']);
    await expectApplied(1, 3);
  });

  it('CREATE TRIGGER, lag 0 and lag 1 (the release-night 0237 case)', async () => {
    for (const [committed, recorded] of [
      [3, 3],
      [3, 2],
      [4, 3],
    ] as const) {
      await resetDatabase(connection);
      const dir = await migrationDir(TABLES_AND_TRIGGERS);
      await simulateKill(dir, 1, committed, recorded);

      const report = await migrate(connection, { directory: dir });
      expect(report.resumed).toBe(1);
      expect(await triggers()).toEqual(['trg_attachments_immutable', 'trg_guests_immutable']);
      await expectApplied(1, 4);
    }
  });

  it('ALTER ADD COLUMN and ADD INDEX, lag 0 and lag 1', async () => {
    for (const [committed, recorded] of [
      [2, 2],
      [2, 1], // ADD COLUMN landed uncounted: 1060 duplicate column
      [3, 2], // ADD INDEX landed uncounted: 1061 duplicate key name
      [4, 3], // the last statement landed uncounted
    ] as const) {
      await resetDatabase(connection);
      const dir = await migrationDir(ALTERS);
      await simulateKill(dir, 1, committed, recorded);

      await migrate(connection, { directory: dir });
      expect(await columns('meetings')).toEqual(['id', 'calendar_id', 'synced_at']);
      await expectApplied(1, 4);
    }
  });

  it('then applies the files after the resumed one', async () => {
    const dir = await migrationDir({
      ...THREE_TABLES,
      '0002_next.sql': 'CREATE TABLE delta (d INT) ENGINE=InnoDB;',
    });
    await simulateKill(dir, 1, 2, 1);

    const report = await migrate(connection, { directory: dir });
    expect(report.applied.map((f) => f.version)).toEqual([1, 2]);
    expect(await tables()).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    await expectApplied(1, 3);
    await expectApplied(2, 1);
  });

  it('does NOT swallow an already-exists error from a later statement', async () => {
    const dir = await migrationDir(THREE_TABLES);
    await simulateKill(dir, 1, 1, 1);
    // `gamma` exists for a reason the ledger cannot account for: statement 3 was never run
    // by the migrator, so its "already exists" is a real conflict, not a lost counter.
    await connection.query('CREATE TABLE gamma (other INT) ENGINE=InnoDB');

    const error = await migrate(connection, { directory: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartialMigrationError);
    expect((error as PartialMigrationError).statementIndex).toBe(2);
    const row = (await readLedger(connection))[0];
    expect(row?.status).toBe('failed');
    expect(row?.statementsApplied).toBe(2);
    expect(row?.failedStatementIndex).toBe(2);
    expect(row?.failureMessage).toMatch(/gamma/);
  });

  it('marks the row failed when the resumed statement fails for any other reason', async () => {
    const dir = await migrationDir({
      '0001_bad.sql': [
        'CREATE TABLE alpha (a INT) ENGINE=InnoDB;',
        'ALTER TABLE no_such_table ADD COLUMN x INT;',
      ].join('\n'),
    });
    await simulateKill(dir, 1, 1, 1);

    const error = await migrate(connection, { directory: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartialMigrationError);
    expect((await readLedger(connection))[0]?.status).toBe('failed');
  });

  it('cannot be resumed by two processes at once: the advisory lock still applies', async () => {
    const dir = await migrationDir(THREE_TABLES);
    await simulateKill(dir, 1, 2, 1);
    const other = await createMigrationConnection(db.url);
    try {
      await other.query("SELECT GET_LOCK('tmanage:migrations', 5)");
      await expect(migrate(connection, { directory: dir, lockTimeoutSeconds: 1 })).rejects.toThrow(
        /Another migration is already running/,
      );
    } finally {
      await other.query("SELECT RELEASE_LOCK('tmanage:migrations')");
      await other.end();
    }
    // Untouched: still running, still one behind.
    const row = (await readLedger(connection))[0];
    expect(row?.status).toBe('running');
    expect(row?.statementsApplied).toBe(1);
  });
});

describe('what a resume still refuses', () => {
  it("a 'failed' row still refuses every run", async () => {
    const dir = await migrationDir(THREE_TABLES);
    await simulateKill(dir, 1, 1, 1);
    await connection.query(
      `UPDATE schema_migrations SET status = 'failed', failed_statement_index = 1,
              failure_message = 'boom' WHERE version = 1`,
    );

    const error = await migrate(connection, { directory: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect(error).not.toBeInstanceOf(PartialMigrationError);
    expect((error as MigrationError).message).toMatch(/partially-applied/);
    expect((error as MigrationError).message).toMatch(/needs a human decision/);
    expect(await tables()).toEqual(['alpha']);
  });

  it('a running row whose file was edited since it started (checksum mismatch)', async () => {
    const dir = await migrationDir(THREE_TABLES);
    await simulateKill(dir, 1, 2, 1);
    const edited = await migrationDir({
      '0001_three_tables.sql': THREE_TABLES['0001_three_tables.sql'] + '\n-- edited\n',
    });

    const error = await migrate(connection, { directory: edited }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).message).toMatch(/file changed since it was started/);
    expect(await tables()).toEqual(['alpha', 'beta']);
    expect((await readLedger(connection))[0]?.status).toBe('running');
  });

  it('a running row that is not the latest recorded version', async () => {
    const dir = await migrationDir({
      ...THREE_TABLES,
      '0002_next.sql': 'CREATE TABLE delta (d INT) ENGINE=InnoDB;',
    });
    await simulateKill(dir, 1, 1, 1);
    await connection.query(
      `INSERT INTO schema_migrations
         (version, name, checksum, status, statements_total, statements_applied,
          applied_by, started_at)
       SELECT 2, 'next', checksum, 'applied', 1, 1, 'x', NOW(3) FROM schema_migrations
        WHERE version = 1`,
    );

    await expect(migrate(connection, { directory: dir })).rejects.toThrow(
      /a later version than 1 is already recorded/,
    );
  });
});

describe('data statements cannot leave the counter behind', () => {
  it('commit together with their counter, and a failing one leaves nothing behind', async () => {
    const dir = await migrationDir({
      '0001_data.sql': [
        'CREATE TABLE seeds (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB;',
        'INSERT INTO seeds (id) VALUES (1);',
        'INSERT INTO seeds (id) VALUES (2), (1);',
      ].join('\n'),
    });

    const error = await migrate(connection, { directory: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartialMigrationError);
    const row = (await readLedger(connection))[0];
    expect(row?.statementsApplied).toBe(2);
    expect(row?.failedStatementIndex).toBe(2);
    // The failing multi-row INSERT was rolled back whole: no stray (2).
    const [rows] = await connection.query<RowDataPacket[]>('SELECT id FROM seeds ORDER BY id');
    expect(rows.map((r) => Number(r['id']))).toEqual([1]);
  });
});

describe('shouldStop: a shutdown between files', () => {
  it('finishes the file in progress, starts no further one, and the next run continues', async () => {
    const dir = await migrationDir({
      '0001_first.sql': 'CREATE TABLE first_t (a INT) ENGINE=InnoDB;',
      '0002_second.sql': 'CREATE TABLE second_t (a INT) ENGINE=InnoDB;',
    });
    let asked = 0;
    const report = await migrate(connection, {
      directory: dir,
      // Asked before each file: no on the first, yes (SIGTERM arrived) on the second.
      shouldStop: () => {
        asked += 1;
        return asked > 1;
      },
    });
    expect(report.stopped).toBe(true);
    expect(report.applied.map((f) => f.version)).toEqual([1]);
    expect(await tables()).toEqual(['first_t']);
    await expectApplied(1, 1);

    const next = await migrate(connection, { directory: dir });
    expect(next.stopped).toBe(false);
    expect(next.applied.map((f) => f.version)).toEqual([2]);
  });
});
