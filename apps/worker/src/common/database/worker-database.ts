import { createPool } from 'mysql2/promise';
import type { Connection, Pool, PoolConnection, PoolOptions } from 'mysql2/promise';

/**
 * The worker's database handle — PLAT-004's second half.
 *
 * This is the one directory in `apps/worker` permitted to hold a driver handle or spell
 * SQL (`eslint.config.js`, the same allowlist that governs the API). Everything above it —
 * the dispatcher, the consumers — works through {@link WorkerTransaction} and the store
 * functions beside this file, so a consumer cannot write a statement nobody reviewed.
 *
 * ## Why there is no tenant guard here
 *
 * Deliberate, and narrower than it sounds. The relay's claim query is the canonical
 * unscoped statement — `tenant-context.ts` names it as exactly that: it takes the oldest
 * unpublished events *across every organization*, so no `organization_id` predicate exists
 * to write. What replaces the guard is the credential: `scripts/db/users.sql` gives
 * `tmanage_worker` SELECT, INSERT and UPDATE on the handful of tables the relay touches
 * and **DELETE on nothing**, so the blast radius of a defective consumer is bounded by the
 * grants rather than by this process's correctness. Every *per-event* statement in the
 * store files still carries the event's own `organization_id`, and the db suite asserts
 * the consumer cannot cross tenants — the discipline holds, enforced by review and test
 * where the API enforces it by analysis.
 *
 * ## Session state
 *
 * The same settings as the API's pool, for the same reasons: `STRICT_ALL_TABLES` so a
 * truncated CHAR(36) is an error rather than a different UUID, UTC so `DATETIME(3)`
 * comparisons agree with the application clock, and MySQL's `max_execution_time` as the
 * statement timeout — which caps reads only, so a runaway write must be bounded by the
 * query itself. See `connection.ts` for the full note.
 */

const SESSION_SQL_MODE =
  'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,' +
  'NO_ENGINE_SUBSTITUTION';

const BASE_OPTIONS = {
  // A second statement smuggled into one call is how injection turns one reviewed query
  // into two. Off by default in mysql2; stated so turning it on is a visible edit.
  multipleStatements: false,
  charset: 'utf8mb4_unicode_ci',
  timezone: 'Z',
  // DATE columns come back as the `'YYYY-MM-DD'` strings they are, matching the API pool
  // (`connection.ts`) since migration 0012. Left at `false`, mysql2 inflates a DATE into a JS
  // `Date` — at UTC midnight, given the `timezone: 'Z'` above — and a consumer that renders
  // one gets a full timestamp instead of a calendar day, printing the *previous* day for any
  // reader west of UTC. The client-request mailer renders exactly these two columns. That is
  // the defect 0012 exists to remove, and this is the same removal on the relay's pool.
  // DATETIME/TIMESTAMP keep their `Date` inflation: the relay compares `occurred_at` and
  // `available_at` as instants, and the worker has no Drizzle proxy to satisfy.
  dateStrings: ['DATE'],
  supportBigNumbers: true,
  bigNumberStrings: false,
  namedPlaceholders: false,
} satisfies Partial<PoolOptions>;

async function applySessionState(
  connection: Connection,
  statementTimeoutMs: number,
): Promise<void> {
  await connection.query(`SET SESSION sql_mode = ?, time_zone = '+00:00'`, [SESSION_SQL_MODE]);
  try {
    await connection.query('SET SESSION max_execution_time = ?', [statementTimeoutMs]);
  } catch {
    // A server that refuses the variable still serves queries; see `connection.ts`.
  }
}

function promisify(connection: PoolConnection): Connection {
  // Same runtime mismatch the API's pool documents: the 'connection' event delivers the
  // callback-style core connection, recovered through `.promise()` when present.
  const candidate = connection as PoolConnection & { promise?: () => Connection };
  return typeof candidate.promise === 'function' ? candidate.promise() : connection;
}

/**
 * One statement inside one worker transaction.
 *
 * Untyped parameters and an untyped result on purpose: the concrete row shapes live in the
 * store files beside this one, which are the only callers allowed to spell SQL. A generic
 * here would promise type safety this seam cannot actually check.
 */
export interface WorkerTransaction {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<T>;
}

export interface WorkerDatabaseOptions {
  /** `mysql://user:pass@host:port/db` — `tmanage_worker`'s URL, validated by the caller. */
  readonly url: string;
  readonly connectionLimit: number;
  readonly statementTimeoutMs: number;
  /** A connection whose session state would not apply is destroyed, and this hears why. */
  readonly onConnectionError?: (error: unknown) => void;
}

export interface WorkerDatabase {
  /**
   * One transaction on one connection. The dispatcher's whole batch runs inside one of
   * these: the `FOR UPDATE SKIP LOCKED` claim holds its row locks until commit, which is
   * what lets two relay processes run at once without double-delivering.
   */
  transaction<T>(work: (tx: WorkerTransaction) => Promise<T>): Promise<T>;
  /**
   * A read that needs no transaction — RT-001's subscription checks. One connection for
   * the duration, so a multi-statement read cannot interleave with another borrower's.
   */
  read<T>(work: (tx: WorkerTransaction) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export function createWorkerDatabase(options: WorkerDatabaseOptions): WorkerDatabase {
  const pool: Pool = createPool({
    ...BASE_OPTIONS,
    uri: options.url,
    connectionLimit: options.connectionLimit,
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  });

  pool.on('connection', (connection) => {
    applySessionState(promisify(connection), options.statementTimeoutMs).catch((error: unknown) => {
      connection.destroy();
      options.onConnectionError?.(error);
    });
  });

  return {
    async transaction<T>(work: (tx: WorkerTransaction) => Promise<T>): Promise<T> {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        try {
          const tx: WorkerTransaction = {
            query: async <T2>(sql: string, params: readonly unknown[] = []) => {
              const [result] = await connection.query(sql, params as unknown[]);
              return result as T2;
            },
          };
          const result = await work(tx);
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      } finally {
        connection.release();
      }
    },
    async read<T>(work: (tx: WorkerTransaction) => Promise<T>): Promise<T> {
      const connection = await pool.getConnection();
      try {
        const tx: WorkerTransaction = {
          query: async <T2>(sql: string, params: readonly unknown[] = []) => {
            const [result] = await connection.query(sql, params as unknown[]);
            return result as T2;
          },
        };
        return await work(tx);
      } finally {
        connection.release();
      }
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
}
