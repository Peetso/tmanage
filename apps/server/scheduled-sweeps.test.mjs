import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RECONCILE_INTERVAL_MS,
  SWEEP_INTERVAL_MS,
  apiReconcileJobs,
  apiSweepJobs,
  createSweepScheduler,
  lockedPass,
  reconcileIntervalMs,
  startBudgetBurn,
  startRetainerRoll,
  startChannelPosts,
  startWebhookDeliveries,
  storageRootJob,
  sweepIntervalMs,
  sweepsEnabled,
  workerSweepJobs,
} from './scheduled-sweeps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function fakeTimers() {
  const timers = {
    callback: undefined,
    intervalMs: undefined,
    cleared: false,
    setInterval(callback, intervalMs) {
      timers.callback = callback;
      timers.intervalMs = intervalMs;
      return { unref() {} };
    },
    clearInterval() {
      timers.cleared = true;
    },
  };
  return timers;
}

function fakeWorker(calls, { expired = 0, reopened = 0, reminded = 0 } = {}) {
  return {
    createInvitationSweepStore: (database) => ({ database, kind: 'invitations' }),
    sweepOverdueInvitations: async (store) => {
      calls.push(store);
      return { expired };
    },
    createRequestDeferSweepStore: (database) => ({ database, kind: 'deferred' }),
    sweepDeferredRequests: async (store) => {
      calls.push(store);
      return { reopened, reminded };
    },
    createDueSoonSweepStore: (database) => ({ database, kind: 'due-soon' }),
    sweepDueSoon: async (store) => {
      calls.push(store);
      return { rules: 0, fired: 0 };
    },
    createGettingStartedNudgeStore: (database) => ({ database, kind: 'getting-started' }),
    sweepGettingStartedNudges: async (store) => {
      calls.push(store);
      return { candidates: 0, sent: 0 };
    },
    createStorageRootCheckStore: (database) => ({ database, kind: 'storage-root' }),
    sweepStorageRootCheck: async (store) => {
      calls.push(store);
      return { checked: 0, announced: 0 };
    },
    // ---- platform-admin v2 · PA-05 ----
    createSupportSessionSweepStore: (database) => ({ database, kind: 'support-sessions' }),
    sweepSupportSessions: async (store) => {
      calls.push(store);
      return { ended: 0, offboarded: 0, restored: 0 };
    },
    runContentPurge: async (database) => {
      calls.push({ database, kind: 'purge' });
      return { deleted: 0, blocked: 0, tables: [], hooks: [] };
    },
  };
}

test('sweeps are on by default and only an explicit off value turns them off', () => {
  assert.equal(sweepsEnabled({}), true);
  assert.equal(sweepsEnabled({ SWEEPS_INPROCESS: '1' }), true);
  for (const off of ['0', 'false', 'OFF', ' no ']) {
    assert.equal(sweepsEnabled({ SWEEPS_INPROCESS: off }), false, off);
  }
});

test('the cadence is every minute unless a valid interval of at least 10 s is set', () => {
  assert.equal(SWEEP_INTERVAL_MS, 60_000);
  assert.equal(sweepIntervalMs({}), 60_000);
  assert.equal(sweepIntervalMs({ SWEEPS_INTERVAL_MS: '300000' }), 300_000);
  assert.equal(sweepIntervalMs({ SWEEPS_INTERVAL_MS: '500' }), 60_000);
  assert.equal(sweepIntervalMs({ SWEEPS_INTERVAL_MS: 'soon' }), 60_000);
});

test('every --sweep-* command the worker CLI offers has a job, bound to the one pool', async () => {
  const cli = readFileSync(join(HERE, '../worker/src/cli.ts'), 'utf8');
  const flags = [...cli.matchAll(/'--sweep-([a-z-]+)'/g)].map((match) => match[1]).sort();
  const calls = [];
  const database = { pool: true };
  const jobs = workerSweepJobs(fakeWorker(calls), database);
  assert.deepEqual(jobs.map((job) => job.name).sort(), flags);
  for (const job of jobs) await job.run();
  assert.deepEqual(
    calls.map((store) => store.kind),
    [
      'invitations',
      'deferred',
      'due-soon',
      'getting-started',
      'storage-root',
      'support-sessions',
      'purge',
    ],
  );
  assert.ok(calls.every((store) => store.database === database));
});

