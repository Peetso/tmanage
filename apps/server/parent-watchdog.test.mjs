// R2 (2026-11-21; RT-6, DC-3): the web child ends when server.mjs ends, even on SIGKILL.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { pidExists, startParentWatchdog, watchInterval } from './parent-watchdog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WATCHDOG_URL = pathToFileURL(resolve(HERE, 'parent-watchdog.mjs')).href;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Resolve true once `pid` is gone, false if it is still there after `withinMs`. */
async function goneWithin(pid, withinMs) {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (!pidExists(pid)) return true;
    await sleep(50);
  }
  return !pidExists(pid);
}

/**
 * Start a stand-in for server.mjs that spawns one long-lived grandchild (the stand-in for
 * `next start`), with or without the watchdog preload, and prints the grandchild's pid.
 */
async function startParentWithChild({ watchdog }) {
  const child = [
    ...(watchdog ? ['--import', WATCHDOG_URL] : []),
    '-e',
    'setInterval(() => {}, 1000)',
  ];
  const parentSource = [
    "const { spawn } = require('node:child_process');",
    `const c = spawn(process.execPath, ${JSON.stringify(child)}, {`,
    "  stdio: 'ignore',",
    // On Windows libuv puts every non-detached child in a kill-on-close job object, so a killed
    // parent takes its children with it and the orphan never appears. Detached children are left
    // out of that job, which reproduces the Linux orphan (and the ESRCH path) here.
    `  detached: ${process.platform === 'win32'},`,
    '  env: { ...process.env, TMANAGE_PARENT_PID: String(process.pid), TMANAGE_PARENT_WATCH_MS: "100" },',
    '});',
    'process.stdout.write(`CHILD ${c.pid}\\n`);',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const parent = spawn(process.execPath, ['-e', parentSource], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const childPid = await new Promise((done, fail) => {
    let text = '';
    parent.stdout.on('data', (chunk) => {
      text += chunk;
      const match = /CHILD (\d+)/.exec(text);
      if (match) done(Number(match[1]));
    });
    parent.once('exit', (code) => fail(new Error(`parent exited early (${code})`)));
  });
  return { parent, childPid };
}

test('SIGKILL of the parent: the watchdog ends the child within 2 s', async () => {
  const { parent, childPid } = await startParentWithChild({ watchdog: true });
  // Let the child load the preload and start its timer.
  await sleep(500);
  assert.ok(pidExists(childPid), 'child should be running before the parent dies');
  parent.kill('SIGKILL');
  try {
    assert.ok(await goneWithin(childPid, 2000), `child ${childPid} outlived its parent`);
  } finally {
    if (pidExists(childPid)) process.kill(childPid, 'SIGKILL');
  }
});

test('control: without the watchdog the same child is orphaned (the test can see a leftover)', async () => {
  const { parent, childPid } = await startParentWithChild({ watchdog: false });
  await sleep(300);
  parent.kill('SIGKILL');
  try {
    assert.equal(await goneWithin(childPid, 1000), false, 'child ended without a watchdog');
  } finally {
    if (pidExists(childPid)) process.kill(childPid, 'SIGKILL');
  }
});

test('a re-parented child fires once; a wrapper parent never trips the ppid check', async () => {
  const proc = { ppid: 100, channel: undefined };
  const reasons = [];
  startParentWatchdog({
    parentPid: 100,
    intervalMs: 10,
    proc,
    exists: () => true,
    onGone: (r) => reasons.push(r),
  });
  await sleep(40);
  assert.deepEqual(reasons, []);
  proc.ppid = 1;
  await sleep(60);
  assert.deepEqual(reasons, ['re-parented to 1']);

  // Started under a wrapper (ppid != the pid it follows): only the pid's existence counts.
  const wrapped = { ppid: 7, channel: undefined };
  const fired = [];
  const stop = startParentWatchdog({
    parentPid: 100,
    intervalMs: 10,
    proc: wrapped,
    exists: () => true,
    onGone: (r) => fired.push(r),
  });
  await sleep(50);
  stop();
  assert.deepEqual(fired, []);
});

test('ESRCH is gone, EPERM is alive; the interval override is bounded', () => {
  const thrower = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(pidExists(1, thrower('ESRCH')), false);
  assert.equal(pidExists(1, thrower('EPERM')), true);
  assert.equal(
    pidExists(1, () => true),
    true,
  );
  assert.equal(watchInterval({}), 2000);
  assert.equal(watchInterval({ TMANAGE_PARENT_WATCH_MS: '5' }), 2000);
  assert.equal(watchInterval({ TMANAGE_PARENT_WATCH_MS: '250' }), 250);
});

test('server.mjs preloads the watchdog on every transport and passes its pid', () => {
  const source = readFileSync(resolve(HERE, 'server.mjs'), 'utf8');
  const spawnFn = source.slice(
    source.indexOf('function spawnWebChild'),
    source.indexOf('async function startWeb'),
  );
  assert.match(spawnFn, /resolve\(ROOT, 'parent-watchdog\.mjs'\)/);
  // Outside the tcp-only branch: the watchdog entry comes before the transport ternary.
  assert.ok(spawnFn.indexOf('parent-watchdog.mjs') < spawnFn.indexOf("transport.kind === 'tcp'"));
  assert.match(spawnFn, /TMANAGE_PARENT_PID: String\(process\.pid\)/);
});

test('R3: server.mjs logs each boot stage with pid and elapsed ms', () => {
  const source = readFileSync(resolve(HERE, 'server.mjs'), 'utf8');
  assert.match(
    source,
    /boot: \$\{stage\} \+\$\{Math\.round\(process\.uptime\(\) \* 1000\)\}ms \(pid \$\{process\.pid\}\)/,
  );
  for (const stage of ['listening', 'migrations done', 'api ready', 'web ready']) {
    assert.ok(source.includes(`bootMark('${stage}')`), `missing boot mark '${stage}'`);
  }
});
