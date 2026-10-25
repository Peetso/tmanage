import { uuidv7 } from '@tmanage/domain';
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
