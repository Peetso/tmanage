import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connection, RowDataPacket } from 'mysql2/promise';

/**
 * MySQL migrator — DATA-001.
 *
 * ## The problem this file exists to handle
 *
 * **MySQL DDL is not transactional.** `CREATE TABLE`, `ALTER TABLE`, `CREATE TRIGGER`, and
 * `CREATE INDEX` each cause an *implicit commit* before and after they run. Wrapping a
 * migration in `START TRANSACTION` therefore buys nothing: if statement 7 of 12 fails, the
 * first six are already permanently committed and there is no rollback to issue. This is
 * the single most important behavioural difference from the PostgreSQL migrator that
 * preceded it, where a failed migration left the database untouched.
 *
 * Pretending otherwise is how a half-applied schema becomes an outage. So this migrator
 * does not pretend:
 *
 * 1. Before running a migration it writes a ledger row with status `running`, recording how
 *    many statements the file contains. That row is committed immediately.
 * 2. After each statement succeeds it advances `statements_applied`. Also committed
 *    immediately — the DDL commits anyway, so the counter cannot drift behind the schema.
 * 3. On failure the row becomes `failed`, carrying the failing statement's index and the
 *    server's error message.
 * 4. **Any subsequent run refuses to do anything at all** while a `running` or `failed` row
 *    exists. The migrator cannot know whether the partially-applied file is safe to
 *    continue from, and guessing would risk applying a statement twice or skipping one.
 *
 * Recovery is therefore a deliberate human action, and the ledger row tells the operator
 * exactly where to resume: statements `0 .. statements_applied - 1` are applied; the
 * statement at index `failed_statement_index` is not. Fix the cause, apply the remaining
 * statements by hand or via a corrective migration, then either mark the row `applied` (if
 * the file was completed by hand) or delete it (if the applied portion was manually undone).
 *
 * A `running` row with no matching failure means the migrator process died mid-file — treat
 * it exactly like `failed`, except that `statements_applied` is the last *confirmed* count
 * and the statement after it may or may not have landed. Verify that one statement before
 * resuming.
 *
 * ## Other guarantees
 *
 * - **Ordered.** Files are `NNNN_name.sql`, applied in ascending numeric order. A new file
 *   numbered below an already-applied migration is rejected rather than silently skipped,
 *   because merging two branches can otherwise produce different schemas from the same
 *   ledger.
 * - **Locked.** `GET_LOCK()` gives a server-side advisory lock, so two deploys hitting the
 *   database at once serialise instead of racing. The lock is held on one dedicated
 *   connection — MySQL scopes named locks to a session, so a pool would release the lock
 *   the moment a different connection was checked out. That is why this function takes a
 *   `Connection` and not a `Pool`.
 * - **Checksummed.** Applied files are re-hashed on every run. An edited migration is an
 *   error, not a no-op: the database no longer matches what the file claims to describe.
 *   Line endings are normalised before hashing so a Windows checkout and a Linux CI runner
 *   agree.
 */

const LOCK_NAME = 'tmanage:migrations';
const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly checksum: string;
  readonly statements: readonly string[];
}

export interface LedgerRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly status: 'running' | 'applied' | 'failed';
  readonly statementsTotal: number;
  readonly statementsApplied: number;
  readonly failedStatementIndex: number | null;
  readonly failureMessage: string | null;
}

export interface MigrateOptions {
  /** Directory holding the `NNNN_name.sql` files. */
  readonly directory: string;
  /** How long to wait for the advisory lock before giving up. */
  readonly lockTimeoutSeconds?: number;
  /** Recorded in the ledger so a partial failure can be traced to a deploy. */
  readonly appliedBy?: string;
  /** Progress sink. Deliberately not `console` — this module is library code. */
  readonly log?: (message: string) => void;
}

export interface MigrateReport {
  readonly applied: readonly MigrationFile[];
  readonly alreadyApplied: readonly number[];
  readonly durationMs: number;
}

