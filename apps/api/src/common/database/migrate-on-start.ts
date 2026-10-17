import { createMigrationConnection } from './connection.js';
import { migrate } from './migrator.js';
import type { MigrateOptions, MigrateReport } from './migrator.js';

/**
 * Apply pending migrations once, on the migration credential, and close the connection.
 *
 * The single-process Hostinger server (`apps/server`) applies the schema on start, before it
 * accepts a request. It goes through this one function so the migration connection never
 * leaves the database layer: the caller hands over a URL and gets the report back, exactly
 * as `pnpm db:migrate` does. The migrator's own guarantees carry over unchanged — advisory
 * lock for the whole run, refusal on a partially applied schema, no-op when nothing is
 * pending.
 */
export async function migrateOnStart(
  migrationUrl: string,
  options: MigrateOptions,
): Promise<MigrateReport> {
  const connection = await createMigrationConnection(migrationUrl);
  try {
    return await migrate(connection, options);
  } finally {
    await connection.end();
  }
}
