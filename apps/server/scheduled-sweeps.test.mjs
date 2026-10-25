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
  reconcileIntervalMs,
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
    ['invitations', 'deferred', 'due-soon'],
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
  assert.equal(calls.length, 3);
  assert.match(
    lines[0],
    /scheduled sweeps on \(invitations, deferred-requests, due-soon\), every 60000ms/,
  );
  assert.deepEqual(lines.slice(1), ['sweep invitations: expired 2 overdue invitation(s)']);
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
