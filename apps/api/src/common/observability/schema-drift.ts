import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { serializeForLog } from './logger.js';

/**
 * 56-27 / ADR-0007. The schema-drift check: does the database this process talks to carry the
 * schema this build was written against?
 *
 * On Hostinger shared hosting the runtime database user holds full privileges (hPanel cannot
 * grant less), so a stray `ALTER`, `DROP` or hand edit in phpMyAdmin is possible and the grants
 * cannot stop it. This check is one of the compensating controls: it runs once at boot and again
 * whenever its reading is older than {@link SCHEMA_DRIFT_RECHECK_MS}, and compares
 *
 * - the **ledger** (`schema_migrations`) — every row `applied`, every shipped migration file
 *   recorded, and each recorded checksum equal to the shipped file's checksum (the migrator's own
 *   CRLF-normalised sha256);
 * - the **tables** — every table the code declares (`TABLES` in `schema.ts`) exists in
 *   `information_schema.tables` for the current database.
 *
 * The fingerprint is sha256 over the sorted `version:checksum` pairs, once from the files
 * ("expected") and once from the ledger ("found"), so a log line names both in 64 characters.
 *
 * Verdict: `fail` on drift; `not_configured` when a probe cannot be read (database down, no
 * migration files in the bundle) — an unreadable probe is the database check's problem, never a
 * reason to refuse service on its own. A ledger row with no shipped file (a rollback deploy onto a
 * newer, additive schema) and tables the code does not know are reported, not failed.
 *
 * Boot is never blocked. In `enforce` mode (the plan's default) {@link SchemaDriftGuard} answers
 * 503 to every API route except `GET /healthz/deep` while the reading is `fail`; `report` mode only
 * logs and reports. All queries are plain `SELECT`s that run on MySQL 8 and MariaDB alike.
 */

export type SchemaDriftState = 'ok' | 'fail' | 'not_configured';
export type SchemaDriftMode = 'enforce' | 'report';

export type SchemaDriftProblem =
  | { readonly kind: 'ledger_not_applied'; readonly version: number; readonly status: string }
  | { readonly kind: 'migration_not_recorded'; readonly version: number }
  | {
      readonly kind: 'checksum_mismatch';
      readonly version: number;
      readonly expected: string;
      readonly found: string;
    }
  | { readonly kind: 'missing_table'; readonly table: string };

export interface SchemaDriftReading {
  readonly state: SchemaDriftState;
  readonly problems: readonly SchemaDriftProblem[];
  /** Ledger versions with no shipped file — reported, not a failure. */
  readonly ledgerAhead: readonly number[];
  /** Tables present that the code does not declare — reported, not a failure. */
  readonly unknownTables: number;
  readonly expectedFingerprint: string | null;
  readonly foundFingerprint: string | null;
  readonly checkedAt: string;
}

export interface LedgerEntry {
  readonly version: number;
  readonly checksum: string;
  readonly status: string;
}

export interface ShippedMigration {
  readonly version: number;
  readonly checksum: string;
}

/** The readings the verdict is computed from — injected so the unit suite needs no database. */
export interface SchemaDriftProbes {
  readLedger(): Promise<readonly LedgerEntry[]>;
  /** `null` when this build's migration files cannot be found. */
  shippedMigrations(): Promise<readonly ShippedMigration[] | null>;
  readTables(): Promise<readonly string[]>;
}

export const SCHEMA_DRIFT_RECHECK_MS = 60_000;