test('start runs a tick at once, schedules the rest, and logs only what moved', async () => {
  const lines = [];
  const timers = fakeTimers();
  const calls = [];
  const scheduler = createSweepScheduler({
    jobs: workerSweepJobs(fakeWorker(calls, { expired: 2 }), {}),
    intervalMs: 60_000,
    log: (line) => lines.push(line),
    timers,
  });
  scheduler.start();
  await scheduler.stop();
  assert.equal(timers.intervalMs, 60_000);
  assert.equal(timers.cleared, true);
  assert.equal(calls.length, 7);
  assert.match(
    lines[0],
    /scheduled sweeps on \(invitations, deferred-requests, due-soon, getting-started, storage-root, support-sessions, purge\), every 60000ms/,
  );
  assert.deepEqual(lines.slice(1), ['sweep invitations: expired 2 overdue invitation(s)']);
});

// LOGQUIET-a: a sweep whose named lock another process holds is skipped silently.
function fakeLock(heldElsewhere) {
  const asked = [];
  return {
    asked,
    async run(name, work) {
      asked.push(name);
      if (heldElsewhere.has(name)) return { ran: false };
      return { ran: true, result: await work() };
    },
  };
}

test('with a lock, each sweep runs under its own name and a held one is skipped silently', async () => {
  const lines = [];
  const ran = [];
  const job = (name) => ({
    name,
    run: async () => (ran.push(name), { moved: 1 }),
    describe: () => 'moved 1',
    changed: () => true,
  });
  const lock = fakeLock(new Set(['invitations']));
  const scheduler = createSweepScheduler({
    jobs: [job('invitations'), job('due-soon')],
    intervalMs: 60_000,
    log: (line) => lines.push(line),
    timers: fakeTimers(),
    lock,
  });
  assert.equal(await scheduler.runOnce(), true);
  assert.deepEqual(lock.asked, ['invitations', 'due-soon']);
  assert.deepEqual(ran, ['due-soon']);
  assert.deepEqual(lines, ['sweep due-soon: moved 1']);
});

test('lockedPass reports an idle pass while another process holds the loop lock', async () => {
  let calls = 0;
  const pass = async () => (calls++, { delivered: 4, failed: 0 });
  const idle = { delivered: 0, failed: 0 };
  assert.equal(lockedPass(undefined, 'webhooks', pass, idle), pass);
  assert.deepEqual(
    await lockedPass(fakeLock(new Set(['webhooks'])), 'webhooks', pass, idle)(),
    idle,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await lockedPass(fakeLock(new Set()), 'webhooks', pass, idle)(), {
    delivered: 4,
    failed: 0,
  });
});

test('a failing sweep is logged and does not stop the next one', async () => {
  const lines = [];
  let secondRan = false;
  const scheduler = createSweepScheduler({
    jobs: [
      {
        name: 'invitations',
        run: async () => {
          throw new Error('ER_TABLEACCESS_DENIED_ERROR');
        },
        describe: () => '',
        changed: () => true,
      },
      {
        name: 'deferred-requests',
        run: async () => {
          secondRan = true;
          return {};
        },
        describe: () => '',
        changed: () => false,
      },
    ],
    intervalMs: 60_000,
    log: (line) => lines.push(line),
    describeError: (error) => error.message,
    timers: fakeTimers(),
  });
  assert.equal(await scheduler.runOnce(), true);
  assert.equal(secondRan, true);
  assert.deepEqual(lines, ['sweep invitations failed: ER_TABLEACCESS_DENIED_ERROR']);
});

test('a tick that fires while one is still running is skipped, not stacked', async () => {
  let release;
  let runs = 0;
  const scheduler = createSweepScheduler({
    jobs: [
      {
        name: 'invitations',
        run: () => {
          runs += 1;
          return new Promise((done) => {
            release = () => done({ expired: 0 });
          });
        },
        describe: () => '',
        changed: () => false,
      },
    ],
    intervalMs: 60_000,
    log: () => {},
    timers: fakeTimers(),
  });
  const first = scheduler.runOnce();
  assert.equal(await scheduler.runOnce(), false);
  release();
  assert.equal(await first, true);
  assert.equal(runs, 1);
});

test('the Hostinger bundle copies the scheduler next to server.mjs', () => {
  const build = readFileSync(join(HERE, '../../deploy/hostinger/build.mjs'), 'utf8');
  assert.match(build, /'scheduled-sweeps\.mjs'/);
});

const SWEEPER = Symbol('sweeper');
const RECONCILER = Symbol('reconciler');

function fakeApi(sweepReport, reconcileReport, calls) {
  const providers = new Map([
    [SWEEPER, { sweep: async () => (calls.push('sweep'), sweepReport) }],
    [RECONCILER, { reconcile: async () => (calls.push('reconcile'), reconcileReport) }],
  ]);
  return {
    api: {
      UPLOAD_SESSION_SWEEPER: SWEEPER,
      USAGE_RECONCILER: RECONCILER,
      describeSweep: (report) => `released ${String(report.released)}`,
      describeReconciliation: (report) => `drifted ${String(report.drifted)}`,
    },
    app: { get: (token) => providers.get(token) },
  };
}

