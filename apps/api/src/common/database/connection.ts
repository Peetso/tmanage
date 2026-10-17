import { createPool, createConnection } from 'mysql2/promise';
import type { Connection, Pool, PoolConnection, PoolOptions } from 'mysql2/promise';

/**
 * Connection factories.
 *
 * Two distinct credentials, per spec section 5 and ADR-0001 layer 2: the runtime pool uses
 * a DML-only user, and the migrator uses a schema-owning user on a single dedicated
 * connection. They are separate functions rather than one parameterised helper so that
 * handing the runtime a migration credential requires actively calling the wrong thing.
 */

/**
 * Session settings applied to every connection.
 *
 * - `STRICT_ALL_TABLES` turns silent truncation and out-of-range coercion into errors.
 *   Without it the server will happily store a truncated `CHAR(36)` and a UUID becomes a
 *   different UUID.
 * - `NO_ZERO_DATE` / `NO_ZERO_IN_DATE` reject `'0000-00-00'`, which is not a timestamp.
 * - `ERROR_FOR_DIVISION_BY_ZERO` makes `x / 0` an error rather than NULL.
 * - The UTC session time zone means `NOW(3)` and every `DATETIME(3)` comparison agree with
 *   the application's clock regardless of where the server is provisioned.
 */
const SESSION_SQL_MODE =
  'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,' +
  'NO_ENGINE_SUBSTITUTION';

const BASE_OPTIONS = {
  // A second statement smuggled into one call would slip past the tenant guard, which
  // analyses one statement at a time. Off by default in mysql2; stated here so that
  // turning it on has to be a visible edit to this line.
  multipleStatements: false,
  charset: 'utf8mb4_unicode_ci',
  // mysql2 interprets DATETIME columns in this zone. The schema stores UTC.
  timezone: 'Z',
  // DATE columns come back as the `'YYYY-MM-DD'` strings they are (0012). Left to the
  // default, mysql2 inflates a DATE into a JS `Date` at midnight, and the Drizzle proxy's
  // text conversion would then hand `date(..., { mode: 'string' })` columns a
  // `'YYYY-MM-DD 00:00:00.000'` — a time nobody stored. DATETIME/TIMESTAMP keep the
  // `Date` inflation that `datetime(..., { mode: 'date' })` expects.
  dateStrings: ['DATE'],
  supportBigNumbers: true,
  bigNumberStrings: false,
  namedPlaceholders: false,
} satisfies Partial<PoolOptions>;

export interface TenantPoolOptions {
  /** `mysql://user:pass@host:port/db`, validated by `packages/config`. */
  readonly url: string;
  /**
   * Called when a connection could not be prepared and was therefore destroyed.
   *
   * This hook exists because the failure it reports is otherwise invisible: destroying
   * connections silently makes the pool look like it is hanging rather than like it is
   * refusing. Wire it to the logger in the API and to an assertion in tests.
   */
  readonly onConnectionError?: (error: unknown) => void;
  /**
   * 50-BOOTSTRAP section 4: "a small bounded pool ... strict connection budgets matched to
   * the plan". Hostinger's smallest Cloud plan has a tight connection allowance, and three
   * Node processes share it.
   */
  readonly connectionLimit: number;
  readonly statementTimeoutMs: number;
}

/**
 * Get a promise-returning view of a pooled connection.
 *
 * `mysql2/promise` types the `'connection'` event listener as receiving a promise-wrapped
 * `PoolConnection`, but at runtime it delivers the **callback-style** core connection.
 * Awaiting its `query()` therefore never resolves, which — with the destroy-on-failure
 * policy above — silently killed every connection in the pool. The wrapper is recovered
 * through `.promise()` when it is present.
 */
function promisify(connection: PoolConnection): Connection {
  const candidate = connection as PoolConnection & { promise?: () => Connection };
  return typeof candidate.promise === 'function' ? candidate.promise() : connection;
}

/**
 * Apply per-connection session state.
 *
 * MariaDB 11.8 is the one engine TManage runs on — development, the test suites and
 * production on Hostinger alike. Its statement timeout is `max_statement_time`, in seconds,
 * and MariaDB applies it to **every** statement, writes and DDL included: a statement past
 * the cap is killed with `ER_STATEMENT_TIMEOUT` (1969). It is therefore only set when
 * `capEveryStatementOnMariaDb` says the connection's work may be killed part way — never on
 * the migration connection, whose ALTERs must not be stopped half applied.
 *
 * The SET is tolerated failing: a managed or shared server may refuse it, and a connection
 * that cannot set a timeout is still a usable connection.
 */
async function applySessionState(
  connection: Connection,
  statementTimeoutMs: number,
  capEveryStatementOnMariaDb: boolean,
): Promise<void> {
  // Both statements are issued in the *same synchronous tick*, before the first `await`
  // yields. mysql2 enqueues a command onto the per-connection queue synchronously when
  // `query()` is called, and the pool emits `'connection'` — running this function — before
  // it hands the connection to the borrower. Enqueuing both here therefore orders them
  // ahead of the borrower's first query. Awaiting the sql_mode set *before* issuing the
  // timeout set would enqueue it a microtask later, after the borrower's query had already
  // been queued, leaving that first statement — and, on a fresh connection, any inspection
  // of the variable — uncapped. The timeout set is tolerated failing (see above), so its
  // rejection is swallowed here rather than destroying the connection.
  const applied = connection.query(`SET SESSION sql_mode = ?, time_zone = '+00:00'`, [
    SESSION_SQL_MODE,
  ]);
  const tolerated = () => {
    // A server that refuses the variable still serves queries; see the note above.
  };
  const capped = capEveryStatementOnMariaDb
    ? connection
        .query('SET SESSION max_statement_time = ?', [statementTimeoutMs / 1000])
        .catch(tolerated)
    : Promise.resolve();
  await applied;
  await capped;
}

/**
 * The runtime pool. Every statement issued through it is expected to pass the tenant guard
 * — see `tenant-context.ts`, which is the only supported way to use this pool.
 */
export function createTenantPool(options: TenantPoolOptions): Pool {
  const pool = createPool({
    ...BASE_OPTIONS,
    uri: options.url,
    connectionLimit: options.connectionLimit,
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  });

  // mysql2 serialises commands per connection, so these are guaranteed to run before the
  // borrower's first query even though the listener itself is synchronous.
  //
  // A connection whose session state could not be applied is destroyed rather than handed
  // out. Serving queries on a connection that silently lost STRICT_ALL_TABLES would let a
  // truncated CHAR(36) become a different — possibly another tenant's — identifier.
  pool.on('connection', (connection) => {
    applySessionState(promisify(connection), options.statementTimeoutMs, true).catch(
      (error: unknown) => {
        connection.destroy();
        options.onConnectionError?.(error);
      },
    );
  });

  return pool;
}

/**
 * A single migration connection.
 *
 * Not a pool: `GET_LOCK()` is scoped to a database session, so the migrator's advisory lock
 * would be released the instant a pool handed out a different connection.
 */
export async function createMigrationConnection(url: string): Promise<Connection> {
  const connection = await createConnection({ ...BASE_OPTIONS, uri: url });
  // No statement timeout at all (`false`; the 10 minutes is not applied): an ALTER on a
  // large table is legitimately slow, and MariaDB's `max_statement_time` would cap the ALTER
  // itself — killing it half way through is exactly the partial-application failure the
  // migrator works to avoid.
  await applySessionState(connection, 600_000, false);
  return connection;
}
