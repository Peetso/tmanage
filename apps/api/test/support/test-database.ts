import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, createConnection } from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { createDB } from 'mysql-memory-server';
import {
  createMigrationConnection,
  createTenantPool,
} from '../../src/common/database/connection.js';
import { migrate } from '../../src/common/database/migrator.js';

/**
 * The server the database suite runs against — ADR-0002, and the CI half of PLAT-003.
 *
 * ## Two paths, and why both exist
 *
 * **Local (default).** `mysql-memory-server` downloads and runs a genuine MySQL server
 * binary as a child process. That choice is load-bearing rather than convenient:
 * everything the isolation corpus proves depends on real InnoDB behaviour — composite
 * foreign keys actually rejecting cross-tenant rows, `SIGNAL` actually aborting an update,
 * strict mode actually refusing a truncated `CHAR(36)`. An in-memory SQL emulator would
 * accept the DDL without enforcing it and the suite would pass while proving nothing,
 * which ADR-0002 calls out as worse than not running it at all.
 *
 * **CI.** `TMANAGE_TEST_DATABASE_URL` points at the MariaDB from `compose.yaml`. ADR-0002
 * records that CI is the *only* place the MySQL-vs-MariaDB engine skew is caught, so the
 * containerised run is not an alternative to the embedded one — it is the one that closes
 * a stated gap. `engine` below is reported by every suite so no result is ambiguous about
 * which server produced it.
 *
 * ## The runtime credential
 *
 * `TMANAGE_TEST_APP_DATABASE_URL` supplies the least-privilege `tmanage_app` user created
 * by `scripts/db/users.sql`. When it is set the guarded pool uses it, so the isolation
 * corpus runs as the application actually runs — ADR-0001 layer 2 under test rather than
 * asserted. When it is unset the guarded pool falls back to the admin credential, which is
 * what the embedded local server offers; `leastPrivilege` records which happened.
 */

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

const EXTERNAL_URL = process.env['TMANAGE_TEST_DATABASE_URL'];
const APP_URL = process.env['TMANAGE_TEST_APP_DATABASE_URL'];

export interface DatabaseEngine {
  /** `mariadb` or `mysql`, decided by the server's own version string. */
  readonly name: 'mariadb' | 'mysql';
  readonly version: string;
}

export interface TestDatabase {
  /** Migration/admin credential. Unguarded on purpose — fixtures and side-effect assertions. */
  readonly admin: Pool;
  /** The pool a `TenantDatabase` wraps. Reached only through the guard in tests. */
  readonly runtime: Pool;
  readonly url: string;
  readonly engine: DatabaseEngine;
  /** True when `runtime` holds the DML-only `tmanage_app` credential, not the admin one. */
  readonly leastPrivilege: boolean;
  /** True when this ran against `TMANAGE_TEST_DATABASE_URL` rather than the embedded server. */
  readonly external: boolean;
  /**
   * Connections the pool refused to hand out because their session state would not apply.
   *
   * Asserted empty by the corpus. Without it, a broken session-state setup destroys every
   * connection and the suite reports a cascade of `write after end` failures that look
   * like test bugs rather than like the pool refusing to serve.
   */
  readonly connectionErrors: unknown[];
  stop(): Promise<void>;
}

export interface StartOptions {
  /** The migrator's own suite starts from an empty database and applies files itself. */
  readonly applyMigrations?: boolean;
  /**
   * Give this suite a database of its own.
   *
   * Required by any suite that drops tables. Against the embedded server every suite
   * already gets a private server, but against the shared CI MariaDB a `resetDatabase`
   * would otherwise destroy the schema — and the grants — that the isolation corpus and
   * the least-privilege suite depend on.
   */
  readonly scratch?: boolean;
}

export const migrationsDirectory = MIGRATIONS_DIR;

/** True when a containerised server was supplied, i.e. when the CI path is in use. */
export const usingExternalDatabase = EXTERNAL_URL !== undefined && EXTERNAL_URL !== '';

/** True when the least-privilege runtime credential was supplied. */
export const usingLeastPrivilegeCredential = APP_URL !== undefined && APP_URL !== '';

/** `scripts/db/users.sql` names this database; the least-privilege grants only apply here. */
export function leastPrivilegeDatabaseUrl(): string {
  if (!APP_URL) {
    throw new Error('TMANAGE_TEST_APP_DATABASE_URL is not set');
  }
  return APP_URL;
}

/** MariaDB reports e.g. `11.4.5-MariaDB`; MySQL reports e.g. `8.4.3`. */
async function readEngine(pool: Pool): Promise<DatabaseEngine> {
  const [rows] = await pool.query<RowDataPacket[]>('select version() as v');
  const version = String(rows[0]?.['v'] ?? 'unknown');
  return { name: /mariadb/i.test(version) ? 'mariadb' : 'mysql', version };
}

