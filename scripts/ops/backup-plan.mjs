/**
 * Pure helpers shared by `backup.mjs` and `restore.mjs`: argument parsing, DATABASE_URL parsing,
 * backup stamps, retention selection, manifest shape and the restore target-name guard.
 *
 * Nothing here touches the filesystem, the network or a database, so `backup-plan.test.mjs`
 * covers it with plain `node --test`.
 */

export const MANIFEST_FORMAT = 1;
export const DEFAULT_KEEP = 14;

/** Matches `apps/api/src/common/database/migrator.ts` FILENAME_PATTERN. */
const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** A backup directory name: `20261022T031500Z`. */
const STAMP = /^\d{8}T\d{6}Z$/;

/**
 * Parses `--flag value`, `--flag=value` and boolean `--flag` arguments.
 * `spec` maps each accepted flag to `'string'` or `'boolean'`; anything else throws.
 */
export function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) throw new Error(`Unexpected argument: ${raw}`);
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    const kind = spec[name];
    if (!kind) throw new Error(`Unknown option: --${name}`);
    if (kind === 'boolean') {
      if (eq !== -1) throw new Error(`--${name} takes no value`);
      out[name] = true;
      continue;
    }
    const value = eq === -1 ? argv[(i += 1)] : raw.slice(eq + 1);
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
      throw new Error(`--${name} needs a value`);
    }
    out[name] = value;
  }
  return out;
}

/** `mysql://user:pass@host:3306/db` (also `mariadb://`) to client connection parts. */
export function parseDatabaseUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (u.protocol !== 'mysql:' && u.protocol !== 'mariadb:') {
    throw new Error(`DATABASE_URL must use mysql:// or mariadb://, got ${u.protocol}//`);
  }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database || database.includes('/')) throw new Error('DATABASE_URL names no database');
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
  };
}

/** UTC stamp used as the backup directory name. */
export function stampOf(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export function isStamp(name) {
  return STAMP.test(name);
}

/**
 * Given the entries of the backups directory, returns the stamp directories to delete so that
 * the newest `keep` remain. Entries that are not stamps are never selected.
 */
export function selectForPruning(entries, keep = DEFAULT_KEEP) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('KEEP must be a positive integer');
  const stamps = entries.filter(isStamp).sort().reverse();
  return stamps.slice(keep);
}

