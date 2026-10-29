#!/usr/bin/env node
/**
 * Restores a backup written by `backup.mjs`. Dry run unless `--apply` is given.
 *
 *   node scripts/ops/restore.mjs --from backups/<stamp> --target mysql://u:p@h/tm_restore \
 *     [--uploads <dir>] [--identity <age key file>] [--apply] [--i-know]
 *
 * Env: MYSQL (client binary, default `mysql`; `mariadb` on MariaDB-only hosts),
 * STORAGE_LOCAL_DIR / STORAGE_FILESYSTEM_ROOT (default uploads destination),
 * BACKUP_AGE_IDENTITY_FILE (the offline `AGE-SECRET-KEY-1` file, for `.age` backups).
 *
 * Integrity: when the manifest records a file's SHA-256 it is checked before anything is replayed
 * (a mismatch stops the restore). Encrypted (`.age`) files are decrypted on the fly.
 *
 * Guards: the target database name must contain "restore" or "test", and the uploads
 * destination must be empty, unless `--i-know` is passed (a real rollback onto production).
 * After the replay the `schema_migrations` ledger is compared with the manifest; a mismatch
 * exits 2.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

import { decryptStream } from './backup-encrypt.mjs';

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

async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** The file as plaintext: decrypted when it is `.age`. */
function plainStream(file, identity) {
  const raw = createReadStream(file);
  if (!file.endsWith('.age')) return raw;
  if (!identity)
    throw new Error(`${file} is encrypted: pass --identity or BACKUP_AGE_IDENTITY_FILE`);
  return raw.pipe(decryptStream(identity));
}

async function replayDump(db, file, identity) {
  const child = spawn(CLIENT, [...clientArgs(db), '--default-character-set=utf8mb4'], {
    env: clientEnv(db),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const exited = new Promise((ok, fail) => {
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`client exited ${code}`))));
  });
  await Promise.all([
    pipeline(plainStream(file, identity), createGunzip(), definerStripper(), child.stdin),
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
    identity: 'string',
    apply: 'boolean',
    'i-know': 'boolean',
  });
  if (!args.from) throw new Error('--from <backup dir> is required');
  if (!args.target) throw new Error('--target <DATABASE_URL> is required');
  const iKnow = Boolean(args['i-know']);

  const dir = resolve(ROOT, args.from);
  // A folder downloaded from the off-site copy holds `<stamp>-<name>` files; accept both layouts.
  const manifestName =
    [
      'manifest.json',
      ...readdirSync(dir)
        .filter((n) => /^\d{8}T\d{6}Z-manifest\.json$/.test(n))
        .sort()
        .reverse(),
    ].find((n) => existsSync(join(dir, n))) ?? 'manifest.json';
  const manifest = validateManifest(JSON.parse(readFileSync(join(dir, manifestName), 'utf8')));
  const at = (name) => {
    const prefixed = join(dir, `${manifest.stamp}-${name}`);
    return existsSync(join(dir, name)) || !existsSync(prefixed) ? join(dir, name) : prefixed;
  };
  const dbFile = at(manifest.files.db.name);
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
  const upFile = manifest.files.uploads ? at(manifest.files.uploads.name) : null;
  const identityFile = args.identity ?? process.env.BACKUP_AGE_IDENTITY_FILE;
  const identity = identityFile ? readFileSync(identityFile, 'utf8') : null;

  for (const f of [manifest.files.db, manifest.files.uploads].filter(Boolean)) {
    if (typeof f.sha256 !== 'string') continue;
    const actual = await sha256File(at(f.name));
    if (actual !== f.sha256)
      throw new Error(`${f.name}: SHA-256 differs from the manifest (damaged or altered)`);
  }
  console.log('  sha256   files match the manifest');

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
  await replayDump(db, dbFile, identity);

  const check = compareMigrations(manifest.migrations.versions, appliedVersions(db));
  if (upFile) {
    mkdirSync(uploadsDest, { recursive: true });
    // No paths on tar's command line (see backup.mjs): archive on stdin, destination as cwd.
    if (upFile.endsWith('.age')) {
      const tar = spawn('tar', ['-xz'], {
        cwd: uploadsDest,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      const done = new Promise((ok, fail) => {
        tar.on('error', fail);
        tar.on('close', (code) => (code === 0 ? ok() : fail(new Error(`tar exited ${code}`))));
      });
      await Promise.all([pipeline(plainStream(upFile, identity), tar.stdin), done]);
    } else {
      const fd = openSync(upFile, 'r');
      try {
        execFileSync('tar', ['-xz'], { cwd: uploadsDest, stdio: [fd, 'inherit', 'inherit'] });
      } finally {
        closeSync(fd);
      }
    }
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
