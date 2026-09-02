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
 */
function apiEnv(databaseUrl: string): NodeJS.ProcessEnv {
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
): Promise<{ stdout: string }> {
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
      if (code === 0) resolvePromise({ stdout });
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
 * tick would have produced. Idempotent by the outbox's own claim: a second drain with
 * nothing pending is a report of zero.
 */
export async function drainOutbox(databaseUrl: string): Promise<string> {
  const { stdout } = await run(
    'pnpm',
    ['--filter', '@tmanage/worker', 'exec', 'tsx', 'src/main.ts', '--once'],
    { cwd: REPO_ROOT, env: apiEnv(databaseUrl) },
  );
  return stdout;
}

export async function bootStack(): Promise<StackState & { stop: () => Promise<void> }> {
  // 1. A real MySQL, private to this run.
  const server = await createDB({
    dbName: 'tmanage_e2e',
    logLevel: 'ERROR',
    downloadBinaryOnce: true,
  });
  const databaseUrl = `mysql://${server.username}@127.0.0.1:${server.port}/${server.dbName}`;
  const env = apiEnv(databaseUrl);

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
  };

  return { databaseUrl, world, pids, stop };
}
