// Run: node --test deploy/hostinger/wave10-r8-bundle-lock.test.mjs
// Security audit run 2, NV08 (partial): the bundle lockfile npm resolves from the live registry
// must be the production tree pnpm-lock.yaml resolved, must respect every root override floor, is
// audited, and the pnpm selector-keyed overrides reach npm instead of being dropped. Fixture
// lockfiles and a fake npm runner only: no registry, no install, no deploy.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { stageInstallPins } from './build.mjs';
import {
  bundleOverrides,
  compareProductionSets,
  npmLockProductionSet,
  npmOverridesFromRoot,
  overrideFloorViolations,
  parseOverrideKey,
  parsePnpmLock,
  pnpmProductionSet,
  satisfies,
} from './bundle-overrides.mjs';

const ROOT_OVERRIDES = {
  'body-parser@>=2 <2.4.0': '2.4.0',
  'brace-expansion@<1.1.21': '^1.1.21',
  'brace-expansion@>=4.0.0 <5.0.12': '^5.0.12',
  'fast-uri@<3.1.9': '^3.1.9',
  'fast-uri@>=4 <4.2.3': '^4.2.3',
  fastify: '5.12.7',
  'js-yaml@>=4 <4.3.2': '^4.3.2',
  sharp: '>=0.35.5 <0.36',
};

// A pnpm v9 lockfile: one vendored importer with a dev dependency, a package with an optional
// peer that pnpm resolved from the workspace (npm would not install it) and an optional dep.
const PNPM_LOCK = `lockfileVersion: '9.0'

importers:

  apps/api:
    dependencies:
      '@tmanage/config':
        specifier: workspace:*
        version: link:../../packages/config
      fastify:
        specifier: 5.12.7
        version: 5.12.7
      styler:
        specifier: ^1.0.0
        version: 1.0.0(@babel/core@7.29.7)
    devDependencies:
      vitest:
        specifier: ^4.1.0
        version: 4.1.12

  apps/web:
    dependencies:
      next:
        specifier: 16.3.8
        version: 16.3.8

packages:

  '@babel/core@7.29.7':
    resolution: {integrity: sha512-x}

  fast-uri@3.1.9:
    resolution: {integrity: sha512-x}

  fastify@5.12.7:
    resolution: {integrity: sha512-x}

  next@16.3.8:
    resolution: {integrity: sha512-x}

  '@next/swc-linux-x64-gnu@16.3.8':
    resolution: {integrity: sha512-x}
    cpu: [x64]
    os: [linux]

  styler@1.0.0:
    resolution: {integrity: sha512-x}
    peerDependencies:
      '@babel/core': '*'
    peerDependenciesMeta:
      '@babel/core':
        optional: true

  vitest@4.1.12:
    resolution: {integrity: sha512-x}

snapshots:

  '@babel/core@7.29.7': {}

  fast-uri@3.1.9: {}

  fastify@5.12.7:
    dependencies:
      fast-uri: 3.1.9
    transitivePeerDependencies:
      - supports-color

  next@16.3.8:
    optionalDependencies:
      '@next/swc-linux-x64-gnu': 16.3.8

  '@next/swc-linux-x64-gnu@16.3.8':
    optional: true

  styler@1.0.0(@babel/core@7.29.7):
    dependencies:
      '@babel/core': 7.29.7

  vitest@4.1.12: {}
`;

const EXPECTED = [
  '@next/swc-linux-x64-gnu@16.3.8',
  'fast-uri@3.1.9',
  'fastify@5.12.7',
  'next@16.3.8',
  'styler@1.0.0',
];

function npmLock(packages) {
  return {
    name: 'tmanage-hostinger',
    lockfileVersion: 3,
    packages: {
      '': { name: 'tmanage-hostinger' },
      'node_modules/@tmanage/api': { version: '0.1.0', resolved: 'file:vendor/@tmanage/api' },
      'node_modules/vitest': { version: '4.1.12', dev: true },
      ...packages,
    },
  };
}

