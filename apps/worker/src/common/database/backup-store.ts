import { createConnection } from 'mysql2';
import type { Connection as CoreConnection, FieldPacket, RowDataPacket } from 'mysql2';
import type { Connection } from 'mysql2/promise';

import type { DumpColumn, DumpObject, DumpRoutine, DumpSource } from './backup-dump.js';
import { quoteIdentifier } from './backup-dump.js';

/**
 * OFFSITE-BACKUP. The database side of the off-site backup job: one connection on the operator
 * credential (`DATABASE_MIGRATION_URL`, the one that can read every table, trigger and routine
 * and write `platform_backup_runs`; the runtime and worker users only read that table, 0253).
 *
 * The dump runs inside `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY` at REPEATABLE
 * READ: the InnoDB snapshot `mysqldump --single-transaction` takes, without `LOCK TABLES` (which
 * a shared-hosting user may lack) and without blocking any writer. Every statement here is a
 * read except {@link BackupSession.recordRun}, which runs after the snapshot is closed.
 *
 * MariaDB-safe: only `information_schema` columns both engines have, and the `SHOW CREATE …`
 * statements both engines answer. The session's own `max_statement_time` is lifted for the
 * dump connection only (MariaDB's name; MySQL's `max_execution_time` covers SELECTs), so a
 * large table is not cut off by the worker pool's 15 s cap, which this connection never had.
 */

/** A row of `platform_backup_runs` (0253) as the off-site job writes it. */
export interface BackupRunRecord {
  readonly id: string;
  readonly kind: 'scheduled' | 'manual';
  readonly frequencyKind: 'daily' | 'manual';
  readonly stamp: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly status: 'ok' | 'failed';
  readonly dbBytes: number | null;
  readonly manifestSha: string | null;
  readonly gitSha: string | null;
  readonly offsiteStatus: 'uploaded' | 'failed';
  readonly offsiteLocation: string;
  readonly offsiteAt: Date | null;
  readonly error: string | null;
}

/** The two instants the schedule needs, for runs that went to OCI (`offsite_location oci:…`). */
export interface OffsiteRunTimes {
  readonly lastSuccessAt: Date | null;
  readonly lastAttemptAt: Date | null;
}

export interface BackupSession {
  readonly database: string;
  offsiteRunTimes(): Promise<OffsiteRunTimes>;
  /** Opens the consistent snapshot and returns the dump source on it. */
  beginSnapshot(): Promise<DumpSource>;
  /** Closes the snapshot (a read-only transaction: COMMIT and ROLLBACK are the same). */
  endSnapshot(): Promise<void>;
  /** The applied migration versions of the ledger, ascending. */
  appliedMigrations(): Promise<readonly number[]>;
  recordRun(run: BackupRunRecord): Promise<void>;
  close(): Promise<void>;
}

export const BACKUP_SQL = {
  runTimes:
    "SELECT MAX(CASE WHEN status = 'ok' AND offsite_status = 'uploaded' THEN finished_at END) AS last_success, MAX(started_at) AS last_attempt FROM platform_backup_runs WHERE kind <> 'drill' AND offsite_location LIKE 'oci:%'",
  insertRun:
    'INSERT INTO platform_backup_runs (id, kind, frequency_kind, stamp, started_at, finished_at, status, db_bytes, uploads_bytes, manifest_sha, git_sha, offsite_status, offsite_location, offsite_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)',
  baseTables:
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
  views:
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'VIEW' ORDER BY TABLE_NAME",
  columns:
    'SELECT COLUMN_NAME AS name, DATA_TYPE AS data_type, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
  routines:
    'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS kind FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_TYPE, ROUTINE_NAME',
  events:
    'SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() ORDER BY EVENT_NAME',
  triggers:
    'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER, TRIGGER_NAME',
  ledger: "SELECT version FROM schema_migrations WHERE status = 'applied' ORDER BY version",
} as const;

type Rows = readonly Record<string, unknown>[];

const text = (row: Record<string, unknown> | undefined, column: string): string => {
  const value = row?.[column];
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  throw new Error(`expected text in column ${column}`);
};

/**
 * The `SHOW CREATE …` answer's statement column. NULL means the credential may not see the
 * body (a routine of another definer, without the privilege): a dump without it is not a
 * backup, so that is an error, never a silent gap.
 */
