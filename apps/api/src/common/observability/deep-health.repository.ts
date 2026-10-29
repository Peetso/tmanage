import { getTableName } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { TABLES } from '../database/schema.js';
import type { QueryRows, TenantDatabase } from '../database/tenant-context.js';

/**
 * C10. The one read `GET /healthz/deep` makes: the migration ledger, on the identity path
 * (`schema_migrations` is registered global in `tenant-guard.ts`; the runtime user may SELECT it
 * and nothing else). A failed read is the database check's `fail`.
 */
export function readMigrationLedger(
  database: TenantDatabase,
): Promise<readonly { version: number; status: string }[]> {
  return database.identityRead(
    { correlationId: uuidv7(), tables: ['schema_migrations'] },
    async (runner) => {
      const rows = await runner.query<QueryRows>('SELECT version, status FROM schema_migrations');
      return rows.map((r) => ({ version: Number(r['version']), status: String(r['status']) }));
    },
  );
}

/** 56-27. Every table name the code declares — the drift check's expected set. */
export function declaredTableNames(): readonly string[] {
  return Object.values(TABLES).map((t) => getTableName(t));
}

/**
 * 56-27. The schema-drift reads, on the identity path: `schema_migrations` is registered global
 * and `information_schema` is not a tenant table, so neither statement names an organization.
 * Plain `SELECT`s, identical on MySQL 8 and MariaDB.
 */
export function schemaDriftReads(database: TenantDatabase): {
  readLedger(): Promise<readonly { version: number; checksum: string; status: string }[]>;
  readTables(): Promise<readonly string[]>;
} {
  const read = <T>(sql: string, map: (r: QueryRows[number]) => T): Promise<readonly T[]> =>
    database.identityRead(
      { correlationId: uuidv7(), tables: ['schema_migrations'] },
      async (runner) => (await runner.query<QueryRows>(sql)).map(map),
    );
  return {
    readLedger: () =>
      read('SELECT version, checksum, status FROM schema_migrations', (r) => ({
        version: Number(r['version']),
        checksum: String(r['checksum']),
        status: String(r['status']),
      })),
    readTables: () =>
      read(
        'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()',
        (r) => String(r['t']),
      ),
  };
}