/**
 * Where to connect when the target database is being created or dropped.
 *
 * `information_schema` rather than an empty database name: mysql2 passes an empty path
 * through as the database, and a connection with no database selected is a different thing
 * from a connection to a database that is always present and always readable.
 */
const ADMIN_DATABASE = 'information_schema';

let scratchCounter = 0;

/**
 * Point a connection URL at a different database on the same server.
 *
 * The scratch name is derived from pid and a counter rather than from a clock or a random
 * value, so a failed run names the database it left behind and a rerun does not accumulate
 * strays indefinitely.
 */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function databaseOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

export async function startTestDatabase(options: StartOptions = {}): Promise<TestDatabase> {
  const applyMigrations = options.applyMigrations !== false;

  let url: string;
  let stopServer: () => Promise<void>;

  if (usingExternalDatabase) {
    const base = EXTERNAL_URL as string;
    if (options.scratch) {
      scratchCounter += 1;
      const name = `tmanage_scratch_${process.pid}_${scratchCounter}`;
      const admin = await createConnection({
        uri: withDatabase(base, ADMIN_DATABASE),
        multipleStatements: false,
      });
      await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await admin.query(
        `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      await admin.end();
      url = withDatabase(base, name);
      stopServer = async () => {
        const cleanup = await createConnection({
          uri: withDatabase(base, ADMIN_DATABASE),
          multipleStatements: false,
        });
        await cleanup.query(`DROP DATABASE IF EXISTS \`${name}\``);
        await cleanup.end();
      };
    } else {
      url = base;
      // The canonical database outlives the process: CI migrated it and applied
      // scripts/db/users.sql to it before this suite started, and the least-privilege
      // credential is granted on that database by name.
      stopServer = async () => {};
    }
  } else {
    const server = await createDB({
      dbName: 'tmanage_test',
      logLevel: 'ERROR',
      downloadBinaryOnce: true,
    });
    url = `mysql://${server.username}@127.0.0.1:${server.port}/${server.dbName}`;
    stopServer = () => server.stop();
  }

  if (applyMigrations) {
    const migrationConnection = await createMigrationConnection(url);
    try {
      // Idempotent: against the CI database the schema is already present and this applies
      // nothing, which is itself worth exercising — a migrator that only works on an empty
      // database would pass every local run and fail the first redeploy.
      await migrate(migrationConnection, { directory: MIGRATIONS_DIR, appliedBy: 'test-harness' });
    } finally {
      await migrationConnection.end();
    }
  }

  // The admin pool deliberately skips `createTenantPool`: it must be able to issue the
  // unscoped statements the corpus uses to observe what actually landed in the database,
  // including the cross-tenant reads the guard exists to prevent.
  const admin = createPool({
    uri: url,
    connectionLimit: 4,
    multipleStatements: false,
    timezone: 'Z',
    charset: 'utf8mb4_unicode_ci',
  });

  // The runtime pool takes the least-privilege credential when one is configured and the
  // suite is using the database that credential was granted on. A scratch database carries
  // no grants for `tmanage_app`, so a scratch suite keeps the admin credential.
  const leastPrivilege =
    usingLeastPrivilegeCredential &&
    !options.scratch &&
    usingExternalDatabase &&
    databaseOf(APP_URL as string) === databaseOf(url);

  const connectionErrors: unknown[] = [];
  const runtime = createTenantPool({
    url: leastPrivilege ? (APP_URL as string) : url,
    connectionLimit: 4,
    statementTimeoutMs: 15_000,
    onConnectionError: (error) => connectionErrors.push(error),
  });

  const engine = await readEngine(admin);

  return {
    admin,
    runtime,
    url,
    engine,
    leastPrivilege,
    external: usingExternalDatabase,
    connectionErrors,
    async stop() {
      await runtime.end();
      await admin.end();
      await stopServer();
    },
  };
}

/**
 * Empty every table without re-running migrations.
 *
 * `TRUNCATE`, not `DELETE`: `audit_events` carries an append-only trigger that rejects
 * every DELETE, and disabling `FOREIGN_KEY_CHECKS` does not disable triggers. TRUNCATE is
 * DDL, so it does not fire them — which is also why the append-only guarantee is a
 * *runtime* one and purging audit history is a privileged, separately-credentialed
 * procedure rather than something the application can do.
 */
export async function truncateAll(admin: Pool): Promise<void> {
  await admin.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of [
      'audit_events',
      'idempotency_records',
      'outbox_events',
      'work_items',
      'project_clients',
      'project_memberships',
      'client_memberships',
      'client_organizations',
      'projects',
      'workspaces',
      'memberships',
      'session_refresh_tokens',
      'sessions',
      'organizations',
      'users',
    ]) {
      await admin.query(`TRUNCATE TABLE \`${table}\``);
    }
  } finally {
    await admin.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}
