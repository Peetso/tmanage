#!/usr/bin/env node
/**
 * Backs up TManage: database dump + uploads archive + manifests, then prunes old backups.
 *
 *   node scripts/ops/backup.mjs [--out backups] [--uploads <dir>] [--keep 14]
 *     [--frequency daily|sixhourly|manual] [--db-only] [--encrypt] [--offsite] [--no-record]
 *
 * Env: DATABASE_URL (required), BACKUP_DIR, KEEP, STORAGE_LOCAL_DIR / STORAGE_FILESYSTEM_ROOT,
 * MYSQLDUMP (client binary, default `mysqldump`; `mariadb-dump` on MariaDB-only hosts), MYSQL
 * (for the run record, default `mysql`), GIT_SHA, BACKUP_AGE_RECIPIENT (age1... public key, comma
 * separated for several), BACKUP_DRIVE_* (see offsite-drive.mjs).
 *
 * Shared-hosting safe: `--single-transaction` gives a consistent InnoDB snapshot without
 * `LOCK TABLES` (which Hostinger users may lack); `--no-tablespaces` avoids the PROCESS
 * privilege. The password travels in MYSQL_PWD, never on the command line.
 *
 * Output: <out>/<stamp>/db.sql.gz, uploads.tar.gz (when the uploads dir exists and not
 * `--db-only`), config-manifest.json (names + salted hashes, never values), manifest.json (with
 * the SHA-256 of every file). `--encrypt` replaces the data files by `.age` ciphertext for
 * BACKUP_AGE_RECIPIENT; `--offsite` implies it and uploads the ciphertext + manifests to the Ops
 * Drive. Keyless: without a recipient or Drive credentials `--offsite` is skipped (logged, run
 * recorded as `skipped`) and the host copy is still written.
 *
 * Each run is recorded in `platform_backup_runs` (migration 0253; `/healthz/deep` reads it) and in
 * `<out>/last-backup.json`. A record that cannot be written only warns. A lock file stops two runs
 * from overlapping. Exit 0 ok, 1 backup failed, 3 backup ok but the requested off-site copy failed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

import {
  DEFAULT_KEEP,
  FREQUENCY_KINDS,
  backupRunInsertSql,
  buildManifest,
  migrationVersions,
  parseArgs,
  parseDatabaseUrl,
  selectForPruning,
  stampOf,
} from './backup-plan.mjs';
import { encryptFile } from './backup-encrypt.mjs';
import { buildConfigManifest } from './config-snapshot.mjs';
import { uploadBackup } from './offsite-drive.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'apps', 'api', 'migrations');
const LOCK_STALE_MS = 6 * 3600 * 1000;

function gitSha() {
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function dumpDatabase(db, file) {
  const args = [
    `--host=${db.host}`,
    `--port=${db.port}`,
    `--user=${db.user}`,
    '--single-transaction',
    '--skip-lock-tables',
    '--skip-add-locks',
    '--no-tablespaces',
    '--routines',
    '--triggers',
    '--events',
    '--hex-blob',
    '--default-character-set=utf8mb4',
    // A bare name (not --databases) keeps CREATE DATABASE / USE out of the dump, so a restore
    // lands in whatever database the restore names rather than back in this one.
    db.database,
  ];
  const child = spawn(process.env.MYSQLDUMP || 'mysqldump', args, {
    env: { ...process.env, MYSQL_PWD: db.password },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((ok, fail) => {
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`dump exited ${code}`))));
  });
  await Promise.all([pipeline(child.stdout, createGzip(), createWriteStream(file)), exited]);
}

/**
 * No paths on tar's command line: the archive goes to stdout and the source is the cwd. GNU tar
 * (first on PATH under Git Bash) reads `C:\...` in `-f` as a remote `host:path` and fails to
 * extract into a `C:\...` `-C`, and `--force-local` is unknown to bsdtar. This works with both.
 */
function archiveUploads(dir, file) {
  const fd = openSync(file, 'w');
  try {
    execFileSync('tar', ['-cz', '.'], { cwd: dir, stdio: ['ignore', fd, 'inherit'] });
  } finally {
    closeSync(fd);
  }
}

/** Exclusive lock in the backups root; a lock older than 6 h is a crashed run and is taken over. */
function takeLock(outRoot) {
  const path = join(outRoot, '.backup.lock');
  try {
    if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { force: true });
  } catch {
    // no lock yet
  }
  let fd;
  try {
    fd = openSync(path, 'wx');
  } catch {
    throw new Error(`another backup is running (${path}); not starting a second one`);
  }
  writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  closeSync(fd);
  return () => rmSync(path, { force: true });
}

