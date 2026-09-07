import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseSeedKeys } from '@tmanage/config';
import type { SeedKeyring } from '@tmanage/config';
import { createSeedCipher } from '../../modules/identity/seed-cipher.js';
import {
  encryptSeeds,
  seedEncryptionStatus,
} from '../../modules/identity/seed-backfill.repository.js';
import { createMigrationConnection } from './connection.js';
import {
  migrate,
  migrationStatus,
  resetDatabase,
  splitStatements,
  MigrationError,
} from './migrator.js';

/**
 * `pnpm db:migrate` / `db:status` / `db:reset` / `db:grants`, and D07's
 * `mfa:encrypt-seeds` / `mfa:seeds-status`.
 *
 * Reads `DATABASE_MIGRATION_URL` directly rather than through `loadEnv`: this process needs
 * one variable, and demanding the API's full environment (public URLs, session secrets,
 * storage credentials) to run a migration would push operators toward inventing values for
 * settings the migrator never uses. Full validation still happens at API boot.
 *
 * The `mfa-seeds` subcommands need a second variable, `AUTH_MFA_SEED_KEYS`, read the same
 * way and for the same reason. They run on the **migration** credential rather than the
 * runtime one on purpose: `tmanage_app` holds INSERT and UPDATE on `user_mfa_factors` for
 * the sign-in path, and a maintenance sweep over every second factor in the system is not
 * something the process serving requests should be able to start.
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

      // D07 — `pnpm --filter @tmanage/api mfa:encrypt-seeds` / `mfa:seeds-status`.
      //
      // `encrypt` is the command every error message about an unencrypted seed names, and
      // it is also the second half of a key rotation: append a higher version to
      // `AUTH_MFA_SEED_KEYS`, restart, run this, then drop the old entry once `status`
      // reports no rows left under it. Re-running is safe — a row already on the active key
      // is counted and not written.
      case 'mfa-seeds': {
        const action = process.argv[3];
        if (action !== 'encrypt' && action !== 'status') {
          process.stderr.write(`unknown subcommand '${action ?? ''}' (encrypt | status)\n`);
          return 2;
        }

        const raw = process.env['AUTH_MFA_SEED_KEYS'];
        if (!raw) {
          process.stderr.write(
            'AUTH_MFA_SEED_KEYS is not set. It must hold the same keyring the API runs ' +
              'with,\notherwise this command would write rows the API cannot open.\n',
          );
          return 2;
        }

        // Parsed here rather than deep inside, so a mistyped keyring is one clear line
        // before anything has been read, let alone written.
        let keyring: SeedKeyring;
        try {
          keyring = parseSeedKeys(raw);
        } catch (error) {
          process.stderr.write(
            `AUTH_MFA_SEED_KEYS is not usable: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          return 2;
        }
        const cipher = createSeedCipher(keyring);

        if (action === 'status') {
          const status = await seedEncryptionStatus(connection, cipher);
          out(`active key version   ${keyring.active.version}`);
          for (const entry of status.byVersion) {
            out(`key version ${String(entry.version).padEnd(8)} ${entry.rows}`);
          }
          out(`plaintext            ${status.plaintext}`);
          out(`unreadable           ${status.unreadable}`);
          out(`unopenable           ${status.unopenable.length}`);
          out(`total                ${status.total}`);
          if (status.unopenable.length > 0) {
            // The rows that are refusing somebody's sign-in right now — disabled factors are
            // not among them, so this reaches zero once the runbook's remedy has been
            // applied. Ids and reasons only, for the same reason the sweep prints no more
            // than that: this output is read in a terminal and pasted into a ticket.
            process.stderr.write('\nfactors that will not open:\n');
            for (const factor of status.unopenable) {
              process.stderr.write(`  ${factor.factorId}  ${factor.reason}\n`);
            }
            process.stderr.write(
              '\nSee docs/runbooks/deploy.md. `unknown_key_version` means AUTH_MFA_SEED_KEYS ' +
                'is missing a key\nthe row needs — restore it rather than re-encrypting; ' +
                '`authentication_failed` means the stored\nvalue was altered or moved between ' +
                'users; `malformed` means it is neither seed nor envelope.\n',
            );
          }
          // Still 0: `status` reports, it does not judge. An operator asks it what the table
          // holds, including in the middle of an incident, and a non-zero exit would make
          // that ordinary question look like a failed command in every wrapper script.
          return 0;
        }

        const report = await encryptSeeds(connection, cipher);
        out(`plaintext_encrypted  ${report.plaintextEncrypted}`);
        out(`rotated              ${report.rotated}`);
        out(`unchanged            ${report.unchanged}`);
        out(`failed               ${report.failed}`);
        if (report.failures.length > 0) {
          // Factor ids and reasons only. A seed, a stored envelope or a key would end up in
          // a scrollback and quite possibly a ticket, which is the disclosure D07 is about.
          process.stderr.write('\nfactors this sweep could not re-encrypt:\n');
          for (const failure of report.failures) {
            process.stderr.write(`  ${failure.factorId}  ${failure.reason}\n`);
          }
          process.stderr.write(
            '\nNothing above was overwritten. `authentication_failed` means the stored value ' +
              'was altered\nor moved between users; `unknown_key_version` means ' +
              'AUTH_MFA_SEED_KEYS is missing a key the row\nneeds; `malformed` and `empty` ' +
              'mean the column holds neither a seed nor an envelope;\n`concurrently_changed` ' +
              'means someone re-enrolled mid-sweep and re-running will pick it up.\n',
          );
          return 1;
        }
        return 0;
      }

      default:
        process.stderr.write(
          `unknown command '${command}' (migrate | status | grants | reset | mfa-seeds)\n`,
        );
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
