#!/usr/bin/env node
/**
 * Restores a backup written by `backup.mjs`. Dry run unless `--apply` is given.
 *
 *   node scripts/ops/restore.mjs --from backups/<stamp> --target mysql://u:p@h/tm_restore \
 *     [--uploads <dir>] [--apply] [--i-know]
 *
 * Env: MYSQL (client binary, default `mysql`; `mariadb` on MariaDB-only hosts),
 * STORAGE_LOCAL_DIR / STORAGE_FILESYSTEM_ROOT (default uploads destination).
 *
 * Guards: the target database name must contain "restore" or "test", and the uploads
 * destination must be empty, unless `--i-know` is passed (a real rollback onto production).
 * After the replay the `schema_migrations` ledger is compared with the manifest; a mismatch
 * exits 2.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

import {
  checkTargetName,
  compareMigrations,
  parseArgs,
  parseDatabaseUrl,
  stripDefiner,
  validateManifest,
} from './backup-plan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT = process.env.MYSQL || 'mysql';

function clientArgs(db) {
  return [
    `--host=${db.host}`,
    `--port=${db.port}`,
    `--user=${db.user}`,
    `--database=${db.database}`,
  ];
}

function clientEnv(db) {
  return { ...process.env, MYSQL_PWD: db.password };
}

/** Line-buffered transform that strips DEFINER clauses from the dump. */
function definerStripper() {
  let rest = '';
  return new Transform({
    transform(chunk, _enc, done) {
      const lines = (rest + chunk.toString('utf8')).split('\n');
      rest = lines.pop();
      done(null, lines.map((l) => `${stripDefiner(l)}\n`).join(''));
    },
    flush(done) {
      done(null, stripDefiner(rest));
    },
  });
}

async function replayDump(db, file) {
  const child = spawn(CLIENT, [...clientArgs(db), '--default-character-set=utf8mb4'], {
    env: clientEnv(db),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const exited = new Promise((ok, fail) => {
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`client exited ${code}`))));
  });
  await Promise.all([
    pipeline(createReadStream(file), createGunzip(), definerStripper(), child.stdin),
    exited,
  ]);
}

function appliedVersions(db) {
  const out = execFileSync(
    CLIENT,
    [
      ...clientArgs(db),
      '-N',
      '-B',
      '-e',
      "SELECT version FROM schema_migrations WHERE status = 'applied' ORDER BY version",
    ],
    { env: clientEnv(db), encoding: 'utf8' },
  );
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    from: 'string',
    target: 'string',
    uploads: 'string',
    apply: 'boolean',
    'i-know': 'boolean',
  });
  if (!args.from) throw new Error('--from <backup dir> is required');
  if (!args.target) throw new Error('--target <DATABASE_URL> is required');
  const iKnow = Boolean(args['i-know']);

  const dir = resolve(ROOT, args.from);
  const manifest = validateManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
  const dbFile = join(dir, manifest.files.db.name);
  if (!existsSync(dbFile)) throw new Error(`${dbFile} is missing`);

  const db = parseDatabaseUrl(args.target);
  const guard = checkTargetName(db.database, iKnow);
  if (!guard.ok) throw new Error(guard.reason);
  if (guard.warning) console.warn(guard.warning);

  const uploadsDest = resolve(
    ROOT,
    args.uploads ??
      process.env.STORAGE_LOCAL_DIR ??
      process.env.STORAGE_FILESYSTEM_ROOT ??
      '.local/storage',
  );
  const upFile = manifest.files.uploads ? join(dir, manifest.files.uploads.name) : null;

  console.log(
    `Backup ${manifest.stamp} (git ${manifest.gitSha ?? 'unknown'}), from ${manifest.database}`,
  );
  console.log(`  db       ${dbFile} -> ${db.user}@${db.host}:${db.port}/${db.database}`);
  console.log(
    `  ledger   expect ${manifest.migrations.count} migrations, latest ${manifest.migrations.latest}`,
  );
  console.log(`  uploads  ${upFile ? `${upFile} -> ${uploadsDest}` : 'none in this backup'}`);
  if (!args.apply) {
    console.log('Dry run: nothing changed. Re-run with --apply to restore.');
    return;
  }

  if (upFile && existsSync(uploadsDest) && readdirSync(uploadsDest).length > 0 && !iKnow) {
    throw new Error(`${uploadsDest} is not empty; pass --i-know to extract over it`);
  }

  console.log('Replaying the dump...');
  await replayDump(db, dbFile);

  const check = compareMigrations(manifest.migrations.versions, appliedVersions(db));
  if (upFile) {
    mkdirSync(uploadsDest, { recursive: true });
    execFileSync('tar', ['-xzf', upFile, '-C', uploadsDest], { stdio: 'inherit' });
    console.log(`Uploads restored to ${uploadsDest}`);
  }
  if (!check.ok) {
    console.error(
      `Ledger differs from manifest. Missing: [${check.missing.join(', ')}]; extra: [${check.extra.join(', ')}].`,
    );
    process.exit(2);
  }
  console.log('Restore complete; migrations ledger matches the manifest.');
}

main().catch((err) => {
  console.error(`restore failed: ${err.message}`);
  process.exit(1);
});
