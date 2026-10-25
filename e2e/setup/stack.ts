import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMariaDb } from '../../scripts/db/mariadb-server.mjs';

/**
 * The e2e stack — TEST-003's fixture: a real MariaDB 11.8 (the production engine), the
 * real migrations, the
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
const E2E_NEXT_DIST_DIR = '.next-e2e';

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
    // The journeys sign in through the development route; it now needs this explicit opt-in.
    ALLOW_DEV_SIGN_IN: 'true',
    // The lead journeys post many contact submissions from one address; the production
    // budget (5 per 10 minutes) is proved by the API unit suite and the Hostinger smoke.
    RATE_LIMIT_CONTACT_MAX_REQUESTS: '1000',
    API_PORT: String(API_PORT),
    API_PUBLIC_URL: API_URL,
    WEB_PUBLIC_URL: WEB_URL,
    CORS_ALLOWED_ORIGINS: `${WEB_URL},http://localhost:${WEB_PORT}`,
    DATABASE_URL: databaseUrl,
    DATABASE_MIGRATION_URL: `${databaseUrl}?connectionLimit=1`,
    SESSION_SECRET: 'local_dev_only_session_secret_for_the_e2e_stack_xxxxxx',
    CSRF_SECRET: 'local_dev_only_csrf_secret_for_the_e2e_stack_xxxxxxxxxx',
    // D07. Required in every environment, so the stack has to carry one. Its own key, and
    // an obviously local one: the journeys enrol real factors against it.
    AUTH_MFA_SEED_KEYS: '1:local_dev_only_mfa_seed_key_for_the_e2e_x00',
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
 * Run USAGE-001 slice 3's counter reconciler once, to completion — the step that closes the
 * loop the ledger (slice 2) opened, run in the same tick the sweeper is (`reconcile:once`
 * after `sweep:once`).
 *
 * The API's own `reconcile.ts`, the shape `reconcile:once` deploys, with the environment the
 * API got: the same database, so the pass reads and repairs through the same counters, ledger
 * and audit the routes use. One invocation is one whole pass — the reconciler batches
 * internally over every organization — so, like {@link sweepUploads}, there is no loop here.
 * The report line is the reconciler's `[reconciler] pass:` on stderr; an organization whose
 * counter could not be reconciled is `failed N` in it and the process still exits zero, so the
 * helper reads the count and fails the journey itself.
 */
export async function reconcileUsage(databaseUrl: string, storageRoot?: string): Promise<string> {
  const { stdout, stderr } = await run(
    'pnpm',
    ['--filter', '@tmanage/api', 'exec', 'tsx', 'src/reconcile.ts', '--once'],
    { cwd: REPO_ROOT, env: apiEnv(databaseUrl, storageRoot) },
  );
  const report = /\[reconciler\] pass: (.*)/.exec(`${stderr}\n${stdout}`)?.[1]?.trim();
  if (!report) {
    throw new Error(`reconcileUsage: the reconciler printed no report\n${stderr}\n${stdout}`);
  }
  const failed = Number(/failed (\d+)/.exec(report)?.[1] ?? '0');
  if (failed > 0)
    throw new Error(`reconcileUsage: an organization failed to reconcile — ${report}`);
  return report;
}

/**
 * Run FILE-002's verification and scan passes once — E2E-12a's steps between "uploaded" and
 * "downloadable". The API's own `verify.ts`, the shape `verify:once` deploys, with the
 * environment the API got (the same database, the same storage root, the stub scanner).
 * One invocation runs the verifier then the scanner; each prints one report line on
 * stderr. A pass that could not judge an object is `failed N` in its line and the process
 * still exits zero, so the helper reads both counts and fails the journey itself.
 */