const QUIET_SWEEP = { released: 0, failed: 0, counterDrift: 0, reclaimed: 0 };
const QUIET_RECONCILE = { drifted: 0, failed: 0 };

test('reconcile runs hourly unless a valid interval of at least a minute is set', () => {
  assert.equal(RECONCILE_INTERVAL_MS, 3_600_000);
  assert.equal(reconcileIntervalMs({}), 3_600_000);
  assert.equal(reconcileIntervalMs({ RECONCILE_INTERVAL_MS: '7200000' }), 7_200_000);
  assert.equal(reconcileIntervalMs({ RECONCILE_INTERVAL_MS: '60000' }), 60_000);
  assert.equal(reconcileIntervalMs({ RECONCILE_INTERVAL_MS: '30000' }), 3_600_000);
  assert.equal(reconcileIntervalMs({ RECONCILE_INTERVAL_MS: 'hourly' }), 3_600_000);
});

test('the upload-session sweep and the reconcile pass resolve their providers from the app', async () => {
  const calls = [];
  const { api, app } = fakeApi(QUIET_SWEEP, QUIET_RECONCILE, calls);
  const [sweep] = apiSweepJobs(api, app);
  const [reconcile] = apiReconcileJobs(api, app);
  assert.equal(sweep.name, 'upload-sessions');
  assert.equal(reconcile.name, 'storage-reconcile');
  assert.equal(sweep.changed(await sweep.run()), false);
  assert.equal(reconcile.changed(await reconcile.run()), false);
  assert.deepEqual(calls, ['sweep', 'reconcile']);
  for (const field of ['released', 'failed', 'counterDrift', 'reclaimed']) {
    assert.equal(sweep.changed({ ...QUIET_SWEEP, [field]: 1 }), true, field);
  }
  for (const field of ['drifted', 'failed']) {
    assert.equal(reconcile.changed({ ...QUIET_RECONCILE, [field]: 1 }), true, field);
  }
});

test('the reconcile pass on its own scheduler logs only drift, with the API report line', async () => {
  const lines = [];
  const timers = fakeTimers();
  const { api, app } = fakeApi(QUIET_SWEEP, { drifted: 3, failed: 0 }, []);
  const scheduler = createSweepScheduler({
    jobs: apiReconcileJobs(api, app),
    intervalMs: reconcileIntervalMs({}),
    log: (line) => lines.push(line),
    timers,
  });
  scheduler.start();
  await scheduler.stop();
  assert.equal(timers.intervalMs, 3_600_000);
  assert.deepEqual(lines, [
    'scheduled sweeps on (storage-reconcile), every 3600000ms',
    'sweep storage-reconcile: drifted 3',
  ]);
});

test('a slow hourly reconcile is skipped, not stacked, and a failure is logged', async () => {
  let release;
  let runs = 0;
  const lines = [];
  const app = {
    get: () => ({
      reconcile: () => {
        runs += 1;
        return new Promise((done, fail) => {
          release = () => fail(new Error('ER_LOCK_WAIT_TIMEOUT'));
        });
      },
    }),
  };
  const scheduler = createSweepScheduler({
    jobs: apiReconcileJobs({ USAGE_RECONCILER: RECONCILER, describeReconciliation: String }, app),
    intervalMs: RECONCILE_INTERVAL_MS,
    log: (line) => lines.push(line),
    describeError: (error) => error.message,
    timers: fakeTimers(),
  });
  const first = scheduler.runOnce();
  assert.equal(await scheduler.runOnce(), false);
  release();
  assert.equal(await first, true);
  assert.equal(runs, 1);
  assert.deepEqual(lines, ['sweep storage-reconcile failed: ER_LOCK_WAIT_TIMEOUT']);
});

