#!/usr/bin/env node
/**
 * Backs up TManage: database dump + uploads archive + manifest, then prunes old backups.
 *
 *   node scripts/ops/backup.mjs [--out backups] [--uploads <dir>] [--keep 14]
 *
 * Env: DATABASE_URL (required), BACKUP_DIR, KEEP, STORAGE_LOCAL_DIR / STORAGE_FILESYSTEM_ROOT,
 * MYSQLDUMP (client binary, default `mysqldump`; `mariadb-dump` on MariaDB-only hosts), GIT_SHA.
 *
 * Shared-hosting safe: `--single-transaction` gives a consistent InnoDB snapshot without
 * `LOCK TABLES` (which Hostinger users may lack); `--no-tablespaces` avoids the PROCESS
 * privilege. The password travels in MYSQL_PWD, never on the command line.
 *
 * Output: <out>/<stamp>/db.sql.gz, uploads.tar.gz (when the uploads dir exists), manifest.json.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

import {
  DEFAULT_KEEP,
  buildManifest,
  migrationVersions,
  parseArgs,
  parseDatabaseUrl,
  selectForPruning,
  stampOf,
} from './backup-plan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'apps', 'api', 'migrations');

function gitSha() {
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
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

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    out: 'string',
    uploads: 'string',
    keep: 'string',
  });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const db = parseDatabaseUrl(process.env.DATABASE_URL);
  const keep = Number(args.keep ?? process.env.KEEP ?? DEFAULT_KEEP);
  const outRoot = resolve(ROOT, args.out ?? process.env.BACKUP_DIR ?? 'backups');
  const uploadsDir = resolve(
    ROOT,
    args.uploads ??
      process.env.STORAGE_LOCAL_DIR ??
      process.env.STORAGE_FILESYSTEM_ROOT ??
      '.local/storage',
  );

  const now = new Date();
  const stamp = stampOf(now);
  const dir = join(outRoot, stamp);
  mkdirSync(dir, { recursive: true });

  const dbFile = join(dir, 'db.sql.gz');
  console.log(`Dumping ${db.database} to ${dbFile}`);
  try {
    await dumpDatabase(db, dbFile);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const files = { db: { name: 'db.sql.gz', bytes: statSync(dbFile).size } };

  if (existsSync(uploadsDir)) {
    const upFile = join(dir, 'uploads.tar.gz');
    console.log(`Archiving uploads from ${uploadsDir}`);
    try {
      archiveUploads(uploadsDir, upFile);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    files.uploads = { name: 'uploads.tar.gz', bytes: statSync(upFile).size, source: uploadsDir };
  } else {
    console.warn(`Uploads dir ${uploadsDir} does not exist; no uploads archive written.`);
  }

  const manifest = buildManifest({
    stamp,
    createdAt: now.toISOString(),
    gitSha: gitSha(),
    database: db.database,
    migrations: migrationVersions(readdirSync(MIGRATIONS_DIR)),
    files,
  });
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const old of selectForPruning(readdirSync(outRoot), keep)) {
    console.log(`Pruning ${old}`);
    rmSync(join(outRoot, old), { recursive: true, force: true });
  }
  console.log(`Backup written: ${dir}`);
}

main().catch((err) => {
  console.error(`backup failed: ${err.message}`);
  process.exit(1);
});
