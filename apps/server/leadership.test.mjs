// DC-3 / RT-3 — two copies of the app, one leader lease: only the leader runs a sweep pass, the
// follower serves only, and the follower takes over when the leader stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLeaderLease } from '@tmanage/worker';

import { createLeadership, describeLeaseTick, leaderGatedLock } from './leadership.mjs';
import { createSweepScheduler } from './scheduled-sweeps.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The row's semantics (`WHERE holder = me OR expires_at < now`) in memory. */
function memoryStore() {
  const state = { row: null, fail: false };
  return {
    state,
    async claim(_name, holder, now, expiresAt) {
      if (state.fail) throw new Error('ECONNRESET');
      const row = state.row;
      if (row === null || row.holder === holder || row.expiresAt.getTime() < now.getTime()) {
        const generation =
          row === null ? 1 : row.holder === holder ? row.generation : row.generation + 1;
        state.row = { holder, generation, expiresAt };
        return { won: true, generation };
      }
      return { won: false, row };
    },
    async release(_name, holder, now) {
      if (state.row?.holder === holder) {
        state.row = { ...state.row, expiresAt: new Date(now.getTime() - 1) };
      }
    },
    async end() {},
  };
}

const NEVER = { setTimeout: () => undefined, clearTimeout: () => undefined };
const NO_INTERVAL = { setInterval: () => undefined, clearInterval: () => undefined };

/** One copy of the app: its lease, its leadership loop and one minute-sweep scheduler. */
function appCopy(store, clock, holder, runs, logs) {
  const lease = createLeaderLease({
    store,
    holder,
    ttlMs: 30_000,
    renewEveryMs: 10_000,
    now: () => new Date(clock.wall),
    monotonic: () => clock.mono,
  });
  let started = 0;
  const leadership = createLeadership({
    lease,
    intervalMs: 10_000,
    log: (line) => logs.push(`${holder}: ${line}`),
    timers: NEVER,
    onLeader: async () => {
      started += 1;
    },
  });
  // The named-lock runner itself always grants (one process per lock name here).
  const namedLock = {
    run: async (_name, work) => ({ ran: true, result: await work() }),
    end: async () => {},
  };
  const scheduler = createSweepScheduler({
    jobs: [
      {
        name: 'invitations',
        run: async () => {
          runs.push(holder);
          return 1;
        },
        changed: () => false,
        describe: () => '',
      },
    ],
    intervalMs: 60_000,
    log: () => undefined,
    timers: NO_INTERVAL,
    lock: leaderGatedLock(namedLock, () => leadership.holds()),
  });
  return { lease, leadership, scheduler, started: () => started };
}

function advance(clock, ms) {
  clock.wall += ms;
  clock.mono += ms;
}

test('RT-3: two copies, one lease: only the leader runs a pass; duties start once, on the leader', async () => {
  const store = memoryStore();
  const clock = { wall: Date.UTC(2026, 10, 20, 12), mono: 1_000 };
  const runs = [];
  const logs = [];
  const a = appCopy(store, clock, 'aaaa', runs, logs);
  const b = appCopy(store, clock, 'bbbb', runs, logs);
  await a.leadership.start();
  await b.leadership.start();
  await a.leadership.dutiesStarted();
  for (let minute = 0; minute < 3; minute += 1) {
    await a.scheduler.runOnce();
    await b.scheduler.runOnce();
    advance(clock, 10_000);
    await a.leadership.tick();
    await b.leadership.tick();
  }
  assert.deepEqual(runs, ['aaaa', 'aaaa', 'aaaa']);
  assert.equal(a.started(), 1);
  assert.equal(b.started(), 0);
  assert.ok(
    logs.includes(
      'aaaa: leader lease: this copy (aaaa) leads, generation 1; relay, sweeps and jobs run here',
    ),
  );
  assert.ok(
    logs.includes('bbbb: leader lease: copy aaaa leads; this copy (bbbb) serves web traffic only'),
  );
});

test('RT-3: the leader stops cleanly → the follower leads at its next retry and runs the pass', async () => {
  const store = memoryStore();
  const clock = { wall: Date.UTC(2026, 10, 20, 12), mono: 1_000 };
  const runs = [];
  const logs = [];
  const a = appCopy(store, clock, 'aaaa', runs, logs);
  const b = appCopy(store, clock, 'bbbb', runs, logs);
  await a.leadership.start();
  await b.leadership.start();
  await a.leadership.stop();
  assert.equal(a.leadership.holds(), false);
  advance(clock, 10_000);
  await b.leadership.tick();
  await b.leadership.dutiesStarted();
  await a.scheduler.runOnce();
  await b.scheduler.runOnce();
  assert.deepEqual(runs, ['bbbb']);
  assert.equal(b.started(), 1);
  assert.equal(store.state.row.generation, 2);
});

