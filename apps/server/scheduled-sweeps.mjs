// The in-process scheduled sweeps — what the Hostinger cron entries for the worker's `--sweep-*`
// commands used to do, run on a timer inside the one Node app instead.
//
// The worker CLI offers three sweeps (`apps/worker/src/cli.ts`): `--sweep-invitations` (overdue
// `pending` invitations to `expired`), `--sweep-deferred-requests` (due `deferred` client
// requests back to `triage`, with the deferrer's reminder) and `--sweep-due-soon` (the "due in N
// days" automation rules). All run here, one after the other, on
// the delivery tick's cadence — every minute, the shared-plan cron granularity the runbook's §4a
// chain was written for (`docs/runbooks/hostinger-shared-hosting.md`).
//
// Two app instances cannot double-run a sweep's effect, and no lock is needed for that: both are
// idempotent in the database. The invitation sweep is one `UPDATE … WHERE status = 'pending'`; a
// second instance's statement finds nothing left to move. The defer sweep locks its due rows
// (`FOR UPDATE`) and reopens each with a version-conditioned `UPDATE … AND state = 'deferred'`,
// skipping any row that did not move, and its reminder notice carries a per-version dedupe key —
// so a racing instance waits on the lock and then reopens and reminds nothing. Inside one process
// a run that is still going when the next tick fires is skipped, never stacked.
//
// The API's two job passes run here too, so the one app needs no cron at all: `sweep:once`
// (expired upload reservations, `apps/api/src/sweep.ts`) joins the minute tick after the worker's
// sweeps, and `reconcile:once` (storage usage counters against the ledger,
// `apps/api/src/reconcile.ts`) gets a scheduler of its own, hourly. Both are resolved from the
// in-process API application, so they run on the same providers, pool and credential the
// standalone `--once` processes compose. Both are idempotent across instances for the same
// reason as the worker's: the sweeper releases a row only through a state-conditioned claim
// (a second pass counts it `skipped`), and the reconciler corrects each counter under that
// counter's own row lock, so a racing pass finds no drift left to correct.
//
// On by default; `SWEEPS_INPROCESS=0` (or false/off/no) turns all of it off, e.g. while an
// external cron still runs the same commands. `SWEEPS_INTERVAL_MS` tunes the minute cadence
// (never below 10 s), `RECONCILE_INTERVAL_MS` the hourly one (never below the minute).

/** The delivery tick's cadence: every minute. */
export const SWEEP_INTERVAL_MS = 60_000;

/** The shortest cadence accepted from `SWEEPS_INTERVAL_MS` — a sweep is not a busy loop. */
export const SWEEP_INTERVAL_MIN_MS = 10_000;

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/** Whether the sweeps run in this process: on unless `SWEEPS_INPROCESS` says off. */
export function sweepsEnabled(env) {
  const value = env['SWEEPS_INPROCESS'];
  if (value === undefined) return true;
  return !OFF_VALUES.has(String(value).trim().toLowerCase());
}

/** The cadence: `SWEEPS_INTERVAL_MS` when it is a whole number ≥ 10 s, the minute otherwise. */
export function sweepIntervalMs(env) {
  const raw = env['SWEEPS_INTERVAL_MS'];
  if (raw === undefined || String(raw).trim() === '') return SWEEP_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < SWEEP_INTERVAL_MIN_MS) return SWEEP_INTERVAL_MS;
  return value;
}

/** The reconcile pass's cadence: hourly, as the runbook's second cron entry was. */
export const RECONCILE_INTERVAL_MS = 3_600_000;

/** The reconcile pass is a full scan over every organization's counter: never every few seconds. */
export const RECONCILE_INTERVAL_MIN_MS = SWEEP_INTERVAL_MS;

/** The reconcile cadence: `RECONCILE_INTERVAL_MS` when a whole number of at least 1 min, else hourly. */
export function reconcileIntervalMs(env) {
  const raw = env['RECONCILE_INTERVAL_MS'];
  if (raw === undefined || String(raw).trim() === '') return RECONCILE_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < RECONCILE_INTERVAL_MIN_MS) return RECONCILE_INTERVAL_MS;
  return value;
}

/**
 * The worker's sweeps as scheduler jobs, bound to one worker pool. `worker` is the
 * `@tmanage/worker` module (or a fake of it); one job per `--sweep-*` CLI command.
 */
