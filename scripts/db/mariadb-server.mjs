// @ts-check
/**
 * Private, throwaway MariaDB 11.8 servers for tests ("tests bring their own database").
 *
 * WHY MARIADB, AND WHY THIS FILE
 *   Production is Hostinger shared hosting, whose server reports `11.8.9-MariaDB-log`. MariaDB is
 *   therefore the single supported engine. The suites used to start an embedded server through
 *   `mysql-memory-server`, which can only run MySQL; a migration that MySQL accepts and MariaDB
 *   rejects (generated columns, collation defaults, JSON details) passed locally and then failed
 *   the live deploy. This module replaces it with a genuine MariaDB 11.8.9 server binary, started
 *   as a child process on an ephemeral 127.0.0.1 port, one per caller. It depends only on Node
 *   built-ins and `mysql2` (already a root dependency), so the API tests, the e2e stack and the
 *   Hostinger smoke test can all import it without a build step.
 *
 * WHERE THE BINARIES COME FROM
 *   1. `TMANAGE_MARIADB_HOME`, if set: a directory containing `bin/mariadbd[.exe]`.
 *   2. Windows: a cache at `<repo>/.local/mariadb/mariadb-11.8.9-winx64` (`.local/` is gitignored).
 *      If it is missing it is extracted from `<repo>/.local/mariadb/download/mariadb-11.8.9-winx64.zip`,
 *      which is downloaded from archive.mariadb.org when absent. The ZIP's sha256 is ALWAYS checked
 *      against the pinned value below before anything is extracted; a mismatch is refused. The
 *      extraction goes to a temporary directory and is renamed into place, under a lock file, so
 *      two first runs at once cannot see a half-extracted runtime.
 *   3. Other platforms: `mariadbd` on PATH. No Linux archive checksum is pinned here, so nothing
 *      is downloaded; CI uses the MariaDB service from compose.yaml through
 *      `TMANAGE_TEST_DATABASE_URL` instead.
 *   Whatever the source, `mariadbd --version` must report 11.8.x or the runtime is refused.
 *
 * WHY A TEMPLATE DATADIR THAT IS COPIED
 *   `mariadb-install-db` takes several seconds and creates a ~150 MB datadir (a 96 MB redo log).
 *   It runs ONCE per version into `<repo>/.local/mariadb/template-11.8.9`: the system tables are
 *   created, the template is booted once with grant tables off to normalise the accounts
 *   (passwordless `root` reachable over TCP from 127.0.0.1, no anonymous `''@host` accounts that
 *   would shadow `'user'@'%'` grants, no `test` database) and to shrink the redo log to 16 MB, and
 *   it is shut down cleanly. Every start then copies that template into a fresh temp directory,
 *   which takes well under a second, so each test file gets a pristine server and parallel files
 *   never share state. The template is never run in place.
 *
 * WHY THE SERVER OPTIONS LOOK LIKE THIS
 *   They mirror production where it matters to the schema and the queries:
 *   - utf8mb4 with `utf8mb4_unicode_ci` as server collation AND as the utf8mb4 default
 *     (`character-set-collations`), because MariaDB 11.x otherwise maps utf8mb4 to uca1400;
 *   - strict SQL mode and UTC session time zone;
 *   - binary logging ON (`log-bin`, `server-id=1`): production's version string ends in `-log`,
 *     i.e. binlog is on. That changes behaviour (statement safety rules, trigger and function
 *     creation checks), so tests must see it too. `log_bin_trust_function_creators` is ON because
 *     the production migrator, an ordinary shared-hosting user without SUPER, did create the
 *     triggers of the applied migrations under binlog — production effectively allows it.
 *   The server binds 127.0.0.1 only and root has no password: the same posture as the embedded
 *   server it replaces, and acceptable only because the server is private, ephemeral and local.
 *
 * CLEANUP
 *   `stop()` shuts the server down (SQL `SHUTDOWN`), kills it if it has not exited after 15 s, and
 *   deletes its datadir. It is idempotent. Process `exit`, SIGINT and SIGTERM handlers kill every
 *   child still running, so a crashed or interrupted run leaves no stray `mariadbd` behind, and
 *   datadirs orphaned by a hard kill are swept on the next start.
 *
 * CLI
 *   node scripts/db/mariadb-server.mjs ensure   prepare the runtime and template, print the version
 *   node scripts/db/mariadb-server.mjs start    start one server, print its URL, run until Ctrl+C
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { clearTimeout } from 'node:timers';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';

export const MARIADB_VERSION = '11.8.9';

const ZIP_NAME = `mariadb-${MARIADB_VERSION}-winx64.zip`;
const ZIP_URL = `https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/winx64-packages/${ZIP_NAME}`;
const ZIP_SHA256 = '830c46727d9278eae212ae3eca44eeb9e71b2a68704e95f344a64fba7b1963f5';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE_DIR = join(REPO_ROOT, '.local', 'mariadb');
const TEMPLATE_DIR = join(CACHE_DIR, `template-${MARIADB_VERSION}`);
const RUN_PREFIX = 'tmanage-mariadb-';
const OWNER_FILE = 'tmanage-owner.json';
const IS_WINDOWS = process.platform === 'win32';
const EXE = IS_WINDOWS ? '.exe' : '';

const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 10 * 60_000;
const LOCK_STALE_MS = 15 * 60_000;
const VERSION_RE = /^11\.8\.\d+-MariaDB/;
const DB_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

/** @typedef {'ERROR' | 'WARN' | 'LOG'} LogLevel */
/** @typedef {{ home: string; bin: string; version: string }} MariaDbRuntime */

