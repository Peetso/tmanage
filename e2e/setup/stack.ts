import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDB } from 'mysql-memory-server';

/**
 * The e2e stack — TEST-003's fixture: a real embedded MySQL, the real migrations, the
 * real two-tenant seed, the real API, the real web app, torn down whole.
 *
 * Everything is spawned through the repository's own commands (`db:migrate`, the seed CLI,
 * `tsx src/main.ts`, `next dev`) rather than imported across workspace boundaries, so this
 * package holds no copy of any other package's logic — it holds a deployment in miniature.
 * Ports are fixed and unusual (3100/3101) so a developer's own running stack on 3000/3001
 * never collides with a test run.
 */

export const WEB_PORT = 3100;
export const API_PORT = 3101;
// `localhost`, not `127.0.0.1`: the Next dev server's cross-origin protection answers 403
// for its own static chunks when the page was reached under a host it did not expect —
// this harness's third run found that the hard way.
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const API_URL = `http://localhost:${API_PORT}`;

const REPO_ROOT = resolve(import.meta.dirname, '../..');

export interface StackState {
  readonly databaseUrl: string;
  /** FILE-001b. Where the API's filesystem driver keeps the bytes for this run. */
  readonly storageRoot: string;
  readonly world: Record<string, unknown>;
  readonly pids: readonly number[];
}

const STATE_PATH = join(tmpdir(), 'tmanage-e2e-state.json');

export function statePath(): string {
  return STATE_PATH;
}

/**
 * The API's full environment, from `.env.example`'s stance: development substitutes
 * everywhere a real service would be, and nothing here is a secret that guards anything.
 * `DATABASE_MIGRATION_URL` differs from `DATABASE_URL` only by a benign driver parameter,
 * because the embedded server has one root credential and `packages/config` refuses the
 * two URLs being *equal* — the credential split it protects is a production property the
 * test harness cannot have.
 *
 * `STORAGE_FILESYSTEM_ROOT` is absolute and private to the run (FILE-001b): the default
 * `.local/storage` resolves against the API child's working directory, which a spec that
 * wants to see the object land could not find. The signing secret is the driver's own,
 * distinct from the two above as `packages/config` requires in production.
 */
function apiEnv(databaseUrl: string, storageRoot?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'development',
    API_PORT: String(API_PORT),
    API_PUBLIC_URL: API_URL,
    WEB_PUBLIC_URL: WEB_URL,
    CORS_ALLOWED_ORIGINS: `${WEB_URL},http://localhost:${WEB_PORT}`,
    DATABASE_URL: databaseUrl,
    DATABASE_MIGRATION_URL: `${databaseUrl}?connectionLimit=1`,
    SESSION_SECRET: 'local_dev_only_session_secret_for_the_e2e_stack_xxxxxx',
    CSRF_SECRET: 'local_dev_only_csrf_secret_for_the_e2e_stack_xxxxxxxxxx',
    SESSION_COOKIE_NAME: 'tmanage_session',
    STORAGE_DRIVER: 'filesystem',
    STORAGE_BUCKET: 'e2e-local',
    STORAGE_LOCAL_SIGNING_SECRET: 'local_dev_only_storage_signing_secret_for_the_e2e_xxx',
    ...(storageRoot ? { STORAGE_FILESYSTEM_ROOT: storageRoot } : {}),
    // USAGE-001 / E2E-12b. Two of E2E-12a's uploads, so a journey can fill a tenant's
    // quota with one abandoned reservation and see the sweep give it back — the default
    // 500 MiB would take sixty such uploads to exhaust. E2E-12a still fits.
    STORAGE_ORG_BYTES_LIMIT_BYTES: String(2 * (8 * 1024 * 1024 + 16)),
    QUEUE_DRIVER: 'memory',
    CACHE_DRIVER: 'memory',
    EMAIL_DRIVER: 'console',
    EMAIL_FROM_ADDRESS: 'dev@tmanage.local',
    MALWARE_SCAN_DRIVER: 'stub',
  };
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stderr}\n${stdout}`));
    });
  });
}

function spawnServer(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; logName: string },
): ChildProcess {
  const logDir = mkdtempSync(join(tmpdir(), 'tmanage-e2e-'));
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const capture = (chunk: Buffer): void => {
    log += chunk.toString();
    writeFileSync(join(logDir, `${options.logName}.log`), log);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  return child;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url);
      return; // Any HTTP answer — even a 404 — means the server is up.
    } catch {
      if (Date.now() > deadline) throw new Error(`nothing answered ${url} in ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/**
 * Run the worker's outbox relay once, to completion — E2E-07's drain step.
 *
 * The stack boots the API and the web app and **not the worker**: a relay loop is a
 * process with no natural end, and a journey that waited on it would be waiting on a
 * timer. Instead a journey that needs the consumers to have run — a notification row
 * written, a mail composed — calls this between the act and the assertion. It is the
 * worker's own `--once` mode (`relay:once`, the shape the bootstrap profile deploys) with
 * the same environment the API got, so what the journey sees is what a deployment's cron
 * tick would have produced.
 *
 * "To completion" is a loop, not one call: `--once` is one batch of `OUTBOX_BATCH_SIZE`
 * (25 by default), oldest first, and the specs share one database, so a journey's own events
 * sit behind whatever the specs before it left unpublished. The first shape of this helper
 * ran one batch and called that a drain; the review fleet found it on 2026-09-03 — green
 * only while the backlog stayed under 25. Now it runs until a batch claims nothing, and a
 * batch in which a consumer failed, or parked an event, is the helper's own failure rather
 * than a silent "drained" followed by a visibility timeout fifteen seconds later. The
 * worker is given the run's storage root as the API was: the same objects, not a default
 * relative root under the worker's own working directory.
 */
