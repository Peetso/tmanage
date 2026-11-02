/* global AbortController -- Node 18+ global; the server eslint env predates it */
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
    // ---- platform-admin v2 · PA-03 (scheduled by the verifier) ----
    // `--sweep-purge`: soft-deleted content (and organizations) past `purge_after`. Hourly, not
    // every tick: the first tick runs it, then at most once an hour. Idempotent across instances —
    // each row is deleted only while still past its window, in tenant-scoped batches.
    ...(typeof worker.runContentPurge === 'function'
      ? [purgeJob(() => worker.runContentPurge(database))]
      : []),
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
    // R4 follow-up: preview derivatives whose source file is gone, hourly. Idempotent across
    // instances: a row is removed by a delete that must take it, and only that delete gives its
    // counted bytes back. Present only when the API bundle exports it.
    ...(api.PREVIEW_ORPHAN_SWEEPER
      ? [
          {
            name: 'preview-orphans',
            run: () => app.get(api.PREVIEW_ORPHAN_SWEEPER).sweep(),
            describe: (result) => api.describeOrphanSweep(result),
            changed: (result) => result.removed > 0 || result.failed > 0,
          },
        ]
      : []),
  ];
}

/**
 * R14-a — the outbound webhook delivery loop (R13-s2), beside the minute tick rather than in it:
 * the worker's own `runWebhookRetrySweepLoop` (one pass now, then every 10 s) so a staged attempt
 * goes out within seconds and a 10 s receiver timeout never delays the other sweeps. The outbox
 * consumer stages attempts in the relay; this is the only sender. Idempotent across instances: an
 * attempt is sent only after its state-conditioned claim. Returns `stop` (abort, then wait for the
 * pass in flight), or `null` when the worker module does not offer the delivery pass.
 */
export function startWebhookDeliveries(worker, database, env, log, describeError = String) {
  if (
    typeof worker.runWebhookDeliveryPass !== 'function' ||
    typeof worker.runWebhookRetrySweepLoop !== 'function' ||
    typeof worker.createWebhookDeliveryDeps !== 'function'
  ) {
    return null;
  }
  const deps = worker.createWebhookDeliveryDeps(database, env);
  const controller = new AbortController();
  const loop = worker.runWebhookRetrySweepLoop(
    () => worker.runWebhookDeliveryPass(deps),
    controller.signal,
    (error) => log(`sweep webhooks failed: ${describeError(error)}`),
  );
  log('webhook deliveries on (every 10000ms)');
  // R15-c: Slack / Teams channel posts ride on the same start and stop (server.mjs is unchanged).
  const stopChannelPosts = startChannelPosts(worker, database, env, log, describeError);
  return async () => {
    controller.abort();
    await Promise.all([loop, stopChannelPosts?.()]);
  };
}

/**
 * R15-c — the Slack / Teams channel post loop (54-05 / 54-06 Phase 0), the same shape as
 * {@link startWebhookDeliveries}: the worker's `runChannelPostSweepLoop` (one pass now, then every
 * 10 s). The outbox consumer stages posts in the relay; this is the only sender, and a post goes out
 * only after its state-conditioned claim. Returns `stop`, or `null` when the worker module does not
 * offer the channel pass.
 */
export function startChannelPosts(worker, database, env, log, describeError = String) {
  if (
    typeof worker.runChannelPostPass !== 'function' ||
    typeof worker.runChannelPostSweepLoop !== 'function' ||
    typeof worker.createChannelPostDeps !== 'function'
  ) {
    return null;
  }
  const deps = worker.createChannelPostDeps(database, env);
  const controller = new AbortController();
  const loop = worker.runChannelPostSweepLoop(
    () => worker.runChannelPostPass(deps),
    controller.signal,
    (error) => log(`sweep channel posts failed: ${describeError(error)}`),
  );
  log('channel posts on (every 10000ms)');
  return async () => {
    controller.abort();
    await loop;
  };
}

/** R16-b — the budget burn sweep's cadence: every 15 minutes (52-05 "never lags more than 15 min"). */
export const BUDGET_BURN_INTERVAL_MS = 15 * 60_000;

/**
 * R16-b (52-05) — the budget burn sweep, beside {@link startChannelPosts} and in the same style: its
 * own scheduler on a 15-minute cadence (one pass now), so a pass over 200 budgets never delays the
 * minute tick. Idempotent across instances: each budget is refreshed under its row lock and an alert
 * is raised only above the stored `last_alert_bp`. Returns `stop`, or `null` when the worker module
 * does not offer the sweep.
 */
export function startBudgetBurn(worker, database, env, log, describeError = String) {
  if (
    typeof worker.sweepBudgetBurn !== 'function' ||
    typeof worker.createBudgetBurnStore !== 'function'
  ) {
    return null;
  }
  const scheduler = createSweepScheduler({
    jobs: [
      {
        name: 'budget-burn',
        run: () =>
          worker.sweepBudgetBurn(worker.createBudgetBurnStore(database), (error) =>
            log(`sweep budget-burn budget failed: ${describeError(error)}`),
          ),
        describe: (result) =>
          `budget burn: ${String(result.budgets)} budget(s), ${String(result.alerts)} alert(s), ${String(result.failed)} failed`,
        changed: (result) => result.alerts > 0 || result.failed > 0,
      },
    ],
    intervalMs: BUDGET_BURN_INTERVAL_MS,
    log,
    describeError,
  });
  scheduler.start();
  return () => scheduler.stop();
}

/** R17-d — the retainer period roll's cadence: hourly (52-06 rolls on the org's own midnight). */
export const RETAINER_ROLL_INTERVAL_MS = 60 * 60_000;

/**
 * R17-d (52-06) — the retainer period roll, beside {@link startBudgetBurn} and in the same style:
 * its own hourly scheduler (one pass now). Idempotent across instances: each period is closed under
 * the retainer row lock and the next is opened against the `(organization_id, retainer_id,
 * period_start)` key, so a second pass skips. Returns `stop`, or `null` when the worker module does
 * not offer the roll.
 */
export function startRetainerRoll(worker, database, env, log, describeError = String) {
  if (
    typeof worker.sweepRetainerPeriods !== 'function' ||
    typeof worker.createRetainerStore !== 'function'
  ) {
    return null;
  }
  const scheduler = createSweepScheduler({
    jobs: [
      {
        name: 'retainer-roll',
        run: () =>
          worker.sweepRetainerPeriods(worker.createRetainerStore(database), (error) =>
            log(`sweep retainer-roll period failed: ${describeError(error)}`),
          ),
        describe: (result) =>
          `retainer roll: ${String(result.closed)} closed, ${String(result.refreshed)} refreshed, ${String(result.failed)} failed`,
        changed: (result) => result.closed > 0 || result.failed > 0,
      },
    ],
    intervalMs: RETAINER_ROLL_INTERVAL_MS,
    log,
    describeError,
  });
  scheduler.start();
  return () => scheduler.stop();
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

/** The hourly content purge as a minute-tick job: a skipped tick reports nothing moved. */
export const PURGE_EVERY_MS = 60 * 60 * 1000;

function purgeJob(run, now = () => Date.now()) {
  let last = Number.NEGATIVE_INFINITY;
  return {
    name: 'purge',
    run: async () => {
      if (now() - last < PURGE_EVERY_MS) return { deleted: 0, blocked: 0, skipped: true };
      last = now();
      return run();
    },
    describe: (result) =>
      `purge: deleted ${String(result.deleted)} row(s), ${String(result.blocked)} still referenced`,
    changed: (result) => result.deleted > 0,
  };
}