const LEVELS = { ERROR: 0, WARN: 1, LOG: 2 };

/**
 * Writes `message` to stderr when its level is within the caller's configured verbosity.
 *
 * @param {LogLevel} messageLevel
 * @param {LogLevel} configured
 * @param {string} message
 */
function log(messageLevel, configured, message) {
  if (LEVELS[messageLevel] <= LEVELS[configured]) {
    process.stderr.write(`[mariadb-server] ${message}\n`);
  }
}

// ── Child-process bookkeeping ────────────────────────────────────────────────────────────────

/** @type {Set<import('node:child_process').ChildProcess>} */
const liveChildren = new Set();
let handlersInstalled = false;

function killAllChildren() {
  for (const child of liveChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  liveChildren.clear();
}

function installExitHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', killAllChildren);
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    const onSignal = () => {
      killAllChildren();
      // If nobody else handles the signal, restore the default behaviour (terminate).
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, onSignal);
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, onSignal);
  }
}

/** @param {number} pid */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ── Lock files (first-run extraction and template build) ────────────────────────────────────

/**
 * Runs `work` while holding an exclusive lock file. A lock whose owner process is dead, or that
 * is older than LOCK_STALE_MS, is treated as abandoned and taken over.
 *
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
async function withLock(lockPath, work) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      break;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
        stale =
          !isAlive(Number(owner.pid)) || Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        // Half-written by a process that is writing it right now, or removed meanwhile.
        stale = false;
      }
      if (stale) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${lockPath}`);
      await sleep(500);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

// ── Runtime resolution ──────────────────────────────────────────────────────────────────────

/**
 * @param {string} mariadbd absolute path to the server binary
 * @returns {string} the version, e.g. "11.8.9"
 */
function binaryVersion(mariadbd) {
  const result = spawnSync(mariadbd, ['--version'], { encoding: 'utf8', windowsHide: true });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const match = /Ver\s+(\d+\.\d+\.\d+)-MariaDB/.exec(out);
  if (result.error || !match) {
    throw new Error(
      `Could not read the version of ${mariadbd}: ${result.error?.message ?? out.trim()}`,
    );
  }
  if (!/^11\.8\.\d+$/.test(match[1])) {
    throw new Error(
      `${mariadbd} is MariaDB ${match[1]}; TManage requires MariaDB 11.8.x (production is 11.8.9).`,
    );
  }
  return match[1];
}