const createStatement = (rows: Rows, column: string, what: string): string => {
  const value = rows[0]?.[column];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${what}: SHOW CREATE returned no statement (missing privilege?)`);
  }
  return value;
};

const asDate = (value: unknown): Date | null =>
  value === null || value === undefined ? null : new Date(value as string | Date);

/** The one statement runner the session uses, so the shape is testable without a server. */
export interface BackupConnection {
  query(sql: string, params?: readonly unknown[]): Promise<Rows>;
  /** Rows as arrays of raw bytes (`typeCast: false`), streamed with back-pressure. */
  stream(sql: string): AsyncIterable<readonly (Buffer | null)[]>;
  close(): Promise<void>;
}

/** The session over any {@link BackupConnection}: the unit-tested core of {@link openBackupSession}. */
export function createBackupSession(
  connection: BackupConnection,
  database: string,
  serverVersion: string,
): BackupSession {
  const show = async (sql: string, column: string, what: string): Promise<string> =>
    createStatement(await connection.query(sql), column, what);

  const source: DumpSource = {
    database,
    serverVersion,
    baseTables: async () =>
      (await connection.query(BACKUP_SQL.baseTables)).map((r) => text(r, 'name')),
    views: async () => {
      const names = (await connection.query(BACKUP_SQL.views)).map((r) => text(r, 'name'));
      const out: DumpObject[] = [];
      for (const name of names) {
        out.push({
          name,
          statement: await show(
            `SHOW CREATE VIEW ${quoteIdentifier(name)}`,
            'Create View',
            `view ${name}`,
          ),
        });
      }
      return out;
    },
    columns: async (table): Promise<readonly DumpColumn[]> =>
      (await connection.query(BACKUP_SQL.columns, [table])).map((r) => ({
        name: text(r, 'name'),
        dataType: text(r, 'data_type'),
        extra: text(r, 'extra'),
      })),
    createTable: (table) =>
      show(`SHOW CREATE TABLE ${quoteIdentifier(table)}`, 'Create Table', `table ${table}`),
    routines: async () => {
      const out: DumpRoutine[] = [];
      for (const r of await connection.query(BACKUP_SQL.routines)) {
        const name = text(r, 'name');
        const kind = text(r, 'kind') === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
        const rows = await connection.query(`SHOW CREATE ${kind} ${quoteIdentifier(name)}`);
        out.push({
          name,
          kind,
          statement: createStatement(
            rows,
            kind === 'FUNCTION' ? 'Create Function' : 'Create Procedure',
            `${kind.toLowerCase()} ${name}`,
          ),
          sqlMode: text(rows[0], 'sql_mode'),
        });
      }
      return out;
    },
    events: async () => {
      const out: DumpObject[] = [];
      for (const r of await connection.query(BACKUP_SQL.events)) {
        const name = text(r, 'name');
        const rows = await connection.query(`SHOW CREATE EVENT ${quoteIdentifier(name)}`);
        out.push({
          name,
          statement: createStatement(rows, 'Create Event', `event ${name}`),
          sqlMode: text(rows[0], 'sql_mode'),
        });
      }
      return out;
    },
    triggers: async () => {
      const out: DumpObject[] = [];
      for (const r of await connection.query(BACKUP_SQL.triggers)) {
        const name = text(r, 'name');
        const rows = await connection.query(`SHOW CREATE TRIGGER ${quoteIdentifier(name)}`);
        out.push({
          name,
          statement: createStatement(rows, 'SQL Original Statement', `trigger ${name}`),
          sqlMode: text(rows[0], 'sql_mode'),
        });
      }
      return out;
    },
    rows: (table, columns) =>
      connection.stream(
        `SELECT ${columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)}`,
      ),
  };

  return {
    database,
    async offsiteRunTimes() {
      const row = (await connection.query(BACKUP_SQL.runTimes))[0];
      return {
        lastSuccessAt: asDate(row?.['last_success']),
        lastAttemptAt: asDate(row?.['last_attempt']),
      };
    },
    async beginSnapshot() {
      await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      return source;
    },
    async endSnapshot() {
      await connection.query('COMMIT');
    },
    async appliedMigrations() {
      return (await connection.query(BACKUP_SQL.ledger)).map((r) => Number(r['version']));
    },
    async recordRun(run) {
      await connection.query(BACKUP_SQL.insertRun, [
        run.id,
        run.kind,
        run.frequencyKind,
        run.stamp,
        run.startedAt,
        run.finishedAt,
        run.status,
        run.dbBytes,
        run.manifestSha,
        run.gitSha,
        run.offsiteStatus,
        run.offsiteLocation,
        run.offsiteAt,
        run.error === null ? null : run.error.slice(0, 500),
      ]);
    },
    close: () => connection.close(),
  };
}

/** mysql2's row stream as an async iterable of raw-byte arrays. */
function streamRaw(core: CoreConnection, sql: string): AsyncIterable<readonly (Buffer | null)[]> {
  return core
    .query({ sql, typeCast: false, rowsAsArray: true })
    .stream({ highWaterMark: 256 }) as AsyncIterable<readonly (Buffer | null)[]>;
}

/**
 * Opens the backup session on `url` (the operator credential). Session state: UTC (TIMESTAMP
 * values are read in UTC, and the dump header sets UTC for the replay), an empty `sql_mode` and
 * quoted identifiers so `SHOW CREATE` output is the portable form, no statement time cap.
 */
export async function openBackupSession(url: string): Promise<BackupSession> {
  const core = createConnection({
    uri: url,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    multipleStatements: false,
    connectTimeout: 20_000,
  });
  // A fatal socket error is also emitted on the connection; without a listener Node would
  // throw it and take the whole app down. The command in flight rejects with it anyway.
  core.on('error', () => undefined);
  const conn: Connection = core.promise();
  const connection: BackupConnection = {
    query: async (sql, params = []) => {
      const [rows] = (await conn.query(sql, params as unknown[])) as [unknown, FieldPacket[]];
      return Array.isArray(rows) ? (rows as RowDataPacket[]) : [];
    },
    stream: (sql) => streamRaw(core, sql),
    // `end` waits for the command queue; a result abandoned mid-stream would make it wait for
    // ever, so after a short grace the socket is destroyed (the server rolls back the snapshot).
    close: async () => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        conn.end().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
      core.destroy();
    },
  };
  try {
    await connection.query(
      "SET SESSION time_zone = '+00:00', sql_mode = '', sql_quote_show_create = 1",
    );
    const identity = (await connection.query('SELECT VERSION() AS v, DATABASE() AS db'))[0];
    const version = text(identity, 'v');
    const database = text(identity, 'db');
    const capOff = /mariadb/iu.test(version)
      ? 'SET SESSION max_statement_time = 0'
      : 'SET SESSION max_execution_time = 0';
    await connection.query(capOff).catch(() => {
      // A server that refuses the variable has no cap to lift.
    });
    return createBackupSession(connection, database, version);
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}
