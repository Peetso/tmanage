import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { MIGRATION_SHUTDOWN_GRACE_MS, createMigrationGate } from './migration-shutdown.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** A stand-in for the migrator: `files` files of `fileMs` each, asking `shouldStop` before each. */
function fakeMigration(files, fileMs, events) {
  return async (shouldStop) => {
    for (let n = 1; n <= files; n += 1) {
      if (shouldStop()) {
        events.push('stopped');
        return { stopped: true };
      }
      events.push(`start ${n}`);
      await sleep(fileMs);
      events.push(`done ${n}`);
    }
    return { stopped: false };
  };
}

test('the shutdown grace is bounded at 120 s', () => {
  assert.equal(MIGRATION_SHUTDOWN_GRACE_MS, 120_000);
});

test('settle() with no migration in progress returns at once', async () => {
  const gate = createMigrationGate();
  assert.equal(await gate.settle(), 'idle');
});

test('a stop during a migration lets the current file finish and starts no further file', async () => {
  const events = [];
  const gate = createMigrationGate();
  const run = gate.run(fakeMigration(3, 80, events));
  await sleep(20);
  assert.equal(gate.running, true);
  gate.requestStop();
  const outcome = await gate.settle();
  events.push('settled');
  assert.equal(outcome, 'finished');
  assert.deepEqual(events, ['start 1', 'done 1', 'stopped', 'settled']);
  assert.deepEqual(await run, { stopped: true });
  assert.equal(gate.running, false);
  assert.equal(gate.stopping, true);
});

test('a stop requested before the run starts no file at all', async () => {
  const events = [];
  const gate = createMigrationGate();
  gate.requestStop();
  await gate.run(fakeMigration(2, 10, events));
  assert.deepEqual(events, ['stopped']);
});

test('settle() gives up after the grace period instead of hanging the shutdown', async () => {
  const lines = [];
  const gate = createMigrationGate({ graceMs: 30, log: (line) => lines.push(line) });
  const run = gate.run(() => sleep(300));
  gate.requestStop();
  const started = Date.now();
  assert.equal(await gate.settle(), 'timed-out');
  assert.ok(Date.now() - started < 250, 'settle returned before the migration ended');
  assert.match(lines.at(-1), /exiting anyway/);
  await run;
});

test('a failing migration settles as failed and never rejects the shutdown', async () => {
  const gate = createMigrationGate();
  const run = gate.run(async () => {
    await sleep(20);
    throw new Error('boom');
  });
  gate.requestStop();
  assert.equal(await gate.settle(), 'failed');
  await assert.rejects(run, /boom/);
});

// The process-level contract: a SIGTERM handler wired like server.mjs's (requestStop, await
// settle, exit) only exits after the migration file in progress has finished. On Windows a
// SIGTERM sent from outside cannot be caught (Node terminates the child), so there the parent
// asks the child over IPC to raise it on itself — the handler path is the same.
test('a process sent SIGTERM during a slow migration exits only after the file completes', async () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./migration-shutdown.fixture.mjs', import.meta.url))],
    { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] },
  );
  let out = '';
  const started = new Promise((done) => {
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      if (out.includes('start 1')) done();
    });
  });
  const exited = new Promise((done) => child.on('exit', (code) => done(code)));
  await started;
  if (process.platform === 'win32') child.send('SIGTERM');
  else child.kill('SIGTERM');
  const code = await exited;
  assert.equal(code, 0);
  const lines = out.trim().split(/\r?\n/);
  assert.deepEqual(lines, ['start 1', 'signal', 'done 1', 'stopped', 'exit']);
});