export async function drainOutbox(databaseUrl: string, storageRoot?: string): Promise<string> {
  const reports: string[] = [];
  const passes = 20;
  let parkedBefore: number | null = null;
  for (let pass = 0; pass < passes; pass += 1) {
    const { stdout, stderr } = await run(
      'pnpm',
      ['--filter', '@tmanage/worker', 'exec', 'tsx', 'src/main.ts', '--once'],
      { cwd: REPO_ROOT, env: apiEnv(databaseUrl, storageRoot) },
    );
    // The worker reports on stderr (`console.warn`); the shape is main.ts's `describe`.
    const report = /\[worker\] batch: (.*)/.exec(`${stderr}\n${stdout}`)?.[1]?.trim();
    if (!report) {
      throw new Error(`drainOutbox: the worker printed no batch report\n${stderr}\n${stdout}`);
    }
    reports.push(report);
    // Three failure channels in the report, none of which exits non-zero: a consumer that
    // threw (`failed N`); an after-commit effect that threw (`of which N failed` — the mail a
    // journey may be about); and an event parked for good (`N parked`), which the worker
    // counts over the whole table, so only growth during this drain is this drain's.
    const failed = Number(/failed (\d+)/.exec(report)?.[1] ?? '0');
    const effectsFailed = Number(/of which (\d+) failed/.exec(report)?.[1] ?? '0');
    const parked = Number(/, (\d+) parked/.exec(report)?.[1] ?? '0');
    if (failed > 0 || effectsFailed > 0 || (parkedBefore !== null && parked > parkedBefore)) {
      throw new Error(`drainOutbox: a consumer failed — ${report}`);
    }
    parkedBefore = parked;
    if (/^claimed 0,/.test(report)) return reports.join('\n');
  }
  throw new Error(`drainOutbox: still claiming after ${passes} batches\n${reports.join('\n')}`);
}

/**
 * Run USAGE-001's expiry sweeper once, to completion — E2E-12b's step between "abandoned"
 * and "the quota is free again".
 *
 * The API's own `sweep.ts`, the shape `sweep:once` deploys, with the environment the API
 * got: the same database, the same storage root, so the abort reaches the same driver
 * that opened the upload. One invocation is one whole pass — the sweeper batches
 * internally until nothing is left — so, unlike {@link drainOutbox}, there is no loop
 * here. The report line is the sweeper's `[sweeper] pass:` on stderr; a release that
 * threw is `failed N` in it and the process still exits zero, so the helper reads the
 * count and fails the journey itself.
 */
