import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * T2 (pass 2026-11-19) — run one of the worker's business-view jobs once, to the end, against the
 * e2e stack's database: the journeys' step between "something happened" and "the Activity tab /
 * the Home briefing / Growth shows it". The stack boots the API and the web app and not the worker
 * (`e2e/setup/stack.ts`, `drainOutbox`), so a journey runs the job it needs here, through the same
 * functions a deployment's scheduled jobs call (`apps/server/scheduled-sweeps.mjs`, the worker's
 * loops in `main.ts`).
 *
 * - `project-activity`: the projector's clock is moved past its settle window
 *   (`ACTIVITY_SETTLE_MS`, two minutes), which is all a journey would otherwise sit and wait for:
 *   the projector skips audit rows younger than that so a row still being committed is never
 *   jumped. Runs until a pass reads no event, so the whole back-fill lands, not one batch.
 * - `sweep-signals`: one signals sweep at the real time (the rules measure days).
 * - `growth-rollup`: one growth recompute (the nightly job), no mail.
 *
 * The worker modules are loaded from `apps/worker/src` (the T1 suites' shape): that package's
 * entry points at `dist`, which is not rebuilt for a test run. stdout is the contract: one JSON
 * line. A failed organization is a non-zero exit, never a quiet "done".
 *
 * Usage: `tsx test/business-view-sweeps-cli.ts <project-activity|sweep-signals|growth-rollup>` with
 * `TMANAGE_SEED_DATABASE_URL` set. Test tooling only; nothing in any runtime path invokes it.
 */

interface WorkerDatabase {
  end(): Promise<void>;
}

interface WorkerIndex {
  createWorkerDatabase(options: {
    url: string;
    connectionLimit: number;
    statementTimeoutMs: number;
  }): WorkerDatabase;
  createActivityProjectorStore(database: WorkerDatabase): unknown;
  runActivityProjection(deps: {
    store: unknown;
    now: Date;
  }): Promise<{ organizations: number; events: number; filed: number }>;
  createSignalsStore(database: WorkerDatabase): unknown;
  runSignalsSweep(deps: {
    store: unknown;
    now: Date;
    onError?: (error: unknown) => void;
  }): Promise<{ organizations: number; filed: number; failed: number }>;
}

interface ProjectorModule {
  readonly ACTIVITY_SETTLE_MS: number;
}

interface GrowthStoreModule {
  createGrowthRollupStore(database: WorkerDatabase): unknown;
}

interface GrowthModule {
  runGrowthRollup(deps: {
    store: unknown;
    mailer: null;
    alertEmails: readonly string[];
    composeReport: () => never;
  }): Promise<{ rows: number; deleted: number; reportSentTo: number }>;
}

const JOBS = ['project-activity', 'sweep-signals', 'growth-rollup'] as const;
type Job = (typeof JOBS)[number];

const HERE = dirname(fileURLToPath(import.meta.url));
const workerModule = async <T>(path: string): Promise<T> =>
  (await import(pathToFileURL(resolve(HERE, '../../worker/src', path)).href)) as T;

/** A back-fill bigger than this many passes is a projector that is not moving its cursor. */
const MAX_PROJECTION_PASSES = 50;

const url = process.env['TMANAGE_SEED_DATABASE_URL'];
const job = process.argv[2];
if (!url) {
  console.error('TMANAGE_SEED_DATABASE_URL is not set');
  process.exit(1);
}
if (!JOBS.includes(job as Job)) {
  console.error(`usage: business-view-sweeps-cli <${JOBS.join('|')}>`);
  process.exit(1);
}

const worker = await workerModule<WorkerIndex>('index.ts');
const database = worker.createWorkerDatabase({
  url,
  connectionLimit: 2,
  statementTimeoutMs: 30_000,
});

async function projectActivity(): Promise<Record<string, unknown>> {
  const { ACTIVITY_SETTLE_MS } = await workerModule<ProjectorModule>('jobs/activity-projector.ts');
  const store = worker.createActivityProjectorStore(database);
  let events = 0;
  let filed = 0;
  for (let pass = 0; ; pass += 1) {
    if (pass === MAX_PROJECTION_PASSES) {
      throw new Error(`the projector still read events after ${MAX_PROJECTION_PASSES} passes`);
    }
    const now = new Date(Date.now() + ACTIVITY_SETTLE_MS);
    const result = await worker.runActivityProjection({ store, now });
    events += result.events;
    filed += result.filed;
    if (result.events === 0) return { events, filed };
  }
}

async function sweepSignals(): Promise<Record<string, unknown>> {
  const errors: unknown[] = [];
  const result = await worker.runSignalsSweep({
    store: worker.createSignalsStore(database),
    now: new Date(),
    onError: (error) => errors.push(error),
  });
  for (const error of errors) console.error(error);
  if (result.failed > 0) process.exitCode = 1;
  return { ...result };
}

async function growthRollup(): Promise<Record<string, unknown>> {
  const { createGrowthRollupStore } = await workerModule<GrowthStoreModule>(
    'common/database/growth-rollup-store.ts',
  );
  const { runGrowthRollup } = await workerModule<GrowthModule>('jobs/growth-rollup.ts');
  const result = await runGrowthRollup({
    store: createGrowthRollupStore(database),
    mailer: null,
    alertEmails: [],
    composeReport: () => {
      throw new Error('the e2e growth run sends no report');
    },
  });
  return { ...result };
}

const RUN: Readonly<Record<Job, () => Promise<Record<string, unknown>>>> = {
  'project-activity': projectActivity,
  'sweep-signals': sweepSignals,
  'growth-rollup': growthRollup,
};

try {
  const report = await RUN[job as Job]();
  // stdout is the contract: the caller parses exactly one JSON line.
  process.stdout.write(`${JSON.stringify({ job, ...report })}\n`);
} finally {
  await database.end();
}
