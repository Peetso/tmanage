import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createMigrationConnection } from './connection.js';
import {
  migrate,
  migrationStatus,
  resetDatabase,
  splitStatements,
  MigrationError,
} from './migrator.js';

/**
 * `pnpm db:migrate` / `db:status` / `db:reset` / `db:grants`.
 *
 * Reads `DATABASE_MIGRATION_URL` directly rather than through `loadEnv`: this process needs
 * one variable, and demanding the API's full environment (public URLs, session secrets,
 * storage credentials) to run a migration would push operators toward inventing values for
 * settings the migrator never uses. Full validation still happens at API boot.
 */

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const USERS_SQL = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../scripts/db/users.sql',
);

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'migrate';
  const url = process.env['DATABASE_MIGRATION_URL'];
  if (!url) {
    process.stderr.write('DATABASE_MIGRATION_URL is not set\n');
    return 2;
  }

  const connection = await createMigrationConnection(url);
  try {
    switch (command) {
      case 'migrate': {
        const report = await migrate(connection, {
          directory: MIGRATIONS_DIR,
          appliedBy: process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown',
          log: out,
        });
        out(
          report.applied.length === 0
            ? `nothing to apply (${report.alreadyApplied.length} already applied)`
            : `applied ${report.applied.length} migration(s) in ${report.durationMs}ms`,
        );
        return 0;
      }

      case 'status': {
        for (const row of await migrationStatus(connection, MIGRATIONS_DIR)) {
          out(`${row.state.padEnd(18)} ${row.filename}${row.detail ? `  — ${row.detail}` : ''}`);
        }
        return 0;
      }

      case 'grants': {
        // Applied through the migrator's own statement splitter rather than piped into a
        // `mysql` client, so the one code path that parses this project's SQL is the tested
        // one, and so the command works identically on a machine with no MySQL client
        // installed.
        //
        // Deliberately *not* wrapped in the migration ledger: grants are environment state,
        // not schema state. Re-running is safe and expected — every statement is
        // `CREATE USER IF NOT EXISTS` or an idempotent `GRANT`.
        const statements = splitStatements(await readFile(USERS_SQL, 'utf8'));
        for (const [index, statement] of statements.entries()) {
          try {
            await connection.query(statement);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(
              `scripts/db/users.sql failed at statement ${index + 1}/${statements.length}:\n` +
                `  ${statement.split('\n')[0]}\n  ${message}\n` +
                (/doesn.t exist/i.test(message)
                  ? '\nEvery grant in this file is table-level, and a table-level GRANT ' +
                    'requires its table to exist.\nRun `pnpm db:migrate` first.\n'
                  : '') +
                (/access denied|CREATE USER|GRANT OPTION/i.test(message)
                  ? '\nThis file provisions credentials, so DATABASE_MIGRATION_URL must ' +
                    'name an administrative user\nfor this command — the migration user ' +
                    'holds no CREATE USER privilege and no GRANT OPTION.\n'
                  : ''),
            );
            return 1;
          }
        }
        out(`applied ${statements.length} statement(s) from scripts/db/users.sql`);
        return 0;
      }

      case 'reset': {
        if (process.env['NODE_ENV'] === 'production') {
          process.stderr.write('refusing to reset a production database\n');
          return 2;
        }
        const dropped = await resetDatabase(connection);
        out(`dropped ${dropped} table(s)`);
        return 0;
      }

      default:
        process.stderr.write(`unknown command '${command}' (migrate | status | grants | reset)\n`);
        return 2;
    }
  } catch (error) {
    // A MigrationError message is written for an operator and already explains the
    // recovery path; a stack trace would bury it.
    if (error instanceof MigrationError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await connection.end();
  }
}

process.exitCode = await main();