/** Thrown for every refusal below, so callers can distinguish these from driver errors. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * A migration died part-way through. Carries the ledger coordinates an operator needs,
 * because "migration failed" without a statement index is not actionable on an engine
 * that has already committed everything before the failure.
 */
export class PartialMigrationError extends MigrationError {
  constructor(
    readonly version: number,
    readonly filename: string,
    readonly statementIndex: number,
    readonly statementsApplied: number,
    readonly statementsTotal: number,
    /** Named to avoid shadowing `Error.cause`, whose semantics are chaining, not detail. */
    readonly failureCause: unknown,
  ) {
    const detail = failureCause instanceof Error ? failureCause.message : String(failureCause);
    super(
      `Migration ${filename} failed at statement ${statementIndex + 1} of ${statementsTotal}.\n` +
        `  Server error: ${detail}\n` +
        `  MySQL DDL is not transactional: statements 1..${statementsApplied} are COMMITTED ` +
        `and will not be rolled back.\n` +
        `  The ledger row for version ${version} is marked 'failed'. No further migration ` +
        `will run until it is resolved by hand — see the recovery notes in migrator.ts.`,
    );
    this.name = 'PartialMigrationError';
  }
}

// ── Statement splitting ───────────────────────────────────────────────────────

/**
 * Split a migration file into individual statements.
 *
 * Naive `sql.split(';')` is wrong here for three reasons, all of which occur in
 * `0001_tenancy.sql`: semicolons inside string literals, semicolons inside `--`/`/* *\/`
 * comments, and — the reason this is not optional — semicolons inside a trigger body.
 * A trigger that enforces `organization_id` immutability needs `BEGIN ... IF ... THEN
 * SIGNAL ...; END IF; END`, so the files use `DELIMITER $$` exactly as the `mysql` client
 * does, and this scanner honours it.
 *
 * Comments are dropped rather than preserved; nothing downstream needs them, and dropping
 * them keeps the recorded statement text short enough to read in an error message.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let delimiter = ';';
  let buffer = '';
  let i = 0;

  const flush = (): void => {
    const trimmed = buffer.trim();
    if (trimmed.length > 0) statements.push(trimmed);
    buffer = '';
  };

  while (i < sql.length) {
    const rest = sql.slice(i);
    const ch = sql[i] as string;

    // `DELIMITER x` is a client directive, not SQL. It is only meaningful where a
    // statement could begin, so it is recognised only when nothing is buffered.
    if (buffer.trim().length === 0 && /^delimiter[ \t]+\S/i.test(rest)) {
      const eol = sql.indexOf('\n', i);
      const line = eol === -1 ? sql.slice(i) : sql.slice(i, eol);
      const next = line.slice('delimiter'.length).trim();
      if (next.length > 0) delimiter = next;
      i = eol === -1 ? sql.length : eol + 1;
      buffer = '';
      continue;
    }

    // Line comments. MySQL requires whitespace after `--`; `#` needs none.
    if (ch === '#' || (ch === '-' && /^--[\s]/.test(rest))) {
      const eol = sql.indexOf('\n', i);
      i = eol === -1 ? sql.length : eol + 1;
      continue;
    }

    // Block comment.
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }

    // Quoted regions: single-quoted and double-quoted strings, backtick identifiers.
    // Both doubling (`''`) and backslash escaping are honoured, matching MySQL's default
    // mode. The files never enable ANSI_QUOTES, so `"` is a string literal here.
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      buffer += ch;
      i += 1;
      while (i < sql.length) {
        const c = sql[i] as string;
        if (c === '\\' && quote !== '`') {
          buffer += c + (sql[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === quote) {
          if (sql[i + 1] === quote) {
            buffer += c + c;
            i += 2;
            continue;
          }
          buffer += c;
          i += 1;
          break;
        }
        buffer += c;
        i += 1;
      }
      continue;
    }

    if (rest.startsWith(delimiter)) {
      flush();
      i += delimiter.length;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return statements;
}

// ── Loading ───────────────────────────────────────────────────────────────────

/** `\r\n` → `\n` so the checksum is identical on Windows and Linux checkouts. */
function checksumOf(contents: string): string {
  return createHash('sha256').update(contents.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export async function loadMigrations(directory: string): Promise<readonly MigrationFile[]> {
  const entries = await readdir(directory);
  const sqlFiles = entries.filter((f) => f.endsWith('.sql')).sort();

  const malformed = sqlFiles.filter((f) => !FILENAME_PATTERN.test(f));
  if (malformed.length > 0) {
    throw new MigrationError(
      `Migration filenames must match NNNN_snake_case.sql — rejected: ${malformed.join(', ')}`,
    );
  }

  const files: MigrationFile[] = [];
  for (const filename of sqlFiles) {
    const match = FILENAME_PATTERN.exec(filename);
    // Unreachable: `malformed` above already rejected anything that fails the pattern.
    if (!match) continue;
    const contents = await readFile(join(directory, filename), 'utf8');
    const statements = splitStatements(contents);
    if (statements.length === 0) {
      throw new MigrationError(`${filename} contains no statements`);
    }
    files.push({
      version: Number.parseInt(match[1] as string, 10),
      name: match[2] as string,
      filename,
      checksum: checksumOf(contents),
      statements,
    });
  }

  const seen = new Map<number, string>();
  for (const file of files) {
    const previous = seen.get(file.version);
    if (previous !== undefined) {
      throw new MigrationError(
        `Duplicate migration version ${file.version}: ${previous} and ${file.filename}`,
      );
    }
    seen.set(file.version, file.filename);
  }

  return files.sort((a, b) => a.version - b.version);
}

// ── Ledger ────────────────────────────────────────────────────────────────────

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version                INT UNSIGNED NOT NULL,
  name                   VARCHAR(190) NOT NULL,
  checksum               CHAR(64) NOT NULL,
  status                 ENUM('running','applied','failed') NOT NULL,
  statements_total       INT UNSIGNED NOT NULL,
  statements_applied     INT UNSIGNED NOT NULL DEFAULT 0,
  failed_statement_index INT UNSIGNED NULL,
  failure_message        TEXT NULL,
  applied_by             VARCHAR(190) NOT NULL,
  started_at             DATETIME(3) NOT NULL,
  finished_at            DATETIME(3) NULL,
  duration_ms            INT UNSIGNED NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

export async function readLedger(connection: Connection): Promise<readonly LedgerRow[]> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT version, name, checksum, status, statements_total, statements_applied,
            failed_statement_index, failure_message
       FROM schema_migrations
      ORDER BY version`,
  );
  return rows.map((r) => ({
    version: Number(r['version']),
    name: String(r['name']),
    checksum: String(r['checksum']),
    status: r['status'] as LedgerRow['status'],
    statementsTotal: Number(r['statements_total']),
    statementsApplied: Number(r['statements_applied']),
    failedStatementIndex:
      r['failed_statement_index'] === null ? null : Number(r['failed_statement_index']),
    failureMessage: r['failure_message'] === null ? null : String(r['failure_message']),
  }));
}

// ── Advisory lock ─────────────────────────────────────────────────────────────

async function acquireLock(connection: Connection, timeoutSeconds: number): Promise<void> {
  const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
    LOCK_NAME,
    timeoutSeconds,
  ]);
  const acquired = rows[0]?.['acquired'];
  if (acquired === null || acquired === undefined) {
    throw new MigrationError(`GET_LOCK('${LOCK_NAME}') returned NULL — the server errored`);
  }
  if (Number(acquired) !== 1) {
    throw new MigrationError(
      `Another migration is already running: GET_LOCK('${LOCK_NAME}') timed out after ` +
        `${timeoutSeconds}s. Wait for it to finish rather than forcing this one through.`,
    );
  }
}

async function releaseLock(connection: Connection): Promise<void> {
  await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
}

// ── Verification ──────────────────────────────────────────────────────────────

function verifyLedgerIsClean(ledger: readonly LedgerRow[]): void {
  const unresolved = ledger.filter((r) => r.status !== 'applied');
  if (unresolved.length === 0) return;

  const detail = unresolved
    .map(
      (r) =>
        `  version ${r.version} (${r.name}) is '${r.status}': ` +
        `${r.statementsApplied}/${r.statementsTotal} statements committed` +
        (r.failedStatementIndex === null
          ? ''
          : `, failed at statement ${r.failedStatementIndex + 1}`) +
        (r.failureMessage === null ? '' : `\n    ${r.failureMessage}`),
    )
    .join('\n');

  throw new MigrationError(
    `Refusing to migrate: the schema is in a partially-applied state.\n${detail}\n` +
      `MySQL committed the statements listed above and cannot roll them back. Resolve the ` +
      `row by hand (complete the file and mark it 'applied', or undo the applied portion ` +
      `and delete the row) before running migrations again.`,
  );
}

function verifyChecksums(ledger: readonly LedgerRow[], files: readonly MigrationFile[]): void {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  for (const row of ledger) {
    const file = byVersion.get(row.version);
    if (!file) {
      throw new MigrationError(
        `Migration ${row.version} (${row.name}) is recorded as applied but its file is ` +
          `missing. The schema describes changes no file in this checkout accounts for.`,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `Checksum mismatch for ${file.filename}: the database recorded ${row.checksum} but ` +
          `the file now hashes to ${file.checksum}. An applied migration was edited — the ` +
          `live schema no longer matches what this file claims. Add a new migration instead.`,
      );
    }
  }
}

function verifyNoBackfill(ledger: readonly LedgerRow[], pending: readonly MigrationFile[]): void {
  if (ledger.length === 0 || pending.length === 0) return;
  const highestApplied = Math.max(...ledger.map((r) => r.version));
  const late = pending.filter((f) => f.version < highestApplied);
  if (late.length > 0) {
    throw new MigrationError(
      `Out-of-order migration(s): ${late.map((f) => f.filename).join(', ')} sort below the ` +
        `highest applied version (${highestApplied}). Renumber above it so every environment ` +
        `applies the same sequence.`,
    );
  }
}

// ── Migrate ───────────────────────────────────────────────────────────────────

export async function migrate(
  connection: Connection,
  options: MigrateOptions,
): Promise<MigrateReport> {
  const { directory, lockTimeoutSeconds = 30, appliedBy = 'migrator', log } = options;
  const startedAt = Date.now();

  const files = await loadMigrations(directory);

  await acquireLock(connection, lockTimeoutSeconds);
  try {
    await connection.query(LEDGER_DDL);

    const ledger = await readLedger(connection);
    verifyLedgerIsClean(ledger);
    verifyChecksums(ledger, files);

    const appliedVersions = new Set(ledger.map((r) => r.version));
    const pending = files.filter((f) => !appliedVersions.has(f.version));
    verifyNoBackfill(ledger, pending);

    const applied: MigrationFile[] = [];
    for (const file of pending) {
      log?.(`applying ${file.filename} (${file.statements.length} statements)`);
      await applyOne(connection, file, appliedBy);
      applied.push(file);
      log?.(`applied  ${file.filename}`);
    }

    return {
      applied,
      alreadyApplied: [...appliedVersions].sort((a, b) => a - b),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await releaseLock(connection);
  }
}

async function applyOne(
  connection: Connection,
  file: MigrationFile,
  appliedBy: string,
): Promise<void> {
  const begin = Date.now();

  // Committed before the first DDL statement runs, so a process killed mid-file still
  // leaves evidence that the file was started.
  await connection.execute(
    `INSERT INTO schema_migrations
       (version, name, checksum, status, statements_total, statements_applied,
        applied_by, started_at)
     VALUES (?, ?, ?, 'running', ?, 0, ?, NOW(3))`,
    [file.version, file.name, file.checksum, file.statements.length, appliedBy],
  );

  for (const [index, statement] of file.statements.entries()) {
    try {
      await connection.query(statement);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await connection.execute(
        `UPDATE schema_migrations
            SET status = 'failed', failed_statement_index = ?, failure_message = ?,
                finished_at = NOW(3), duration_ms = ?
          WHERE version = ?`,
        [index, message.slice(0, 2000), Date.now() - begin, file.version],
      );
      throw new PartialMigrationError(
        file.version,
        file.filename,
        index,
        index,
        file.statements.length,
        cause,
      );
    }

    // The DDL above already committed. Recording the count immediately keeps the ledger
    // from ever claiming fewer statements ran than actually did.
    await connection.execute(
      'UPDATE schema_migrations SET statements_applied = ? WHERE version = ?',
      [index + 1, file.version],
    );
  }

  await connection.execute(
    `UPDATE schema_migrations
        SET status = 'applied', finished_at = NOW(3), duration_ms = ?
      WHERE version = ?`,
    [Date.now() - begin, file.version],
  );
}

// ── Status ────────────────────────────────────────────────────────────────────

export interface MigrationStatus {
  readonly version: number;
  readonly filename: string;
  readonly state: 'applied' | 'pending' | 'running' | 'failed' | 'checksum-mismatch';
  readonly detail?: string;
}

/** Read-only inspection. Never throws on a bad ledger — reporting the problem is the point. */
export async function migrationStatus(
  connection: Connection,
  directory: string,
): Promise<readonly MigrationStatus[]> {
  const files = await loadMigrations(directory);
  await connection.query(LEDGER_DDL);
  const ledger = await readLedger(connection);
  const byVersion = new Map(ledger.map((r) => [r.version, r]));

  const rows: MigrationStatus[] = files.map((file) => {
    const row = byVersion.get(file.version);
    if (!row) return { version: file.version, filename: file.filename, state: 'pending' };
    if (row.status !== 'applied') {
      return {
        version: file.version,
        filename: file.filename,
        state: row.status,
        detail: `${row.statementsApplied}/${row.statementsTotal} statements committed`,
      };
    }
    if (row.checksum !== file.checksum) {
      return {
        version: file.version,
        filename: file.filename,
        state: 'checksum-mismatch',
        detail: `recorded ${row.checksum.slice(0, 12)}…, file ${file.checksum.slice(0, 12)}…`,
      };
    }
    return { version: file.version, filename: file.filename, state: 'applied' };
  });

  // An applied version with no file at all is invisible above, and is exactly the case
  // worth surfacing loudest.
  const known = new Set(files.map((f) => f.version));
  for (const row of ledger) {
    if (!known.has(row.version)) {
      rows.push({
        version: row.version,
        filename: `${String(row.version).padStart(4, '0')}_${row.name}.sql`,
        state: 'checksum-mismatch',
        detail: 'recorded as applied, but the file is missing from this checkout',
      });
    }
  }

  return rows.sort((a, b) => a.version - b.version);
}

/**
 * Drop every table in the current database, ledger included.
 *
 * Development and test only — `db:reset`. Foreign key checks are disabled for the duration
 * because the composite tenant foreign keys of ADR-0001 layer 1 make the drop order a
 * genuine dependency graph, and there is no value in solving it to throw the data away.
 */
export async function resetDatabase(connection: Connection): Promise<number> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()`,
  );
  const tables = rows.map((r) => String(r['t']));
  if (tables.length === 0) return 0;

  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of tables) {
      await connection.query(`DROP TABLE IF EXISTS \`${table.replace(/`/g, '``')}\``);
    }
  } finally {
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  }
  return tables.length;
}