const CLEAN = {
  'node_modules/fastify': { version: '5.12.7' },
  'node_modules/fast-uri': { version: '3.1.9' },
  'node_modules/next': { version: '16.3.8' },
  'node_modules/@next/swc-linux-x64-gnu': { version: '16.3.8', optional: true },
  'node_modules/styler': { version: '1.0.0' },
};

const NO_ADVISORIES = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
});

function withStage(packages, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tmanage-r8-'));
  const calls = [];
  const runner = (cmd, args, _env, cwd) => {
    calls.push(args);
    if (args[0] === 'install') {
      writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(npmLock(packages)));
    }
    if (args[0] === 'audit' && fn.auditFails) throw new Error('npm audit exited 1');
    if (args[0] === 'audit') return { status: 0, stdout: NO_ADVISORIES };
  };
  try {
    return fn(dir, runner, calls);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pnpmSet = () =>
  pnpmProductionSet(parsePnpmLock(PNPM_LOCK), ['apps/api'], { next: 'apps/web' });

test('the pnpm production set follows dependencies and optional deps, not dev deps or optional peers', () => {
  assert.deepEqual([...pnpmSet()].sort(), EXPECTED);
});

test('the npm production set skips dev, file: and @tmanage entries', () => {
  assert.deepEqual([...npmLockProductionSet(npmLock(CLEAN))].sort(), EXPECTED);
});

test('a matching lockfile passes and is audited with --omit=dev --audit-level=high --json', () => {
  withStage(CLEAN, (dir, runner, calls) => {
    const result = stageInstallPins(dir, runner, {
      pnpmSet: pnpmSet(),
      rootOverrides: ROOT_OVERRIDES,
    });
    assert.equal(result.installScripts.length, 0);
    assert.deepEqual(calls.at(-1), ['audit', '--omit=dev', '--audit-level=high', '--json']);
  });
});

test('exploit: the registry serves a different patch on build day, so the build fails', () => {
  const drifted = { ...CLEAN, 'node_modules/fastify': { version: '5.12.8' } };
  withStage(drifted, (dir, runner, calls) => {
    assert.throws(
      () => stageInstallPins(dir, runner, { pnpmSet: pnpmSet(), rootOverrides: ROOT_OVERRIDES }),
      /only in the bundle lock: fastify@5\.12\.8[\s\S]*only in pnpm-lock\.yaml: fastify@5\.12\.7/,
    );
    assert.ok(!calls.some((args) => args[0] === 'audit'), 'no audit of a refused tree');
  });
});

test('exploit: an extra package the registry added to the tree fails the build', () => {
  withStage({ ...CLEAN, 'node_modules/left-pad': { version: '1.3.0' } }, (dir, runner) => {
    assert.throws(
      () => stageInstallPins(dir, runner, { pnpmSet: pnpmSet() }),
      /only in the bundle lock: left-pad@1\.3\.0/,
    );
  });
});

test('exploit: a package below a root override floor fails even when both locks agree', () => {
  const low = { ...CLEAN, 'node_modules/fast-uri': { version: '3.1.8' } };
  const set = new Set([...pnpmSet()].map((x) => (x === 'fast-uri@3.1.9' ? 'fast-uri@3.1.8' : x)));
  withStage(low, (dir, runner) => {
    assert.throws(
      () => stageInstallPins(dir, runner, { pnpmSet: set, rootOverrides: ROOT_OVERRIDES }),
      /below a root override floor: fast-uri@3\.1\.8 \(override fast-uri@<3\.1\.9: \^3\.1\.9\)/,
    );
  });
});

test('a high advisory from npm audit fails the build', () => {
  const fn = (dir, runner) =>
    assert.throws(
      () => stageInstallPins(dir, runner, { pnpmSet: pnpmSet() }),
      /npm audit exited 1/,
    );
  fn.auditFails = true;
  withStage(CLEAN, fn);
});

test('the check cannot be skipped: no pnpm set is a refusal', () => {
  withStage(CLEAN, (dir, runner) => {
    assert.throws(() => stageInstallPins(dir, runner), /pnpm-lock\.yaml production set/);
    assert.throws(() => stageInstallPins(dir, runner, { pnpmSet: new Set() }), /production set/);
  });
});

test('selector-keyed pnpm overrides become npm override keys instead of being dropped', () => {
  const runtime = ['body-parser', 'brace-expansion', 'fast-uri', 'js-yaml', 'fastify', 'sharp'];
  assert.deepEqual(
    npmOverridesFromRoot({ pnpm: { overrides: ROOT_OVERRIDES } }, runtime),
    ROOT_OVERRIDES,
  );
});

test('a parent chain becomes a nested npm override, and `.` keeps the parent pin', () => {
  const rootPkg = { pnpm: { overrides: { a: '1.0.0', 'a>b': '2.0.0', 'c@^1>@s/d@<3': '3.0.0' } } };
  assert.deepEqual(npmOverridesFromRoot(rootPkg, ['a', 'b', 'c', '@s/d']), {
    a: { '.': '1.0.0', b: '2.0.0' },
    'c@^1': { '@s/d@<3': '3.0.0' },
  });
  assert.deepEqual(parseOverrideKey('body-parser@>=2 <2.4.0'), [
    { name: 'body-parser', range: '>=2 <2.4.0' },
  ]);
  assert.throws(() => parseOverrideKey('Not A Name'), /unreadable/);
});

test('satisfies() covers the ranges the overrides use and refuses what it cannot read', () => {
  assert.ok(satisfies('2.3.9', '>=2 <2.4.0'));
  assert.ok(!satisfies('2.4.0', '>=2 <2.4.0'));
  assert.ok(satisfies('3.1.9', '^3.1.9') && !satisfies('4.0.0', '^3.1.9'));
  assert.ok(satisfies('0.35.9', '>=0.35.5 <0.36') && !satisfies('0.36.0', '>=0.35.5 <0.36'));
  assert.ok(satisfies('0.2.3', '^0.2') && !satisfies('0.3.0', '^0.2'));
  assert.ok(satisfies('1.2.9', '~1.2.3') && !satisfies('1.3.0', '~1.2.3'));
  assert.ok(satisfies('5.0.0', '^4 || ^5') && satisfies('9.9.9', '*'));
  assert.throws(() => satisfies('1.0.0', '1.0.0 - 2.0.0'), /unsupported range/);
  assert.throws(() => satisfies('latest', '^1'), /unsupported version/);
});

test('bundleOverrides pins single versions and caret lines, never a direct dependency', () => {
  const set = new Set([
    'fastify@5.12.7',
    'next@16.3.8',
    'cookie@1.0.2',
    'cookie@0.7.2',
    'js-yaml@4.3.2',
  ]);
  const overrides = bundleOverrides({ pnpm: { overrides: ROOT_OVERRIDES } }, set, ['next']);
  assert.deepEqual(overrides, {
    fastify: '5.12.7',
    'js-yaml@>=4 <4.3.2': '^4.3.2',
    'js-yaml': '4.3.2',
    'cookie@^1': '1.0.2',
    'cookie@^0.7': '0.7.2',
  });
});

test('the real pnpm-lock.yaml parses, and its production tree respects every root override', () => {
  const repo = new URL('../../', import.meta.url);
  const lock = parsePnpmLock(readFileSync(new URL('pnpm-lock.yaml', repo), 'utf8'));
  const rootPkg = JSON.parse(readFileSync(new URL('package.json', repo), 'utf8'));
  const importers = ['config', 'domain', 'mail', 'storage', 'contracts', 'ui'].map(
    (p) => `packages/${p}`,
  );
  importers.push('apps/mcp-server', 'apps/worker', 'apps/api');
  const set = pnpmProductionSet(lock, importers, {
    '@tanstack/react-query': 'apps/web',
    next: 'apps/web',
    react: 'apps/web',
    'react-dom': 'apps/web',
    'reflect-metadata': 'apps/api',
  });
  assert.ok(set.size > 100, `production set has ${set.size} packages`);
  assert.ok(!set.has('vitest@4.1.12') && ![...set].some((x) => x.startsWith('vitest@')));
  assert.deepEqual(overrideFloorViolations(set, rootPkg.pnpm.overrides), []);
  assert.ok(compareProductionSets(set, set).same);
});