export async function sweepUploads(databaseUrl: string, storageRoot?: string): Promise<string> {
  const { stdout, stderr } = await run(
    'pnpm',
    ['--filter', '@tmanage/api', 'exec', 'tsx', 'src/sweep.ts', '--once'],
    { cwd: REPO_ROOT, env: apiEnv(databaseUrl, storageRoot) },
  );
  const report = /\[sweeper\] pass: (.*)/.exec(`${stderr}\n${stdout}`)?.[1]?.trim();
  if (!report) {
    throw new Error(`sweepUploads: the sweeper printed no report\n${stderr}\n${stdout}`);
  }
  const failed = Number(/failed (\d+)/.exec(report)?.[1] ?? '0');
  if (failed > 0) throw new Error(`sweepUploads: a release failed — ${report}`);
  return report;
}

/**
 * Move one upload session's `expires_at` a day into the past, so the next sweep treats it
 * as abandoned. Through the API package's own CLI (`test/age-upload-session-cli.ts`), the
 * way the seed is: this package holds no database client, and is meant not to.
 */
export async function ageUploadSession(
  databaseUrl: string,
  uploadSessionId: string,
): Promise<void> {
  const { stdout } = await run(
    'pnpm',
    ['--filter', '@tmanage/api', 'exec', 'tsx', 'test/age-upload-session-cli.ts', uploadSessionId],
    { cwd: REPO_ROOT, env: { ...process.env, TMANAGE_SEED_DATABASE_URL: databaseUrl } },
  );
  const line = stdout.trim().split('\n').pop() as string;
  const { aged } = JSON.parse(line) as { aged: number };
  if (aged !== 1) throw new Error(`ageUploadSession: ${aged} rows aged for ${uploadSessionId}`);
}

export async function bootStack(): Promise<StackState & { stop: () => Promise<void> }> {
  // 1. A real MySQL, private to this run.
  const server = await createDB({
    dbName: 'tmanage_e2e',
    logLevel: 'ERROR',
    downloadBinaryOnce: true,
  });
  const databaseUrl = `mysql://${server.username}@127.0.0.1:${server.port}/${server.dbName}`;
  const storageRoot = mkdtempSync(join(tmpdir(), 'tmanage-e2e-storage-'));
  const env = apiEnv(databaseUrl, storageRoot);

  // 2. The real migrations, through the repository's own command.
  await run('pnpm', ['--filter', '@tmanage/api', 'db:migrate'], { cwd: REPO_ROOT, env });

  // 3. The exact seed world every database suite runs on.
  const seeded = await run(
    'pnpm',
    ['--filter', '@tmanage/api', 'exec', 'tsx', 'test/seed-cli.ts'],
    { cwd: REPO_ROOT, env: { ...env, TMANAGE_SEED_DATABASE_URL: databaseUrl } },
  );
  const world = JSON.parse(seeded.stdout.trim().split('\n').pop() as string) as Record<
    string,
    unknown
  >;

  // 4. The API and the web app, as they actually run. The web build cache goes first:
  // NEXT_PUBLIC_* values are inlined at compile time, and a `.next` warmed under a
  // developer's own environment would serve chunks that dial the developer's API — the
  // exact stale-inline failure this harness's first run produced.
  rmSync(join(REPO_ROOT, 'apps/web/.next'), { recursive: true, force: true });
  const api = spawnServer('pnpm', ['--filter', '@tmanage/api', 'exec', 'tsx', 'src/main.ts'], {
    cwd: REPO_ROOT,
    env,
    logName: 'api',
  });
  const web = spawnServer(
    'pnpm',
    ['--filter', '@tmanage/web', 'exec', 'next', 'dev', '--port', String(WEB_PORT)],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NEXT_PUBLIC_API_BASE_URL: API_URL,
        NEXT_PUBLIC_SESSION_COOKIE_NAME: 'tmanage_session',
        PORT: String(WEB_PORT),
      },
      logName: 'web',
    },
  );

  await waitForHttp(API_URL, 120_000);
  await waitForHttp(WEB_URL, 240_000);

  const pids = [api.pid, web.pid].filter((pid): pid is number => typeof pid === 'number');

  const stop = async (): Promise<void> => {
    for (const pid of pids) {
      if (process.platform === 'win32') {
        // Kill the whole tree: pnpm -> node is two processes, and orphaning the inner one
        // leaves ports 3100/3101 dead for every later run.
        await run('taskkill', ['/PID', String(pid), '/T', '/F'], { cwd: REPO_ROOT }).catch(
          () => undefined,
        );
      } else {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
      }
    }
    await server.stop();
    rmSync(storageRoot, { recursive: true, force: true, maxRetries: 3 });
  };

  return { databaseUrl, storageRoot, world, pids, stop };
}
