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
// LOGQUIET-a: on top of that, every sweep takes a MariaDB named lock of its own name for the
// length of one pass (`createSweepLockDatabase` in the worker, `GET_LOCK(name, 0)`), so when two
// app processes run — a restart overlapping the old one — only one of them runs each sweep and
// the other skips that pass silently: half the load and no doubled log lines.
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
    {
      // 55-24 `--sweep-getting-started`: first-week nudges, at most one a day per member (the
      // notice's dedupe key carries the day, so a sweep every minute sends nothing twice).
      name: 'getting-started',
      run: () => worker.sweepGettingStartedNudges(worker.createGettingStartedNudgeStore(database)),
      describe: (result) => `getting-started: sent ${String(result.sent)} nudge(s)`,
      changed: (result) => result.sent > 0,
    },
    // 51-17 `--sweep-storage-root`: the weekly owner check of the company's storage root. Hourly,
    // not every tick; at most one announcement a week per connection either way (the store skips a
    // connection with an at-risk event in the last 7 days). Present when the worker offers it.
    ...(typeof worker.sweepStorageRootCheck === 'function'
      ? [
          storageRootJob(() =>
            worker.sweepStorageRootCheck(worker.createStorageRootCheckStore(database)),
          ),
        ]
      : []),
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
    // R17-e (53-09): the recurrence spawner. Runs every tick, but the pass returns at once unless
    // 15 minutes passed since its last run. Idempotent across restarts: each occurrence is claimed
    // by a unique-keyed instance row before its item is created. Present only when the API exports it.
    ...(api.RECURRENCE_SPAWNER
      ? [
          {
            name: 'recurrence-spawner',
            run: () => app.get(api.RECURRENCE_SPAWNER).sweep(),
            describe: (result) => api.describeRecurrenceSweep(result),
            changed: (result) =>
              result.spawned > 0 || result.paused > 0 || result.failed > 0 || result.capped > 0,
          },
        ]
      : []),
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
export function startWebhookDeliveries(
  worker,
  database,
  env,
  log,
  describeError = String,
  lock = undefined,
) {
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
    lockedPass(lock, 'webhooks', () => worker.runWebhookDeliveryPass(deps), {
      delivered: 0,
      failed: 0,
    }),
    controller.signal,
    (error) => log(`sweep webhooks failed: ${describeError(error)}`),
  );
  log('webhook deliveries on (every 10000ms)');
  // R15-c: Slack / Teams channel posts ride on the same start and stop (server.mjs is unchanged).
  const stopChannelPosts = startChannelPosts(worker, database, env, log, describeError, lock);
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
export function startChannelPosts(
  worker,
  database,
  env,
  log,
  describeError = String,
  lock = undefined,
) {
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
    lockedPass(lock, 'channel-posts', () => worker.runChannelPostPass(deps), undefined),
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
export function startBudgetBurn(
  worker,
  database,
  env,
  log,
  describeError = String,
  lock = undefined,
) {
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
    lock,
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
export function startRetainerRoll(
  worker,
  database,
  env,
  log,
  describeError = String,
  lock = undefined,
) {
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
    lock,
  });
  scheduler.start();
  return () => scheduler.stop();
}

/** 62-A2 — the activity projector's cadence: every minute (as the worker's own loop). */
export const ACTIVITY_PROJECTOR_INTERVAL_MS = 60_000;

/**
 * 62-A2 — the activity projector, beside {@link startRetainerRoll} and in the same style: its own
 * scheduler (one pass now), paced by the job itself (at most 2 000 audit events a run, back-filling
 * from the start). Idempotent across instances: entries are `INSERT IGNORE` on the source audit id
 * and the cursor moves in the same transaction, and the job runs under the `activity-projector`
 * named lock the standalone worker's loop takes too. Returns `stop`, or `null` when the worker
 * module does not offer the projector.
 */