export function workerSweepJobs(worker, database, env = process.env) {
  return [
    {
      name: 'invitations',
      run: () => worker.sweepOverdueInvitations(worker.createInvitationSweepStore(database)),
      describe: (result) => `expired ${String(result.expired)} overdue invitation(s)`,
      changed: (result) => result.expired > 0,
    },
    {
      name: 'deferred-requests',
      run: () => worker.sweepDeferredRequests(worker.createRequestDeferSweepStore(database)),
      describe: (result) =>
        `reopened ${String(result.reopened)} deferred request(s), reminded ${String(result.reminded)}`,
      changed: (result) => result.reopened > 0 || result.reminded > 0,
    },
    {
      // C1 `--sweep-due-soon`: idempotent through its `INSERT IGNORE` claim row per item, rule and day.
      name: 'due-soon',
      run: () => worker.sweepDueSoon(worker.createDueSoonSweepStore(database)),
      describe: (result) =>
        `due-soon: ${String(result.rules)} rule(s), fired for ${String(result.fired)} work item(s)`,
      changed: (result) => result.fired > 0,
    },
    // ---- platform-admin v2 · PA-05 ----
    {
      // `--sweep-support-sessions`: ends expired Support sessions and takes their hidden
      // memberships away; idempotent, each session is claimed with `ended_at is null`.
      name: 'support-sessions',
      run: () => worker.sweepSupportSessions(worker.createSupportSessionSweepStore(database)),
      describe: (result) => `support sessions: ended ${String(result.ended)} expired session(s)`,
      changed: (result) => result.ended > 0,
    },
    // ---- platform-admin v2 · PA-09 ----
    // The Platform admin CSV exports (`--run-exports`): queued jobs written to the object store's
    // private zone, expired files removed. Idempotent across instances: a job is claimed with
    // `FOR UPDATE SKIP LOCKED` and finished only `where status = 'running'`. Present only when the
    // worker module offers it.
    ...(typeof worker.runExportJobs === 'function'
      ? [
          {
            name: 'exports',
            run: () =>
              worker.runExportJobs(
                worker.createExportJobStore(database),
                worker.exportWriterFor({
                  STORAGE_DRIVER: env['STORAGE_DRIVER'] ?? 's3',
                  STORAGE_LOCAL_ROOT: env['STORAGE_LOCAL_ROOT'],
                  STORAGE_FILESYSTEM_ROOT: env['STORAGE_FILESYSTEM_ROOT'] ?? '.local/storage',
                }),
              ),
            describe: (result) =>
              `exports: wrote ${String(result.written)}, failed ${String(result.failed)}, removed ${String(result.removed)}`,
            changed: (result) => result.written + result.failed + result.removed > 0,
          },
        ]
      : []),
  ];
}

/**
 * The API's `sweep:once` as a minute-tick job. `api` carries `UPLOAD_SESSION_SWEEPER` and
 * `describeSweep` (`@tmanage/api/hostinger`); `app` is the in-process Nest application.
 */
export function apiSweepJobs(api, app) {
  return [
    {
      name: 'upload-sessions',
      run: () => app.get(api.UPLOAD_SESSION_SWEEPER).sweep(),
      describe: (result) => api.describeSweep(result),
      changed: (result) =>
        result.released > 0 || result.failed > 0 || result.counterDrift > 0 || result.reclaimed > 0,
    },
  ];
}

/**
 * The API's `reconcile:once` as the job of its own hourly scheduler. `api` carries
 * `USAGE_RECONCILER` and `describeReconciliation`; `app` is the in-process Nest application.
 */
export function apiReconcileJobs(api, app) {
  return [
    {
      name: 'storage-reconcile',
      run: () => app.get(api.USAGE_RECONCILER).reconcile(),
      describe: (result) => api.describeReconciliation(result),
      changed: (result) => result.drifted > 0 || result.failed > 0,
    },
  ];
}

/**
 * A small interval scheduler over a list of jobs. Each tick runs every job in order; one job's
 * failure is logged and does not stop the others. A tick that fires while the previous one is
 * still running is skipped. Quiet ticks log nothing; a tick that moved rows logs one line per job
 * that did, and every failure logs.
 */
export function createSweepScheduler({
  jobs,
  intervalMs,
  log,
  describeError = (error) => String(error),
  timers = { setInterval, clearInterval },
}) {
  let running;
  let timer;

  async function tick() {
    for (const job of jobs) {
      try {
        const result = await job.run();
        if (job.changed(result)) log(`sweep ${job.name}: ${job.describe(result)}`);
      } catch (error) {
        log(`sweep ${job.name} failed: ${describeError(error)}`);
      }
    }
  }

  /** Run one tick now. Resolves `false` when a tick was already running and this one skipped. */
  async function runOnce() {
    if (running) return false;
    running = tick();
    try {
      await running;
    } finally {
      running = undefined;
    }
    return true;
  }

  return {
    runOnce,
    start() {
      if (timer !== undefined) return;
      timer = timers.setInterval(() => void runOnce(), intervalMs);
      timer?.unref?.();
      log(
        `scheduled sweeps on (${jobs.map((job) => job.name).join(', ')}), every ${String(intervalMs)}ms`,
      );
      void runOnce();
    },
    /** Stop the timer and wait for a tick in flight, so the pool can be closed after. */
    async stop() {
      if (timer !== undefined) timers.clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