test('RT-3: the leader dies (no release) → the follower takes over only after the lease expired', async () => {
  const store = memoryStore();
  const clock = { wall: Date.UTC(2026, 10, 20, 12), mono: 1_000 };
  const runs = [];
  const logs = [];
  const a = appCopy(store, clock, 'aaaa', runs, logs);
  const b = appCopy(store, clock, 'bbbb', runs, logs);
  await a.leadership.start();
  await b.leadership.start();
  // A freezes: no renewals. B retries every 10 s; the lease (30 s) expires between 30 and 40 s.
  for (let i = 0; i < 3; i += 1) {
    advance(clock, 10_000);
    await b.leadership.tick();
    assert.equal(b.leadership.holds(), false, `still following at ${String((i + 1) * 10)} s`);
  }
  // From 20 s on, the frozen A no longer trusts its lease either: no overlap.
  assert.equal(a.leadership.holds(), false);
  advance(clock, 1);
  await b.leadership.tick();
  assert.equal(b.leadership.holds(), true);
  await b.scheduler.runOnce();
  await a.scheduler.runOnce();
  assert.deepEqual(runs, ['bbbb']);
});

test('AS-4: a lease query error is logged as an error once, and is not "another copy leads"', async () => {
  const store = memoryStore();
  const clock = { wall: Date.UTC(2026, 10, 20, 12), mono: 1_000 };
  const runs = [];
  const logs = [];
  const a = appCopy(store, clock, 'aaaa', runs, logs);
  store.state.fail = true;
  await a.leadership.start();
  await a.leadership.tick();
  assert.deepEqual(logs, [
    'aaaa: leader lease: claim failed (Error: ECONNRESET); this copy runs no singleton duty until the database answers',
  ]);
  await a.scheduler.runOnce();
  assert.deepEqual(runs, []);
  store.state.fail = false;
  await a.leadership.tick();
  assert.match(logs.at(-1), /this copy \(aaaa\) leads/u);
});

test('describeLeaseTick: quiet while nothing changes', () => {
  assert.equal(
    describeLeaseTick({ kind: 'leader', generation: 1, changed: false }, 'a', false),
    undefined,
  );
  assert.equal(
    describeLeaseTick({ kind: 'follower', holder: 'b', changed: false }, 'a', false),
    undefined,
  );
  assert.equal(
    describeLeaseTick({ kind: 'follower', holder: null, changed: true }, 'a', false),
    'leader lease: no live leader yet; this copy (a) retries',
  );
});

test('leaderGatedLock: refuses without calling the named lock while not leading', async () => {
  let calls = 0;
  const lock = { run: async () => ((calls += 1), { ran: true, result: 1 }), end: async () => {} };
  let leads = false;
  const gated = leaderGatedLock(lock, () => leads);
  assert.deepEqual(await gated.run('x', async () => 1), { ran: false });
  assert.equal(calls, 0);
  leads = true;
  assert.deepEqual(await gated.run('x', async () => 1), { ran: true, result: 1 });
});

test('RT-3: server.mjs gates the relay batch and the sweeps lock on the lease, and releases it on shutdown', () => {
  const source = readFileSync(join(HERE, 'server.mjs'), 'utf8');
  assert.match(source, /if \(running \|\| !mayRun\(\)\) return;/u);
  assert.match(source, /const lock = leaderGatedLock\(/u);
  assert.match(source, /leadership = await startLeadership\(env, async \(holds\) => \{/u);
  // Released after the duties stopped, never before.
  const stop = source.indexOf('await leadership?.stop();');
  assert.ok(stop > source.indexOf('await stopWorker?.();'));
  assert.ok(stop > source.indexOf('await stopSweeps?.();'));
});

test('RT-3: the Hostinger bundle copies leadership.mjs and server-timeouts.mjs', () => {
  const build = readFileSync(join(HERE, '../../deploy/hostinger/build.mjs'), 'utf8');
  assert.match(build, /'leadership\.mjs'/u);
  assert.match(build, /'server-timeouts\.mjs'/u);
});
