import { createPool } from 'mysql2/promise';

/**
 * LOGQUIET-a — one MariaDB named lock per scheduled sweep, so two app processes (a restart that
 * overlaps the old one, a second instance) never run the same sweep at once. The sweeps were
 * already idempotent across instances; this removes the doubled load and the doubled log lines.
 *
 * `GET_LOCK(name, 0)` never waits: a lock another session holds means "the other process is
 * running it", and this process skips the pass silently. The lock is released right after the
 * pass. The name carries the schema name, because named locks are server-wide and a shared
 * MariaDB server hosts other customers' databases; it is cut to MariaDB's 64-character limit.
 *
 * The locks live on a connection of their own (a one-connection pool): a session holds its named
 * locks, and the sweeps' pool is a single connection the pass itself needs. MariaDB lets one
 * session hold many named locks, and both statements return at once, so the sweeps share it. A
 * session can re-take a lock it already holds, so a pass of the same name already running in this
 * process is skipped here too. A lost connection releases its locks; the release then finds
 * nothing and is ignored.
 */

/** One statement on the lock connection: the rows of a single-row SELECT. */
export type SweepLockQuery = (sql: string, params: readonly unknown[]) => Promise<unknown>;

export type SweepLockOutcome<T> =
  { readonly ran: true; readonly result: T } | { readonly ran: false };

export interface SweepLock {
  /** Runs `work` only while this process holds the sweep's lock; `ran: false` when it does not. */
  run<T>(name: string, work: () => Promise<T>): Promise<SweepLockOutcome<T>>;
  end(): Promise<void>;
}

const LOCK_NAME_SQL = `LEFT(CONCAT(COALESCE(DATABASE(), ''), ':sweep:', ?), 64)`;
const ACQUIRE_SQL = `SELECT GET_LOCK(${LOCK_NAME_SQL}, 0) AS acquired`;
const RELEASE_SQL = `SELECT RELEASE_LOCK(${LOCK_NAME_SQL}) AS released`;

function firstValue(rows: unknown, column: string): unknown {
  if (!Array.isArray(rows)) return undefined;
  const row: unknown = rows[0];
  if (typeof row !== 'object' || row === null) return undefined;
  return (row as Record<string, unknown>)[column];
}

/** The lock over any query function: the unit-tested core of {@link createSweepLockDatabase}. */
export function createSweepLock(query: SweepLockQuery, end: () => Promise<void>): SweepLock {
  const held = new Set<string>();
  return {
    async run<T>(name: string, work: () => Promise<T>): Promise<SweepLockOutcome<T>> {
      if (held.has(name)) return { ran: false };
      const acquired = firstValue(await query(ACQUIRE_SQL, [name]), 'acquired');
      if (Number(acquired) !== 1) return { ran: false };
      held.add(name);
      try {
        return { ran: true, result: await work() };
      } finally {
        held.delete(name);
        await query(RELEASE_SQL, [name]).catch(() => {
          // A lost connection already released the lock.
        });
      }
    },
    end,
  };
}

export interface SweepLockDatabaseOptions {
  /** The sweeps' own database URL (the worker's credential); a named lock needs no grant. */
  readonly url: string;
}

/** The lock on its own one-connection pool, ended with the sweeps. */
export function createSweepLockDatabase(options: SweepLockDatabaseOptions): SweepLock {
  const pool = createPool({
    uri: options.url,
    connectionLimit: 1,
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    multipleStatements: false,
  });
  return createSweepLock(
    async (sql, params) => {
      const [rows] = await pool.query(sql, params as unknown[]);
      return rows;
    },
    () => pool.end(),
  );
}
