// Security audit NV08 / NV05 — the staged bundle pins its install and bakes no dialable target.
// Driven with a fake npm runner, so no registry, no install and no deploy happen here.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BUNDLE_NPMRC,
  INSTALL_SCRIPT_ALLOWLIST,
  stageInstallPins,
  WEB_BUILD_API_PROXY_TARGET,
} from './build.mjs';

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'tmanage-pins-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"tmanage-hostinger","version":"0.1.0"}\n');
  return dir;
}

function fakeNpm(packages) {
  const calls = [];
  const runner = (cmd, args, _env, cwd) => {
    calls.push({ cmd, args, cwd });
    if (packages !== undefined) {
      writeFileSync(
        join(cwd, 'package-lock.json'),
        JSON.stringify({ name: 'tmanage-hostinger', lockfileVersion: 3, packages }),
      );
    }
  };
  return { runner, calls };
}

test('the staged bundle carries a lockfile and an .npmrc with ignore-scripts', () => {
  const dir = stage();
  try {
    const { runner, calls } = fakeNpm({
      '': { name: 'tmanage-hostinger' },
      'node_modules/next': { version: '16.3.8' },
    });
    const result = stageInstallPins(dir, runner);

    assert.ok(existsSync(join(dir, 'package-lock.json')), 'package-lock.json staged');
    const npmrc = readFileSync(join(dir, '.npmrc'), 'utf8');
    assert.equal(npmrc, BUNDLE_NPMRC);
    assert.match(npmrc, /^ignore-scripts=true$/m);
    assert.match(npmrc, /^install-links=true$/m);
    assert.match(npmrc, /^bin-links=false$/m);

    // The lock is resolved without running anything or writing node_modules.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'npm');
    assert.equal(calls[0].cwd, dir);
    assert.ok(calls[0].args.includes('--package-lock-only'));
    assert.ok(calls[0].args.includes('--ignore-scripts'));
    assert.deepEqual(result, { packages: 2, installScripts: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the build fails when no lockfile was produced', () => {
  const dir = stage();
  try {
    assert.throws(() => stageInstallPins(dir, fakeNpm(undefined).runner), /no package-lock\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the build fails on a dependency with an install script that nobody allowed', () => {
  const dir = stage();
  try {
    assert.deepEqual([...INSTALL_SCRIPT_ALLOWLIST], []);
    const { runner } = fakeNpm({
      '': { name: 'tmanage-hostinger' },
      'node_modules/evil-postinstall': { version: '1.0.0', hasInstallScript: true },
    });
    assert.throws(() => stageInstallPins(dir, runner), /evil-postinstall@1\.0\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NV05: the baked /v1 rewrite target is a privileged loopback port, not 3000', () => {
  const url = new URL(WEB_BUILD_API_PROXY_TARGET);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) > 0 && Number(url.port) < 1024, 'no unprivileged process can bind it');
  const source = readFileSync(new URL('./build.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /127\.0\.0\.1:3000/);
});