export function startActivityProjector(
  worker,
  database,
  env,
  log,
  describeError = String,
  lock = undefined,
) {
  if (
    typeof worker.runActivityProjection !== 'function' ||
    typeof worker.createActivityProjectorStore !== 'function'
  ) {
    return null;
  }
  const scheduler = createSweepScheduler({
    jobs: [
      {
        name: 'activity-projector',
        run: () =>
          worker.runActivityProjection({
            store: worker.createActivityProjectorStore(database),
            now: new Date(),
          }),
        describe: (result) =>
          `activity: ${String(result.organizations)} organization(s), ${String(result.events)} event(s), ${String(result.filed)} filed`,
        changed: (result) => result.filed > 0,
      },
    ],
    intervalMs: ACTIVITY_PROJECTOR_INTERVAL_MS,
    log,
    describeError,
    lock,
  });
  scheduler.start();
  return () => scheduler.stop();
}

/** 62-27 — the signals sweep's cadence: hourly. */
export const SIGNALS_SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * 62-27 — the signals sweeper (eight pure rules, no model call), beside
 * {@link startActivityProjector}: its own hourly scheduler (one pass now), only over organizations
 * whose `business_briefing` flag is on. Idempotent across instances: a signal is `INSERT IGNORE` on
 * its (rule, subject, day) key, and the job runs under the `signals-sweeper` named lock the
 * standalone worker's loop takes too. Returns `stop`, or `null` when the worker module does not
 * offer the sweep.
 */
export function startSignalsSweep(
  worker,
  database,
  env,
  log,
  describeError = String,
  lock = undefined,
) {
  if (
    typeof worker.runSignalsSweep !== 'function' ||
    typeof worker.createSignalsStore !== 'function'
  ) {
    return null;
  }
  const scheduler = createSweepScheduler({
    jobs: [
      {
        name: 'signals-sweeper',
        run: () =>
          worker.runSignalsSweep({
            // The flag chain reads its server locks (`TMANAGE_FLAG_LOCKS`) from process.env.
            store: worker.createSignalsStore(database),
            now: new Date(),
            onError: (error) =>
              log(`sweep signals-sweeper organization failed: ${describeError(error)}`),
          }),
        describe: (result) =>
          `signals: ${String(result.organizations)} organization(s), ${String(result.filed)} filed, ${String(result.failed)} failed`,
        changed: (result) => result.filed > 0 || result.failed > 0,
      },
    ],
    intervalMs: SIGNALS_SWEEP_INTERVAL_MS,
    log,
    describeError,
    lock,
  });
  scheduler.start();
  return () => scheduler.stop();
}

/** GROWTH-FIX — what the scheduled jobs mail through when this app runs no relay: nothing. */
export const NO_JOB_MAIL = Object.freeze({ alerts: null, notice: () => null });

/**
 * GROWTH-FIX — the worker's recurring jobs (`createScheduledJobs`, `apps/worker/src/jobs/
 * scheduled-jobs.ts`: growth rollups, finance facts, both chain checks, notification digests,
 * audit anchors, the two purges, key rotation, forgotten timers, the security detector), one
 * scheduler each at the job's own cadence (one pass now). Each pass runs under the named lock of
 * the job's name, the name the standalone worker's `runScheduledJobLoop` takes too (AS-4 / RT-3),
 * and a job with a schedule checks it inside the pass, against database state, so a second
 * process that gets the lock later finds the work done. `mail` is the in-process relay's mail
 * ({@link NO_JOB_MAIL} without one). Returns `stop`, or `null` when the worker module does not
 * offer the jobs.
 */