/** @param {string} file */
async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** @param {string} zipPath */
async function downloadZip(zipPath) {
  mkdirSync(dirname(zipPath), { recursive: true });
  const part = `${zipPath}.${process.pid}.part`;
  process.stderr.write(`[mariadb-server] downloading ${ZIP_URL}\n`);
  const response = await fetch(ZIP_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Download of ${ZIP_URL} failed: HTTP ${response.status}`);
  }
  await pipeline(
    Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (response.body)),
    createWriteStream(part),
  );
  renameSync(part, zipPath);
}

/** @param {string} home */
async function extractWindowsRuntime(home) {
  const zipPath = join(CACHE_DIR, 'download', ZIP_NAME);
  if (!existsSync(zipPath)) await downloadZip(zipPath);
  const actual = await sha256(zipPath);
  if (actual !== ZIP_SHA256) {
    throw new Error(
      `Refusing ${zipPath}: sha256 ${actual} does not match the pinned ${ZIP_SHA256}. ` +
        'Delete the file to download it again, or put the official archive there.',
    );
  }
  const staging = mkdtempSync(join(CACHE_DIR, 'extract-'));
  try {
    // Windows' own bsdtar reads ZIP archives; a Git-for-Windows GNU tar earlier on PATH does not.
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const result = spawnSync(tar, ['-xf', zipPath, '-C', staging], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(`Extracting ${zipPath} failed: ${result.error?.message ?? result.stderr}`);
    }
    const extracted = join(staging, `mariadb-${MARIADB_VERSION}-winx64`);
    if (!existsSync(join(extracted, 'bin', `mariadbd${EXE}`))) {
      throw new Error(`${zipPath} did not contain mariadb-${MARIADB_VERSION}-winx64/bin/mariadbd`);
    }
    renameSync(extracted, home);
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** @param {string} name */
function findOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** @type {Promise<MariaDbRuntime> | undefined} */
let runtimePromise;

/**
 * Locates (and on Windows, if needed, extracts) a MariaDB 11.8 runtime and returns its home
 * directory, its `bin` directory (the directory holding `mariadbd`) and the binary's version.
 *
 * @returns {Promise<MariaDbRuntime>}
 */
export function ensureMariaDbRuntime() {
  runtimePromise ??= resolveRuntime().catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

/** @returns {Promise<MariaDbRuntime>} */
async function resolveRuntime() {
  const fromEnv = process.env.TMANAGE_MARIADB_HOME;
  if (fromEnv) {
    const home = resolve(fromEnv);
    const bin = join(home, 'bin');
    const mariadbd = join(bin, `mariadbd${EXE}`);
    if (!existsSync(mariadbd)) {
      throw new Error(`TMANAGE_MARIADB_HOME=${fromEnv} has no bin/mariadbd${EXE}`);
    }
    return { home, bin, version: binaryVersion(mariadbd) };
  }

  if (IS_WINDOWS) {
    const home = join(CACHE_DIR, `mariadb-${MARIADB_VERSION}-winx64`);
    const mariadbd = join(home, 'bin', 'mariadbd.exe');
    if (!existsSync(mariadbd)) {
      await withLock(join(CACHE_DIR, 'runtime.lock'), async () => {
        if (!existsSync(mariadbd)) await extractWindowsRuntime(home);
      });
    }
    return { home, bin: join(home, 'bin'), version: binaryVersion(mariadbd) };
  }

  const onPath = findOnPath('mariadbd');
  if (onPath) {
    let version;
    try {
      version = binaryVersion(onPath);
    } catch (error) {
      throw new Error(
        `${/** @type {Error} */ (error).message} Set TMANAGE_MARIADB_HOME to a MariaDB 11.8 ` +
          'install, or point the tests at a server with TMANAGE_TEST_DATABASE_URL.',
      );
    }
    const bin = dirname(onPath);
    return { home: dirname(bin), bin, version };
  }
  throw new Error(
    'No MariaDB 11.8 runtime found. On this platform nothing is downloaded: set ' +
      'TMANAGE_MARIADB_HOME to a MariaDB 11.8 install (a directory with bin/mariadbd), put an ' +
      '11.8 mariadbd on PATH, or run a server (e.g. `docker compose up -d mariadb` from ' +
      'compose.yaml) and set TMANAGE_TEST_DATABASE_URL.',
  );
}

// ── Server processes ────────────────────────────────────────────────────────────────────────

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.unref();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

/** @param {string} p */
const iniPath = (p) => p.replace(/\\/g, '/');

/**
 * @param {string} datadir
 * @param {MariaDbRuntime} runtime
 * @param {number} port
 * @param {string[]} extra
 */
function writeIni(datadir, runtime, port, extra) {
  const lines = [
    '[mysqld]',
    `basedir=${iniPath(runtime.home)}`,
    `datadir=${iniPath(datadir)}`,
    `port=${port}`,
    'bind-address=127.0.0.1',
    ...(IS_WINDOWS ? [] : [`socket=${iniPath(join(datadir, 'mysqld.sock'))}`]),
    ...(!IS_WINDOWS && process.getuid?.() === 0 ? ['user=root'] : []),
    'innodb_log_file_size=16M',
    ...extra,
    '',
  ];
  const file = join(datadir, 'my.ini');
  writeFileSync(file, lines.join('\n'));
  return file;
}

/** @param {string} file */
function tail(file, lines = 30) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/**
 * Spawns mariadbd and waits until it accepts a root connection.
 *
 * @param {MariaDbRuntime} runtime
 * @param {string} ini
 * @param {string} logFile
 * @param {number} port
 */
async function spawnServer(runtime, ini, logFile, port) {
  installExitHandlers();
  const logFd = openSync(logFile, 'a');
  const child = spawn(
    join(runtime.bin, `mariadbd${EXE}`),
    [`--defaults-file=${ini}`, '--console'],
    {
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    },
  );
  closeSync(logFd);
  liveChildren.add(child);
  /** @type {{ code: number | null } | undefined} */
  let exited;
  const exitPromise = new Promise((done) => {
    child.once('exit', (code) => {
      exited = { code };
      liveChildren.delete(child);
      done(undefined);
    });
    child.once('error', (error) => {
      exited = { code: -1 };
      liveChildren.delete(child);
      writeFileSync(logFile, `\nspawn error: ${error.message}\n`, { flag: 'a' });
      done(undefined);
    });
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (exited) {
      const logTail = tail(logFile);
      const bindFailure = /Bind on TCP\/IP port|Address already in use|already have another/i.test(
        logTail,
      );
      return { child, exitPromise, ready: false, bindFailure, logTail };
    }
    try {
      const conn = await mysql.createConnection({
        host: '127.0.0.1',
        port,
        user: 'root',
        connectTimeout: 2000,
      });
      await conn.end();
      return { child, exitPromise, ready: true, bindFailure: false, logTail: '' };
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      await exitPromise;
      return { child, exitPromise, ready: false, bindFailure: false, logTail: tail(logFile) };
    }
    await sleep(250);
  }
}

/**
 * Shuts a server down: SQL SHUTDOWN, then a kill after STOP_TIMEOUT_MS.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {Promise<unknown>} exitPromise
 * @param {number} port
 */
async function shutdownServer(child, exitPromise, port) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      const conn = await mysql.createConnection({
        host: '127.0.0.1',
        port,
        user: 'root',
        connectTimeout: 2000,
      });
      await conn.query('SHUTDOWN').catch(() => {});
      conn.destroy();
    } catch {
      // unreachable: fall through to the kill
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    await exitPromise;
    clearTimeout(timer);
  }
  liveChildren.delete(child);
}

/**
 * Starts a server on a free port, retrying with a new port if another process took it between
 * the probe and the bind. `prepare(datadir)` must leave a fresh datadir each attempt.
 *
 * @param {MariaDbRuntime} runtime
 * @param {(port: number) => { datadir: string; ini: string; logFile: string }} prepare
 */
async function startOnFreePort(runtime, prepare) {
  let lastTail = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await freePort();
    const { datadir, ini, logFile } = prepare(port);
    const started = await spawnServer(runtime, ini, logFile, port);
    if (started.ready) return { ...started, port, datadir };
    rmSync(datadir, { recursive: true, force: true, maxRetries: 5 });
    lastTail = started.logTail;
    if (!started.bindFailure) break;
  }
  throw new Error(`mariadbd did not become ready. Log tail:\n${lastTail}`);
}

// ── Template datadir ────────────────────────────────────────────────────────────────────────

/** @param {MariaDbRuntime} runtime */
function findInstallDb(runtime) {
  const name = `mariadb-install-db${IS_WINDOWS ? '.exe' : ''}`;
  for (const dir of [runtime.bin, join(runtime.home, 'bin'), join(runtime.home, 'scripts')]) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  const onPath = findOnPath(name);
  if (onPath) return onPath;
  throw new Error(`Cannot find ${name} next to ${runtime.bin}`);
}

/** @param {MariaDbRuntime} runtime @param {LogLevel} level */
async function ensureTemplate(runtime, level) {
  const marker = join(TEMPLATE_DIR, 'mysql');
  if (existsSync(marker)) return;
  await withLock(join(CACHE_DIR, `template-${MARIADB_VERSION}.lock`), async () => {
    if (existsSync(marker)) return;
    log('WARN', level, `building the MariaDB ${runtime.version} template datadir (first run only)`);
    // Built under the OS temp dir: mariadb-install-db's bootstrap fails on very long paths.
    const work = mkdtempSync(join(tmpdir(), 'tmanage-mdbtpl-'));
    const datadir = join(work, 'data');
    try {
      const installDb = findInstallDb(runtime);
      const args = [`--datadir=${datadir}`];
      if (!IS_WINDOWS) {
        args.unshift('--no-defaults');
        args.push(`--basedir=${runtime.home}`, '--auth-root-authentication-method=normal');
      }
      const result = spawnSync(installDb, args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 180_000,
      });
      if (result.status !== 0 || !existsSync(join(datadir, 'mysql'))) {
        throw new Error(
          `mariadb-install-db failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
        );
      }

      // Boot once with grant tables off to normalise the accounts and resize the redo log.
      const logFile = join(work, 'template.log');
      const started = await startOnFreePort(runtime, (port) => ({
        datadir,
        ini: writeIni(datadir, runtime, port, ['skip-grant-tables', 'skip-log-bin']),
        logFile,
      }));
      try {
        const conn = await mysql.createConnection({
          host: '127.0.0.1',
          port: started.port,
          user: 'root',
        });
        try {
          await conn.query('FLUSH PRIVILEGES');
          const host = hostname().toLowerCase();
          await conn.query("CREATE USER IF NOT EXISTS 'root'@'127.0.0.1'");
          const [roots] = /** @type {[Array<{ Host: string }>, unknown]} */ (
            await conn.query("SELECT Host FROM mysql.global_priv WHERE User = 'root'")
          );
          const rootHosts = new Set(roots.map((row) => row.Host));
          for (const h of ['localhost', '127.0.0.1', '::1'].filter((x) => rootHosts.has(x))) {
            await conn.query(
              "ALTER USER ?@? IDENTIFIED VIA mysql_native_password USING PASSWORD('')",
              ['root', h],
            );
            await conn.query('GRANT ALL PRIVILEGES ON *.* TO ?@? WITH GRANT OPTION', ['root', h]);
          }
          const [anonymous] = /** @type {[Array<{ Host: string }>, unknown]} */ (
            await conn.query("SELECT Host FROM mysql.global_priv WHERE User = ''")
          );
          for (const row of anonymous) await conn.query("DROP USER ''@?", [row.Host]);
          for (const h of ['localhost', '%', host]) {
            await conn.query("DROP USER IF EXISTS ''@?", [h]);
          }
          await conn.query("DELETE FROM mysql.db WHERE User = ''");
          await conn.query('DROP DATABASE IF EXISTS test');
          await conn.query('FLUSH PRIVILEGES');
        } finally {
          await conn.end();
        }
      } finally {
        await shutdownServer(started.child, started.exitPromise, started.port);
      }
      if (started.child.exitCode !== 0) {
        throw new Error(`Template server did not shut down cleanly:\n${tail(logFile)}`);
      }
      for (const entry of readdirSync(datadir)) {
        if (/\.(err|pid|log)$/i.test(entry) || entry === 'my.ini') {
          rmSync(join(datadir, entry), { force: true });
        }
      }

      mkdirSync(CACHE_DIR, { recursive: true });
      try {
        renameSync(datadir, TEMPLATE_DIR);
      } catch (error) {
        if (!['EXDEV', 'EPERM'].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? '')) {
          throw error;
        }
        const staging = `${TEMPLATE_DIR}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
        cpSync(datadir, staging, { recursive: true });
        renameSync(staging, TEMPLATE_DIR);
      }
      log('LOG', level, `template ready at ${TEMPLATE_DIR}`);
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5 });
    }
  });
}

/**
 * Cleans up after runs that were hard-killed (TerminateProcess / SIGKILL), where no exit handler
 * could run: for every per-start datadir whose owning Node process is gone, a server still
 * running from it is shut down -- only after `@@datadir` proves it is that datadir's server -- and
 * the directory is removed.
 */
async function sweepOrphans() {
  let entries;
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  const norm = (/** @type {string} */ p) => resolve(p).toLowerCase();
  for (const entry of entries) {
    if (!entry.startsWith(RUN_PREFIX)) continue;
    const dir = join(tmpdir(), entry);
    try {
      const owner = JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8'));
      if (isAlive(Number(owner.pid))) continue;
      const serverPid = Number(owner.serverPid);
      if (isAlive(serverPid) && owner.port) {
        const conn = await mysql.createConnection({
          host: '127.0.0.1',
          port: Number(owner.port),
          user: 'root',
          connectTimeout: 2000,
        });
        try {
          const [rows] = /** @type {[Array<{ d: string }>, unknown]} */ (
            await conn.query('SELECT @@datadir AS d')
          );
          if (norm(rows[0].d) !== norm(dir)) continue;
          await conn.query('SHUTDOWN').catch(() => {});
        } finally {
          conn.destroy();
        }
        const deadline = Date.now() + STOP_TIMEOUT_MS;
        while (isAlive(serverPid) && Date.now() < deadline) await sleep(250);
      }
      if (!isAlive(serverPid)) rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // No owner file yet (being created right now), not ours, or unreachable: leave it.
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────────────────────

/**
 * Starts a private MariaDB 11.8 server on 127.0.0.1 with passwordless root and one empty
 * database, and returns how to reach it.
 *
 * @param {{ dbName?: string; port?: number; logLevel?: LogLevel }} [options]
 */
export async function startMariaDb(options = {}) {
  const dbName = options.dbName ?? 'tmanage_test';
  const level = options.logLevel ?? 'ERROR';
  if (!DB_NAME_RE.test(dbName)) throw new Error(`Invalid database name: ${dbName}`);

  const runtime = await ensureMariaDbRuntime();
  await ensureTemplate(runtime, level);
  await sweepOrphans();

  /** @param {number} port */
  const prepare = (port) => {
    const datadir = mkdtempSync(join(tmpdir(), RUN_PREFIX));
    cpSync(TEMPLATE_DIR, datadir, { recursive: true });
    writeFileSync(join(datadir, OWNER_FILE), JSON.stringify({ pid: process.pid, serverPid: 0 }));
    const ini = writeIni(datadir, runtime, port, [
      'character-set-server=utf8mb4',
      'collation-server=utf8mb4_unicode_ci',
      'character-set-collations=utf8mb4=utf8mb4_unicode_ci',
      'sql-mode=STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION,ERROR_FOR_DIVISION_BY_ZERO',
      'default-time-zone=+00:00',
      'default-storage-engine=InnoDB',
      'log-bin=mariadb-bin',
      'server-id=1',
      'log_bin_trust_function_creators=ON',
      'innodb_buffer_pool_size=128M',
      'max_connections=200',
    ]);
    return { datadir, ini, logFile: join(datadir, 'mariadbd.log') };
  };

  /** @type {Awaited<ReturnType<typeof startOnFreePort>>} */
  let started;
  if (options.port !== undefined) {
    const { datadir, ini, logFile } = prepare(options.port);
    const attempt = await spawnServer(runtime, ini, logFile, options.port);
    if (!attempt.ready) {
      rmSync(datadir, { recursive: true, force: true, maxRetries: 5 });
      throw new Error(
        `mariadbd did not become ready on port ${options.port}. Log tail:\n${attempt.logTail}`,
      );
    }
    started = { ...attempt, port: options.port, datadir };
  } else {
    started = await startOnFreePort(runtime, prepare);
  }
  const { child, exitPromise, port, datadir } = started;
  writeFileSync(
    join(datadir, OWNER_FILE),
    JSON.stringify({ pid: process.pid, serverPid: child.pid ?? 0, port }),
  );

  /** @type {Promise<void> | undefined} */
  let stopping;
  const stop = () => {
    stopping ??= (async () => {
      await shutdownServer(child, exitPromise, port);
      rmSync(datadir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      log('LOG', level, `stopped server on port ${port}`);
    })();
    return stopping;
  };

  let version;
  try {
    const conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
    try {
      await conn.query(
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      const [rows] = /** @type {[Array<{ v: string }>, unknown]} */ (
        await conn.query('SELECT VERSION() AS v')
      );
      version = rows[0].v;
    } finally {
      await conn.end();
    }
    if (!VERSION_RE.test(version)) {
      throw new Error(`Server reports ${version}; TManage requires MariaDB 11.8.x`);
    }
  } catch (error) {
    await stop();
    throw error;
  }

  log('LOG', level, `MariaDB ${version} ready on 127.0.0.1:${port} (datadir ${datadir})`);
  return {
    port,
    username: /** @type {const} */ ('root'),
    dbName,
    url: `mysql://root@127.0.0.1:${port}/${dbName}`,
    version,
    stop,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const command = process.argv[2] ?? 'start';
  if (command === 'ensure') {
    const runtime = await ensureMariaDbRuntime();
    await ensureTemplate(runtime, 'LOG');
    process.stdout.write(`MariaDB ${runtime.version} at ${runtime.home}\n`);
  } else if (command === 'start') {
    const server = await startMariaDb({ logLevel: 'LOG' });
    process.stdout.write(`${server.url}\n${server.version} - Ctrl+C to stop\n`);
    const shutdown = () => {
      server.stop().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    setInterval(() => {}, 1 << 30);
  } else {
    process.stderr.write('usage: node scripts/db/mariadb-server.mjs ensure | start\n');
    process.exitCode = 2;
  }
}
