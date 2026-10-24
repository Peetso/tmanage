import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SWEEP_INTERVAL_MS,
  createSweepScheduler,
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
    ['invitations', 'deferred'],
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
  assert.equal(calls.length, 2);
  assert.match(lines[0], /scheduled sweeps on \(invitations, deferred-requests\), every 60000ms/);
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