export function startScheduledJobs(
  worker,
  database,
  env,
  mail,
  log,
  describeError = String,
  lock = undefined,
) {
  if (typeof worker.createScheduledJobs !== 'function') return null;
  const schedulers = worker.createScheduledJobs(database, env, mail ?? NO_JOB_MAIL).map((job) =>
    createSweepScheduler({
      jobs: [
        {
          name: job.name,
          run: () => job.run(),
          describe: (line) => line,
          changed: (line) => line !== null,
        },
      ],
      intervalMs: job.intervalMs,
      log,
      describeError,
      lock,
    }),
  );
  for (const scheduler of schedulers) scheduler.start();
  return async () => {
    await Promise.all(schedulers.map((scheduler) => scheduler.stop()));
  };
}

/**
 * GROWTH-FIX fitness map (ENGINEERING-STANDARD PR-1 / PR-3): every job loop the standalone worker
 * starts in `apps/worker/src/main.ts`, against the call that runs the same work in this app. The
 * unit suite parses main.ts and fails on a loop missing here or from {@link STANDALONE_ONLY_LOOPS},
 * and on a value this app's sources never call.
 */
export const WORKER_LOOPS_IN_APP = Object.freeze({
  runOutboxLoop: 'runOutboxBatch',
  runQueueLoop: 'runQueueBatch',
  runSupportSessionSweepLoop: 'worker.sweepSupportSessions',
  runExportJobsLoop: 'worker.runExportJobs',
  runActivityProjectorLoop: 'startActivityProjector',
  runSignalsSweepLoop: 'startSignalsSweep',
  runWebhookRetrySweepLoop: 'startWebhookDeliveries',
  runScheduledJobLoop: 'startScheduledJobs',
});

/** The worker loops this app deliberately does not run, each with the reason. */
export const STANDALONE_ONLY_LOOPS = Object.freeze({
  runPersonMailLoop:
    'tips are signed by the member’s assigned person through the sender-resolving mail stack (EMAILBUILD, 0371), which this app does not build; run here they would go out under the wrong sender',
  runMailDrainLoop:
    'drains mail_queue, which only the standalone worker fills (MAIL_QUEUE=on); this app sends through its own transport and never enqueues',
});

/**
 * A small interval scheduler over a list of jobs. Each tick runs every job in order; one job's
 * failure is logged and does not stop the others. A tick that fires while the previous one is
 * still running is skipped. Quiet ticks log nothing; a tick that moved rows logs one line per job
 * that did, and every failure logs. With a `lock` (LOGQUIET-a) each job runs under its own named
 * lock, and a job whose lock another process holds is skipped silently for that tick.
 */
export function createSweepScheduler({
  jobs,
  intervalMs,
  log,
  describeError = (error) => String(error),
  timers = { setInterval, clearInterval },
  lock = undefined,
}) {
  let running;
  let timer;

  async function tick() {
    for (const job of jobs) {
      try {
        const outcome = lock ? await lock.run(job.name, () => job.run()) : await ran(job.run());
        if (!outcome.ran) continue;
        const result = outcome.result;
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

async function ran(pending) {
  return { ran: true, result: await pending };
}

/**
 * LOGQUIET-a — a loop's pass under the sweep's named lock: without a lock the pass itself; with
 * one, `idle` (what an empty pass reports) when another process holds the lock.
 */
export function lockedPass(lock, name, pass, idle) {
  if (!lock) return pass;
  return async () => {
    const outcome = await lock.run(name, pass);
    return outcome.ran ? outcome.result : idle;
  };
}

/** The hourly content purge as a minute-tick job: a skipped tick reports nothing moved. */
export const PURGE_EVERY_MS = 60 * 60 * 1000;

/** 51-17. The storage-root check, at most once an hour (it reads every live connection). */
export function storageRootJob(run, now = () => Date.now()) {
  let last = Number.NEGATIVE_INFINITY;
  return {
    name: 'storage-root',
    run: async () => {
      if (now() - last < PURGE_EVERY_MS) return { checked: 0, announced: 0, skipped: true };
      last = now();
      return run();
    },
    describe: (result) =>
      `storage-root: checked ${String(result.checked)}, announced ${String(result.announced)}`,
    changed: (result) => result.announced > 0,
  };
}

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