/** Writes the run row through the client binary (no driver dependency); warns on failure. */
function recordRun(db, run) {
  try {
    execFileSync(
      process.env.MYSQL || 'mysql',
      [`--host=${db.host}`, `--port=${db.port}`, `--user=${db.user}`, `--database=${db.database}`],
      {
        env: { ...process.env, MYSQL_PWD: db.password },
        input: backupRunInsertSql(run),
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    );
  } catch (err) {
    console.warn(
      `warning: could not record the run in platform_backup_runs (${err.message.split('\n')[0]})`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    out: 'string',
    uploads: 'string',
    keep: 'string',
    frequency: 'string',
    'db-only': 'boolean',
    encrypt: 'boolean',
    offsite: 'boolean',
    'no-record': 'boolean',
  });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const db = parseDatabaseUrl(process.env.DATABASE_URL);
  const keep = Number(args.keep ?? process.env.KEEP ?? DEFAULT_KEEP);
  const frequencyKind = args.frequency ?? 'manual';
  if (!FREQUENCY_KINDS.includes(frequencyKind) || frequencyKind === 'drill') {
    throw new Error('--frequency must be daily, sixhourly or manual');
  }
  const recipients = (process.env.BACKUP_AGE_RECIPIENT ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (args.encrypt && recipients.length === 0) {
    throw new Error('--encrypt needs BACKUP_AGE_RECIPIENT (an age1... public key)');
  }
  const encrypt = recipients.length > 0 && Boolean(args.encrypt || args.offsite);
  const outRoot = resolve(ROOT, args.out ?? process.env.BACKUP_DIR ?? 'backups');
  const uploadsDir = resolve(
    ROOT,
    args.uploads ??
      process.env.STORAGE_LOCAL_DIR ??
      process.env.STORAGE_FILESYSTEM_ROOT ??
      '.local/storage',
  );
  mkdirSync(outRoot, { recursive: true, mode: 0o700 });
  const release = takeLock(outRoot);

  const startedAt = new Date();
  const stamp = stampOf(startedAt);
  const dir = join(outRoot, stamp);
  const sha = gitSha();
  const run = {
    id: randomUUID(),
    kind: frequencyKind === 'manual' ? 'manual' : 'scheduled',
    frequencyKind,
    stamp,
    startedAt,
    status: 'failed',
    gitSha: sha,
    offsiteStatus: args.offsite ? 'skipped' : 'not_requested',
  };
  let exitCode = 0;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dbFile = join(dir, 'db.sql.gz');
    console.log(`Dumping ${db.database} to ${dbFile}`);
    await dumpDatabase(db, dbFile);
    const files = { db: { name: 'db.sql.gz', bytes: statSync(dbFile).size } };

    if (!args['db-only'] && existsSync(uploadsDir)) {
      const upFile = join(dir, 'uploads.tar.gz');
      console.log(`Archiving uploads from ${uploadsDir}`);
      archiveUploads(uploadsDir, upFile);
      files.uploads = { name: 'uploads.tar.gz', bytes: statSync(upFile).size, source: uploadsDir };
    } else if (!args['db-only']) {
      console.warn(`Uploads dir ${uploadsDir} does not exist; no uploads archive written.`);
    }

    for (const f of Object.values(files)) {
      const plain = join(dir, f.name);
      f.sha256 = await sha256File(plain);
      if (encrypt) {
        const sealed = `${plain}.age`;
        await encryptFile(plain, sealed, recipients);
        rmSync(plain);
        f.plainSha256 = f.sha256;
        f.name = `${f.name}.age`;
        f.encrypted = 'age';
        f.bytes = statSync(sealed).size;
        f.sha256 = await sha256File(sealed);
      }
    }

    const config = buildConfigManifest(process.env, { now: startedAt });
    const configFile = join(dir, 'config-manifest.json');
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    files.config = {
      name: 'config-manifest.json',
      bytes: statSync(configFile).size,
      count: config.count,
    };

    const manifest = buildManifest({
      stamp,
      createdAt: startedAt.toISOString(),
      gitSha: sha,
      database: db.database,
      migrations: migrationVersions(readdirSync(MIGRATIONS_DIR)),
      files,
    });
    const manifestFile = join(dir, 'manifest.json');
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    run.manifestSha = await sha256File(manifestFile);
    run.dbBytes = files.db.bytes;
    run.uploadsBytes = files.uploads?.bytes;
    run.status = 'ok';
    console.log(`Backup written: ${dir} (manifest sha256 ${run.manifestSha})`);

    if (args.offsite) {
      if (!encrypt) {
        console.warn(
          'Off-site skipped: BACKUP_AGE_RECIPIENT is not set (plaintext never leaves the host).',
        );
      } else {
        // The config manifest stays on the host: salted hashes of low-entropy values could still
        // be guessed offline, so only ciphertext and the file manifest leave the account.
        const sealed = Object.values(files).filter((f) => f.encrypted === 'age');
        const paths = [...sealed.map((f) => join(dir, f.name)), manifestFile];
        const r = await uploadBackup({ paths, stamp });
        run.offsiteStatus = r.status;
        run.offsiteLocation = r.location;
        run.offsiteAt = r.at;
        if (r.status === 'skipped') console.warn('Off-site skipped: BACKUP_DRIVE_* is not set.');
        if (r.status === 'failed') {
          run.error = `off-site: ${r.error}`;
          console.error(`OFF-SITE COPY FAILED: ${r.error}`);
          exitCode = 3;
        }
      }
    }

    for (const old of selectForPruning(readdirSync(outRoot), keep)) {
      console.log(`Pruning ${old}`);
      rmSync(join(outRoot, old), { recursive: true, force: true });
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    run.error = err.message;
    throw err;
  } finally {
    run.finishedAt = new Date();
    if (!args['no-record']) recordRun(db, run);
    writeFileSync(
      join(outRoot, 'last-backup.json'),
      `${JSON.stringify({ stamp, status: run.status, finishedAt: run.finishedAt, offsiteStatus: run.offsiteStatus, offsiteAt: run.offsiteAt ?? null }, null, 2)}\n`,
    );
    release();
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`backup failed: ${err.message}`);
    process.exit(1);
  },
);