export async function verifyUploads(
  databaseUrl: string,
  storageRoot?: string,
): Promise<{ verifier: string; scanner: string }> {
  const { stdout, stderr } = await run(
    'pnpm',
    ['--filter', '@tmanage/api', 'exec', 'tsx', 'src/verify.ts', '--once'],
    { cwd: REPO_ROOT, env: apiEnv(databaseUrl, storageRoot) },
  );
  const output = `${stderr}\n${stdout}`;
  const verifier = /\[verifier\] pass: (.*)/.exec(output)?.[1]?.trim();
  const scanner = /\[scanner\] pass: (.*)/.exec(output)?.[1]?.trim();
  if (!verifier || !scanner) {
    throw new Error(`verifyUploads: a pass printed no report\n${stderr}\n${stdout}`);
  }
  for (const [name, report] of [
    ['verifier', verifier],
    ['scanner', scanner],
  ] as const) {
    const failedCount = /failed (\d+)/.exec(report)?.[1];
    if (failedCount === undefined) {
      throw new Error(`verifyUploads: the ${name} report omitted its failure count — ${report}`);
    }
    if (Number(failedCount) > 0) {
      throw new Error(`verifyUploads: the ${name} failed on an object — ${report}`);
    }
  }
  return { verifier, scanner };
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

/** The two governed version ids E2E-05's deep-link decide journey opens against. */
export interface ApprovalFixture {
  readonly deliverableVersionId: string;
  readonly secondDeliverableVersionId: string;
}

/**
 * Seed E2E-05's approval fixture into the running stack — a governed `deliverable_versions` row,
 * an opened `approvals` row, and a published `client_projections` row, twice (one per serial case),
 * naming the Atlas contact. Through the API package's own CLI (`test/approval-fixture-cli.ts`), the
 * way the seed and the upload-ageing are: this package holds no database client. The stack has no
 * HTTP route that mints a deliverable version (x101's skip note), so the journey's fixture is built
 * here, before the journey, and exposed on `world.atlas.approval`.
 */
export async function seedApprovalFixture(
  databaseUrl: string,
  config: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly publisherUserId: string;
    readonly publisherMembershipId: string;
    readonly approvedContactEmail: string;
    readonly approvedContactUserId: string;
  },
): Promise<ApprovalFixture> {
  const { stdout } = await run(
    'pnpm',
    [
      '--filter',
      '@tmanage/api',
      'exec',
      'tsx',
      'test/approval-fixture-cli.ts',
      config.organizationId,
      config.projectId,
      config.publisherUserId,
      config.publisherMembershipId,
      config.approvedContactEmail,
      config.approvedContactUserId,
    ],
    { cwd: REPO_ROOT, env: { ...process.env, TMANAGE_SEED_DATABASE_URL: databaseUrl } },
  );
  const line = stdout.trim().split('\n').pop() as string;
  const fixture = JSON.parse(line) as ApprovalFixture;
  if (!fixture.deliverableVersionId || !fixture.secondDeliverableVersionId) {
    throw new Error(`seedApprovalFixture: incomplete fixture from the CLI — ${line}`);
  }
  return fixture;
}

/** The slices of the seed world this harness reads to build the approval fixture. */
interface SeedWorldForApproval {
  readonly northstar: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly manager: { readonly id: string; readonly membershipId: string };
  };
  readonly atlas: { readonly admin: { readonly id: string; readonly email: string } };
}

export async function bootStack(): Promise<StackState & { stop: () => Promise<void> }> {
  // 1. A real MariaDB 11.8 — the engine production runs — private to this run.
  const server = await startMariaDb({ dbName: 'tmanage_e2e', logLevel: 'ERROR' });
  process.stdout.write(`[e2e stack] database ${server.version} on 127.0.0.1:${server.port}\n`);
  const databaseUrl = server.url;
  const storageRoot = mkdtempSync(join(tmpdir(), 'tmanage-e2e-storage-'));
  const env = apiEnv(databaseUrl, storageRoot);
  const pids: number[] = [];

  // One teardown for every path: Playwright's returned teardown on success, and the catch
  // below when any boot step throws (a failed globalSetup never gets a teardown called, so
  // without it a half-booted run would leave mariadbd and ports 3100/3101 behind).
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
    try {
      await server.stop();
    } finally {
      rmSync(storageRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  };

  try {
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

    // 3b. E2E-05's approval fixture (T001). The seed world carries no deliverable version to open the
    // client deep link against and the stack mints none at runtime, so seed one here and hang the two
    // governed version ids off `world.atlas.approval`, where the journey reads them.
    const seedWorld = world as unknown as SeedWorldForApproval;
    const approval = await seedApprovalFixture(databaseUrl, {
      organizationId: seedWorld.northstar.organizationId,
      projectId: seedWorld.northstar.projectId,
      publisherUserId: seedWorld.northstar.manager.id,
      publisherMembershipId: seedWorld.northstar.manager.membershipId,
      approvedContactEmail: seedWorld.atlas.admin.email,
      approvedContactUserId: seedWorld.atlas.admin.id,
    });
    (world['atlas'] as Record<string, unknown>)['approval'] = approval;

    // 4. The API and the web app, as they actually run. The web build cache goes first:
    // NEXT_PUBLIC_* values are inlined at compile time, and a `.next` warmed under a
    // developer's own environment would serve chunks that dial the developer's API — the
    // exact stale-inline failure this harness's first run produced.
    // The harness builds into its own directory, so a developer's `next dev` on the same app
    // keeps its `.next` (and keeps running) while the journeys run.
    rmSync(join(REPO_ROOT, 'apps/web', E2E_NEXT_DIST_DIR), { recursive: true, force: true });
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
          // Deliberately NOT setting NEXT_PUBLIC_SESSION_COOKIE_NAME. The API above runs on the
          // documented default cookie name, and the browser must find the CSRF cookie by *its*
          // default too: review finding D02 was a browser default (`tm_session_csrf`) that
          // disagreed with the server's, and this override is what hid it from the suite.
          PORT: String(WEB_PORT),
          TMANAGE_NEXT_DIST_DIR: E2E_NEXT_DIST_DIR,
        },
        logName: 'web',
      },
    );
    for (const child of [api, web]) {
      if (typeof child.pid === 'number') pids.push(child.pid);
    }

    await waitForHttp(API_URL, 120_000);
    await waitForHttp(WEB_URL, 240_000);

    return { databaseUrl, storageRoot, world, pids, stop };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
