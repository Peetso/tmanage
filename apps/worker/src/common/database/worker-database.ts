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
 * comparisons agree with the application clock, and MariaDB's `max_statement_time` (in
 * seconds) as the statement timeout. See `connection.ts` for the full note.
 *
 * **MariaDB caps every statement, writes included** — not only SELECTs. A statement on this
 * pool that runs past the cap is killed with `ER_STATEMENT_TIMEOUT` (1969), and because the
 * dispatcher's whole batch is one transaction, that kill rolls the batch back; the dispatcher
 * classifies 1969 as recoverable (`isRecoverableBatchError` in `outbox-store.ts`) and refunds
 * the reservation's attempts. The cap is per statement, not per transaction, and every
 * statement the relay issues is far below the configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * (15 s by default): the reservation and the claim are an index-ordered `LIMIT batchSize
 * … FOR UPDATE SKIP LOCKED` (skipping, never waiting on, a locked row) and a primary-key
 * `UPDATE … IN (ids)`; `markPublished` / `recordFailure` and the consumers' statements are
 * single-row primary-key or tenant-scoped indexed writes; and the backlog aggregate — the one
 * full scan of the unpublished tail — runs on `read`, outside the batch transaction, so its
 * kill cannot abort a batch. The only statement that can approach the cap is one *waiting on
 * a row lock* held by an API transaction (InnoDB's own `innodb_lock_wait_timeout` is longer);
 * MariaDB then kills it at the cap with 1969 rather than letting it wait for 1205, and both are
 * recoverable, so the outcome is the same retried batch.
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
  // Both statements are issued in the same synchronous tick, before the first `await` yields,
  // so both are enqueued onto the per-connection command queue ahead of the borrower's first
  // query (the pool emits `'connection'` — running this — before handing the connection out).
  // Awaiting the sql_mode set before issuing the timeout set would enqueue the timeout a
  // microtask later, after the borrower's query, leaving that first statement uncapped. The
  // timeout set is still tolerated failing (see `connection.ts`), so its rejection is
  // swallowed here rather than destroying the connection. `max_statement_time` is in seconds.
  const applied = connection.query(`SET SESSION sql_mode = ?, time_zone = '+00:00'`, [
    SESSION_SQL_MODE,
  ]);
  const capped = connection
    .query('SET SESSION max_statement_time = ?', [statementTimeoutMs / 1000])
    .catch(() => {
      // A server that refuses the variable still serves queries; see `connection.ts`.
    });
  await applied;
  await capped;
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

/** Which shape the relay process is running as — see {@link workerConnectionLimit}. */
export type WorkerMode = 'loop' | 'batch';

/**
 * How many connections the relay's pool may open, by mode.
 *
 * The cap exists because the relay shares one MariaDB server with the API on a host that has
 * far fewer connections to give than `DATABASE_POOL_MAX` suggests, so the worker takes the
 * smaller of the two rather than the configured maximum.
 *
 * **Two is no longer the right number in loop mode.** It was chosen when the process ran one
 * dispatcher loop beside the realtime server. Since x31 there are *three* borrowers — the
 * outbox loop, the notice loop and RT-001's subscription reads — and a subscription check
 * arriving while both loops are mid-batch waits for one of them to finish. No deadlock is
 * reachable (nothing here acquires a second connection while holding one: each loop runs its
 * reservation transaction, its batch transaction and its backlog read strictly in sequence,
 * and after-commit effects, SMTP included, hold no connection at all), so the cost is latency
 * on a socket handshake rather than a stall — but it is a cost with no reason, and one
 * connection per borrower removes it.
 *
 * Batch mode keeps two: `--once`, `--status` and `--unpark` all run their queues sequentially
 * in a single process that exits, and a controlled batch has no third borrower.
 */
export function workerConnectionLimit(poolMax: number, mode: WorkerMode): number {
  return Math.min(poolMax, mode === 'loop' ? 3 : 2);
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