export function fingerprintOf(entries: readonly { version: number; checksum: string }[]): string {
  const line = [...entries]
    .sort((a, b) => a.version - b.version)
    .map((e) => `${e.version}:${e.checksum}`)
    .join('\n');
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

/** Pure verdict. Never throws: a probe that throws makes the reading `not_configured`. */
export async function evaluateSchemaDrift(
  expectedTables: readonly string[],
  probes: SchemaDriftProbes,
  now: Date,
): Promise<SchemaDriftReading> {
  const checkedAt = now.toISOString();
  let ledger: readonly LedgerEntry[];
  let tables: readonly string[];
  try {
    [ledger, tables] = await Promise.all([probes.readLedger(), probes.readTables()]);
  } catch {
    return {
      state: 'not_configured',
      problems: [],
      ledgerAhead: [],
      unknownTables: 0,
      expectedFingerprint: null,
      foundFingerprint: null,
      checkedAt,
    };
  }
  const shipped = await probes.shippedMigrations().catch(() => null);

  const problems: SchemaDriftProblem[] = [];
  for (const row of ledger) {
    if (row.status !== 'applied') {
      problems.push({ kind: 'ledger_not_applied', version: row.version, status: row.status });
    }
  }
  const ledgerAhead: number[] = [];
  if (shipped !== null) {
    const recorded = new Map(ledger.map((r) => [r.version, r.checksum]));
    const shippedVersions = new Set(shipped.map((f) => f.version));
    for (const file of shipped) {
      const found = recorded.get(file.version);
      if (found === undefined)
        problems.push({ kind: 'migration_not_recorded', version: file.version });
      else if (found !== file.checksum) {
        problems.push({
          kind: 'checksum_mismatch',
          version: file.version,
          expected: file.checksum,
          found,
        });
      }
    }
    for (const row of ledger) if (!shippedVersions.has(row.version)) ledgerAhead.push(row.version);
  }

  const present = new Set(tables.map((t) => t.toLowerCase()));
  const declared = new Set(expectedTables.map((t) => t.toLowerCase()));
  for (const table of [...declared].sort()) {
    if (!present.has(table)) problems.push({ kind: 'missing_table', table });
  }
  const unknownTables = [...present].filter(
    (t) => !declared.has(t) && t !== 'schema_migrations',
  ).length;

  return {
    state: problems.length > 0 ? 'fail' : 'ok',
    problems,
    ledgerAhead: ledgerAhead.sort((a, b) => a - b),
    unknownTables,
    expectedFingerprint: shipped === null ? null : fingerprintOf(shipped),
    foundFingerprint: fingerprintOf(ledger),
    checkedAt,
  };
}

/** The migrator's naming rule and checksum (CRLF → LF, sha256) — kept identical on purpose. */
export async function readShippedMigrations(
  directory: string,
): Promise<readonly ShippedMigration[]> {
  const out: ShippedMigration[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const match = /^(\d{4,})_[A-Za-z0-9_-]+\.sql$/u.exec(name);
    if (match?.[1] === undefined) continue;
    const contents = await readFile(join(directory, name), 'utf8');
    const checksum = createHash('sha256')
      .update(contents.replace(/\r\n/g, '\n'), 'utf8')
      .digest('hex');
    out.push({ version: Number(match[1]), checksum });
  }
  return out;
}

/** Holds the latest reading; re-checks when it is stale. One check in flight at a time. */
export class SchemaDriftMonitor {
  private reading: SchemaDriftReading | null = null;
  private inFlight: Promise<SchemaDriftReading> | null = null;
  private lastLogged: string | null = null;

  constructor(
    private readonly expectedTables: readonly string[],
    private readonly probes: SchemaDriftProbes,
    readonly mode: SchemaDriftMode,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  current(): SchemaDriftReading | null {
    return this.reading;
  }

  check(): Promise<SchemaDriftReading> {
    this.inFlight ??= evaluateSchemaDrift(this.expectedTables, this.probes, this.clock())
      .then((reading) => {
        this.reading = reading;
        this.log(reading);
        return reading;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** The latest reading, re-checked first when older than {@link SCHEMA_DRIFT_RECHECK_MS}. */
  async fresh(): Promise<SchemaDriftReading> {
    const at = this.reading === null ? 0 : Date.parse(this.reading.checkedAt);
    if (this.clock().getTime() - at > SCHEMA_DRIFT_RECHECK_MS) return this.check();
    return this.reading as SchemaDriftReading;
  }

  /** One line per change of verdict, so a 60-second recheck does not flood the log. */
  private log(reading: SchemaDriftReading): void {
    const key = `${reading.state}|${reading.foundFingerprint ?? ''}|${reading.problems.length}`;
    if (key === this.lastLogged) return;
    const first = this.lastLogged === null;
    this.lastLogged = key;
    // A clean first reading is the normal boot: nothing to say. A recovery to ok is worth a line.
    if (first && reading.state === 'ok') return;
    const line = serializeForLog({
      event: 'schema_drift',
      state: reading.state,
      mode: this.mode,
      expectedFingerprint: reading.expectedFingerprint,
      foundFingerprint: reading.foundFingerprint,
      problems: reading.problems.slice(0, 20),
      problemCount: reading.problems.length,
      ledgerAhead: reading.ledgerAhead,
      unknownTables: reading.unknownTables,
      runbook: 'docs/adr/ADR-0007-least-privilege-db-boundary-on-shared-hosting.md#on-drift',
    });
    if (reading.state === 'fail') console.error('[schema-drift]', line);
    else console.warn('[schema-drift]', line);
  }
}

export const SCHEMA_DRIFT_MONITOR = Symbol.for('tmanage.SchemaDriftMonitor');

/** Paths that keep answering while the schema has drifted, so the monitor can see the 503. */
const ALWAYS_SERVED = ['/healthz/deep'];

/**
 * In `enforce` mode, refuse service (503) while the latest reading is `fail`. `ok` and
 * `not_configured` serve; so does everything in `report` mode.
 */
export class SchemaDriftGuard implements CanActivate {
  constructor(private readonly monitor: SchemaDriftMonitor) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.monitor.mode !== 'enforce') return true;
    const request = context.switchToHttp().getRequest<{ url?: string } | undefined>();
    const path = (request?.url ?? '').split('?')[0] ?? '';
    if (ALWAYS_SERVED.some((p) => path === p || path.endsWith(p))) return true;
    const reading = await this.monitor.fresh();
    if (reading.state === 'fail') {
      throw new ServiceUnavailableException('The service is temporarily unavailable.');
    }
    return true;
  }
}
