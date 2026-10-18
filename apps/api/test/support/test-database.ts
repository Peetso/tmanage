import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, createConnection } from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { startMariaDb } from '../../../../scripts/db/mariadb-server.mjs';
import {
  createMigrationConnection,
  createTenantPool,
} from '../../src/common/database/connection.js';
import { migrate } from '../../src/common/database/migrator.js';

/**
 * The server the database suite runs against — ADR-0002, and the CI half of PLAT-003.
 *
 * ## One engine: MariaDB 11.8
 *
 * Production is MariaDB 11.8 (Hostinger reports `11.8.9-MariaDB-log`), so that is the only
 * engine this suite accepts. Every path checks `VERSION()` as soon as it connects and
 * refuses to run against anything else, rather than labelling an unexpected server and
 * carrying on: a green run on the wrong engine proves nothing about the one we deploy to.
 *
 * **Local (default).** `scripts/db/mariadb-server.mjs` starts a genuine MariaDB 11.8 server
 * as a child process, one private server per test file. The first run extracts the bundled
 * runtime into `.local/mariadb`; later runs reuse it. A real server is load-bearing rather
 * than convenient: everything the isolation corpus proves depends on real InnoDB behaviour —
 * composite foreign keys actually rejecting cross-tenant rows, `SIGNAL` actually aborting
 * an update, strict mode actually refusing a truncated `CHAR(36)`. An in-memory SQL
 * emulator would accept the DDL without enforcing it and the suite would pass while proving
 * nothing, which ADR-0002 calls out as worse than not running it at all.
 *
 * **External.** `TMANAGE_TEST_DATABASE_URL` points at an already-running MariaDB 11.8
 * server — the one from `compose.yaml` in CI. What that adds is not a different engine but
 * the server start-up flags and the provisioned least-privilege users, neither of which the
 * embedded server has. `engine` below is reported by every suite so no result is ambiguous
 * about which server produced it.
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

/**
 * The statement timeout the guarded pool is built with, in milliseconds.
 *
 * Exported so a suite can assert the value the connection actually carries rather than
 * repeating the number: the session's `max_statement_time` (MariaDB's cap, in seconds, so
 * this is 15) is the only statement-timeout mechanism in this project, and nothing else
 * would notice if the SET stopped happening. Matches the product default for
 * `DATABASE_STATEMENT_TIMEOUT_MS` (`packages/config/src/env.ts`).
 */
export const RUNTIME_STATEMENT_TIMEOUT_MS = 15_000;

const EXTERNAL_URL = process.env['TMANAGE_TEST_DATABASE_URL'];
const APP_URL = process.env['TMANAGE_TEST_APP_DATABASE_URL'];

export interface DatabaseEngine {
  /**
   * Always `mariadb`: `startTestDatabase` refuses any server whose `VERSION()` is not
   * MariaDB 11.8, so a `TestDatabase` cannot exist on another engine.
   */
  readonly name: 'mariadb';
  /** The server's own `VERSION()`, e.g. `11.8.9-MariaDB` or `11.8.9-MariaDB-log`. */
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
   * already gets a private server, but against the shared CI server a `resetDatabase`
   * would otherwise destroy the schema — and the grants — that the isolation corpus and
   * the least-privilege suite depend on.
   */
  readonly scratch?: boolean;
}

export const migrationsDirectory = MIGRATIONS_DIR;

/**
 * True when a server URL was supplied rather than one being started per file.
 *
 * That is the CI path, but it is not exclusively a containerised one: a single long-lived
 * embedded server started outside the per-file lifecycle sets this too, which is how the
 * least-privilege suite can run on a machine with no container runtime.
 */
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

/** The only `VERSION()` this project runs on: MariaDB 11.8, any patch, any suffix. */
const SUPPORTED_VERSION = /^11\.8\.\d+-MariaDB/i;

/**
 * Accept a server's `VERSION()` or refuse it.
 *
 * Exported so the refusal itself can be exercised without a second engine to hand.
 * `host` names the server in the message, so a CI failure says which URL was wrong.
 */
export function assertSupportedEngine(version: string, host: string): DatabaseEngine {
  if (!SUPPORTED_VERSION.test(version)) {
    throw new Error(`TManage runs on MariaDB 11.8 only; ${host} reports ${version}`);
  }
  return { name: 'mariadb', version };
}

async function readEngine(url: string): Promise<DatabaseEngine> {
  const connection = await createConnection({ uri: url, multipleStatements: false });
  try {
    const [rows] = await connection.query<RowDataPacket[]>('select version() as v');
    return assertSupportedEngine(String(rows[0]?.['v'] ?? 'unknown'), new URL(url).host);
  } finally {
    await connection.end();
  }
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
    // One private server per test file: suites truncate, reseed and (the migrator's) drop
    // tables freely, which a shared server would turn into cross-file interference.
    const server = await startMariaDb({ dbName: 'tmanage_test', logLevel: 'ERROR' });
    url = server.url;
    stopServer = () => server.stop();
  }

  // Before migrating anything: a wrong engine must fail here, by name, not halfway through
  // a migration with an error that looks like a schema bug.
  let engine: DatabaseEngine;
  try {
    engine = await readEngine(url);
  } catch (error) {
    await stopServer();
    throw error;
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
    statementTimeoutMs: RUNTIME_STATEMENT_TIMEOUT_MS,
    onConnectionError: (error) => connectionErrors.push(error),
  });

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
      // ID-002. `authentication_events` is append-only by trigger, so a test cannot clear it
      // with DELETE — TRUNCATE is DDL and bypasses row triggers, which is exactly why it is
      // used here and why the trigger is not weakened for the suite's convenience.
      'authentication_events',
      'user_recovery_codes',
      'user_mfa_factors',
      'user_passwords',
      // ACC-02 (0204). Reset links name a user.
      'password_reset_tokens',
      'idempotency_records',
      // USAGE-001 slice 2. Before `outbox_events`: a ledger row names the event that produced
      // it (and `usage_counters`, cleared below).
      'usage_ledger_entries',
      'outbox_events',
      'notifications',
      // FILE-001. Child first: a version names an asset, a session names an asset and a
      // project, an asset names a project and possibly a client organization.
      'file_versions',
      'upload_sessions',
      'file_assets',
      'usage_counters',
      // REQ-001. Before `work_items`: a linked request references one.
      'client_requests',
      // WORK-003. Before `work_items` for the same reason: both reference it.
      'work_item_dependencies',
      'work_blockers',
      'work_items',
      // CLIENT-003 (x125). Before `projects`: an update names a project (and organization).
      // FK checks are off here, so order is cosmetic — but the row must be cleared between tests
      // so a refused internal write can be proven to have written nothing.
      'project_updates',
      'invitations',
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