test('server.mjs runs both API passes in-process, behind the same SWEEPS_INPROCESS switch', () => {
  const server = readFileSync(join(HERE, 'server.mjs'), 'utf8');
  assert.match(server, /\.\.\.apiSweepJobs\(api, app\)/);
  assert.match(server, /jobs: apiReconcileJobs\(api, app\),\s+intervalMs: reconcileIntervalMs\(/);
  assert.match(
    server,
    /if \(sweepsEnabled\(process\.env\)\) stopSweeps = await startScheduledSweeps\(env, app\)/,
  );
  const exports = readFileSync(join(HERE, '../api/src/hostinger-exports.ts'), 'utf8');
  for (const name of [
    'UPLOAD_SESSION_SWEEPER',
    'USAGE_RECONCILER',
    'describeSweep',
    'describeReconciliation',
  ]) {
    assert.match(exports, new RegExp(String.raw`export \{[^}]*\b${name}\b`), name);
  }
});

test('the content purge runs on the first tick and then at most once an hour', async () => {
  const calls = [];
  const job = workerSweepJobs(fakeWorker(calls), {}).find((entry) => entry.name === 'purge');
  await job.run();
  const second = await job.run();
  assert.equal(calls.filter((call) => call.kind === 'purge').length, 1);
  assert.equal(second.skipped, true);
  assert.equal(job.changed(second), false);
});

test('webhook deliveries run the worker pass on its loop with env-built deps, and stop aborts it', async () => {
  const calls = [];
  let signal;
  const worker = {
    createWebhookDeliveryDeps: (database, env) => ({ database, host: env.API_PUBLIC_URL }),
    runWebhookDeliveryPass: async (deps) => (calls.push(deps), { delivered: 1, failed: 0 }),
    runWebhookRetrySweepLoop: async (pass, s) => {
      signal = s;
      await pass();
    },
  };
  const stop = startWebhookDeliveries(
    worker,
    'pool',
    { API_PUBLIC_URL: 'https://a.test' },
    () => {},
  );
  await stop();
  assert.deepEqual(calls, [{ database: 'pool', host: 'https://a.test' }]);
  assert.equal(signal.aborted, true);
  assert.equal(
    startWebhookDeliveries({}, 'pool', {}, () => {}),
    null,
  );
});

test('R15-c: channel posts start on the worker loop and stop on abort; absent pass is null', async () => {
  const calls = [];
  let signal;
  const worker = {
    createChannelPostDeps: (database) => ({ database }),
    runChannelPostPass: async (deps) => (calls.push(deps), { delivered: 0, failed: 0 }),
    runChannelPostSweepLoop: async (pass, abortSignal) => {
      signal = abortSignal;
      await pass();
    },
  };
  const stop = startChannelPosts(worker, 'pool', {}, () => {});
  await stop();
  assert.deepEqual(calls, [{ database: 'pool' }]);
  assert.equal(signal.aborted, true);
  assert.equal(
    startChannelPosts({}, 'pool', {}, () => {}),
    null,
  );
});

test('R16-b: the budget burn sweep runs one pass on start and stops; absent sweep is null', async () => {
  const stores = [];
  const worker = {
    createBudgetBurnStore: (database) => ({ database }),
    sweepBudgetBurn: async (store) => (stores.push(store), { budgets: 1, alerts: 0, failed: 0 }),
  };
  const stop = startBudgetBurn(worker, 'pool', {}, () => {});
  await stop();
  assert.deepEqual(stores, [{ database: 'pool' }]);
  assert.equal(
    startBudgetBurn({}, 'pool', {}, () => {}),
    null,
  );
});

test('R17-d: the retainer roll runs one pass on start and stops; absent roll is null', async () => {
  const stores = [];
  const worker = {
    createRetainerStore: (database) => ({ database }),
    sweepRetainerPeriods: async (store) => {
      stores.push(store);
      return { closed: 0, refreshed: 1, failed: 0 };
    },
  };
  const stop = startRetainerRoll(worker, 'pool', {}, () => {});
  await stop();
  assert.deepEqual(stores, [{ database: 'pool' }]);
  assert.equal(
    startRetainerRoll({}, 'pool', {}, () => {}),
    null,
  );
});

test('R17-e: the recurrence spawner joins the minute tick only when the API exports it', async () => {
  const SPAWNER = Symbol('spawner');
  const { api, app } = fakeApi(QUIET_SWEEP, QUIET_RECONCILE, []);
  assert.equal(apiSweepJobs(api, app).length, 1);
  const report = { ran: true, spawned: 1, paused: 0, failed: 0, capped: 0 };
  const job = apiSweepJobs(
    { ...api, RECURRENCE_SPAWNER: SPAWNER, describeRecurrenceSweep: () => 'spawned 1' },
    { get: (token) => (token === SPAWNER ? { sweep: async () => report } : app.get(token)) },
  )[1];
  assert.equal(job.name, 'recurrence-spawner');
  assert.equal(job.changed(await job.run()), true);
  assert.equal(job.describe(report), 'spawned 1');
});

test('51-17: the storage-root check runs at most once an hour', async () => {
  let clock = 0;
  let runs = 0;
  const job = storageRootJob(
    async () => {
      runs += 1;
      return { checked: 1, announced: 1 };
    },
    () => clock,
  );
  assert.equal(job.name, 'storage-root');
  assert.equal(job.changed(await job.run()), true);
  clock = 59 * 60 * 1000;
  assert.equal(job.changed(await job.run()), false);
  clock = 61 * 60 * 1000;
  await job.run();
  assert.equal(runs, 2);
});