/** Ascending migration versions from the filenames in `apps/api/migrations`. */
export function migrationVersions(filenames) {
  return filenames
    .map((f) => MIGRATION_FILE.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

export function buildManifest({ stamp, gitSha, database, migrations, files, createdAt }) {
  return {
    format: MANIFEST_FORMAT,
    stamp,
    createdAt,
    gitSha: gitSha ?? null,
    database,
    migrations: {
      count: migrations.length,
      latest: migrations.length ? migrations[migrations.length - 1] : null,
      versions: migrations,
    },
    files,
  };
}

/** Throws when `m` is not a manifest `buildManifest` could have written. */
export function validateManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('manifest.json is not an object');
  if (m.format !== MANIFEST_FORMAT) throw new Error(`Unsupported manifest format: ${m.format}`);
  if (!isStamp(m.stamp)) throw new Error('manifest.stamp is malformed');
  const v = m.migrations?.versions;
  if (!Array.isArray(v) || !v.every(Number.isInteger) || m.migrations.count !== v.length) {
    throw new Error('manifest.migrations is malformed');
  }
  if (!m.files || typeof m.files.db?.bytes !== 'number') {
    throw new Error('manifest.files.db is missing');
  }
  return m;
}

/**
 * Restore safety: the target database name must contain `restore` or `test`, unless the operator
 * passed `--i-know` (a real rollback onto production).
 */
export function checkTargetName(database, iKnow = false) {
  if (/restore|test/i.test(database)) return { ok: true };
  if (iKnow) return { ok: true, warning: `Restoring over "${database}" (--i-know given)` };
  return {
    ok: false,
    reason: `Refusing to restore into "${database}": the name contains neither "restore" nor "test". Pass --i-know to override.`,
  };
}

/** Compares the applied ledger after a restore with the versions the manifest recorded. */
export function compareMigrations(expected, actual) {
  const a = new Set(actual);
  const e = new Set(expected);
  const missing = expected.filter((v) => !a.has(v));
  const extra = actual.filter((v) => !e.has(v));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

/**
 * Drops `DEFINER=` clauses from a dump line. Triggers and routines then belong to the restoring
 * user, which shared hosting requires (setting another definer needs SUPER / SET USER).
 */
export function stripDefiner(line) {
  return line
    .replace(/\/\*!50017 DEFINER=`[^`]*`@`[^`]*`\*\/ ?/g, '')
    .replace(/DEFINER=`[^`]*`@`[^`]*` ?/g, '');
}

/** `20261022T031500Z` back to its instant. */
export function stampToDate(stamp) {
  if (!isStamp(stamp)) throw new Error(`Not a backup stamp: ${stamp}`);
  const s = stamp;
  return new Date(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`,
  );
}

/**
 * Off-site retention (56-12 / 56-29): every copy younger than 48 h (the 6-hourly set), the newest
 * copy of each of the 30 newest UTC days, and the newest copy of each of the 12 newest months.
 * Returns the stamps to delete; entries that are not stamps are never selected.
 */
export function selectOffsiteForPruning(stamps, now, { days = 30, months = 12 } = {}) {
  const sorted = [...new Set(stamps.filter(isStamp))].sort().reverse();
  const keep = new Set();
  const seenDays = new Set();
  const seenMonths = new Set();
  for (const s of sorted) {
    if (now.getTime() - stampToDate(s).getTime() <= 48 * 3600 * 1000) keep.add(s);
    const day = s.slice(0, 8);
    if (!seenDays.has(day) && seenDays.size < days) {
      seenDays.add(day);
      keep.add(s);
    }
    const month = s.slice(0, 6);
    if (!seenMonths.has(month) && seenMonths.size < months) {
      seenMonths.add(month);
      keep.add(s);
    }
  }
  return sorted.filter((s) => !keep.has(s));
}

/** A MariaDB string literal: quotes doubled, backslashes escaped, NUL dropped; NULL for null. */
export function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/\0/g, '').replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export const RUN_KINDS = ['scheduled', 'manual', 'drill'];
export const FREQUENCY_KINDS = ['daily', 'sixhourly', 'manual', 'drill'];
export const OFFSITE_STATES = ['not_requested', 'skipped', 'uploaded', 'failed'];

const sqlDate = (d) => (d ? sqlString(d.toISOString().slice(0, 23).replace('T', ' ')) : 'NULL');
const sqlInt = (n) => (Number.isFinite(n) ? String(Math.trunc(n)) : 'NULL');

/** The `platform_backup_runs` row (migration 0253) as one INSERT statement. */
export function backupRunInsertSql(run) {
  if (!RUN_KINDS.includes(run.kind)) throw new Error(`bad run kind ${run.kind}`);
  if (!FREQUENCY_KINDS.includes(run.frequencyKind)) throw new Error('bad frequency kind');
  if (!['ok', 'failed'].includes(run.status)) throw new Error('bad run status');
  if (!OFFSITE_STATES.includes(run.offsiteStatus)) throw new Error('bad off-site status');
  const cols = {
    id: sqlString(run.id),
    kind: sqlString(run.kind),
    frequency_kind: sqlString(run.frequencyKind),
    stamp: sqlString(run.stamp ?? null),
    started_at: sqlDate(run.startedAt),
    finished_at: sqlDate(run.finishedAt),
    status: sqlString(run.status),
    db_bytes: sqlInt(run.dbBytes),
    uploads_bytes: sqlInt(run.uploadsBytes),
    manifest_sha: sqlString(run.manifestSha ?? null),
    git_sha: sqlString(run.gitSha ?? null),
    offsite_status: sqlString(run.offsiteStatus),
    offsite_location: sqlString(run.offsiteLocation ?? null),
    offsite_at: sqlDate(run.offsiteAt),
    error: sqlString(run.error ? String(run.error).slice(0, 500) : null),
  };
  return `INSERT INTO platform_backup_runs (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(', ')});`;
}
