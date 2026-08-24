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
 *   Without it MySQL will happily store a truncated `CHAR(36)` and a UUID becomes a
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
  dateStrings: false,
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
 * The statement timeout is set twice on purpose. MySQL calls it `max_execution_time`
 * (milliseconds, SELECT only); MariaDB calls it `max_statement_time` (seconds, all
 * statements). ADR-0002 records that local development runs MySQL while the deployed
 * database is MariaDB, so both are attempted and the one the server does not recognise is
 * ignored rather than failing the connection.
 */
async function applySessionState(
  connection: Connection,
  statementTimeoutMs: number,
): Promise<void> {
  await connection.query(`SET SESSION sql_mode = ?, time_zone = '+00:00'`, [SESSION_SQL_MODE]);
  try {
    await connection.query('SET SESSION max_execution_time = ?', [statementTimeoutMs]);
  } catch {
    // MySQL-only variable; MariaDB raises ER_UNKNOWN_SYSTEM_VARIABLE.
  }
  try {
    await connection.query('SET SESSION max_statement_time = ?', [statementTimeoutMs / 1000]);
  } catch {
    // MariaDB-only variable; MySQL raises ER_UNKNOWN_SYSTEM_VARIABLE.
  }
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
    applySessionState(promisify(connection), options.statementTimeoutMs).catch((error: unknown) => {
      connection.destroy();
      options.onConnectionError?.(error);
    });
  });

  return pool;
}

/**
 * A single migration connection.
 *
 * Not a pool: `GET_LOCK()` is scoped to a MySQL session, so the migrator's advisory lock
 * would be released the instant a pool handed out a different connection.
 */
export async function createMigrationConnection(url: string): Promise<Connection> {
  const connection = await createConnection({ ...BASE_OPTIONS, uri: url });
  // 10 minutes: an ALTER on a large table is legitimately slow, and killing it half way
  // through is exactly the partial-application failure the migrator works to avoid.
  await applySessionState(connection, 600_000);
  return connection;
}
