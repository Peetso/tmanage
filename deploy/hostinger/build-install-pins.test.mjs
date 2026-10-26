// Security audit NV08 / NV05 — the staged bundle pins its install and bakes no dialable target.
// Driven with a fake npm runner, so no registry, no install and no deploy happen here.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AUDIT_ADVISORY_ALLOWLIST,
  AUDIT_ALLOWLIST_MAX_AGE_DAYS,
  BUNDLE_NPMRC,
  INSTALL_SCRIPT_ALLOWLIST,
  unallowedAuditFindings,
  stageInstallPins,
  WEB_BUILD_API_PROXY_TARGET,
} from './build.mjs';

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'tmanage-pins-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"tmanage-hostinger","version":"0.1.0"}\n');
  return dir;
}

const NO_ADVISORIES = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
});

function fakeNpm(packages) {
  const calls = [];
  const runner = (cmd, args, _env, cwd) => {
    calls.push({ cmd, args, cwd });
    if (args[0] === 'audit') return { status: 0, stdout: NO_ADVISORIES };
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
    const result = stageInstallPins(dir, runner, { pnpmSet: new Set(['next@16.3.8']) });

    assert.ok(existsSync(join(dir, 'package-lock.json')), 'package-lock.json staged');
    const npmrc = readFileSync(join(dir, '.npmrc'), 'utf8');
    assert.equal(npmrc, BUNDLE_NPMRC);
    assert.match(npmrc, /^ignore-scripts=true$/m);
    assert.match(npmrc, /^install-links=true$/m);
    assert.match(npmrc, /^bin-links=false$/m);

    // The lock is resolved without running anything or writing node_modules, then audited.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].cmd, 'npm');
    assert.equal(calls[0].cwd, dir);
    assert.ok(calls[0].args.includes('--package-lock-only'));
    assert.ok(calls[0].args.includes('--ignore-scripts'));
    assert.deepEqual(calls[1].args, ['audit', '--omit=dev', '--audit-level=high', '--json']);
    assert.deepEqual(result, { packages: 2, installScripts: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the build fails when no lockfile was produced', () => {
  const dir = stage();
  try {
    assert.throws(
      () => stageInstallPins(dir, fakeNpm(undefined).runner, { pnpmSet: new Set(['next@16.3.8']) }),
      /no package-lock\.json/,
    );
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
    assert.throws(
      () => stageInstallPins(dir, runner, { pnpmSet: new Set(['evil-postinstall@1.0.0']) }),
      /evil-postinstall@1\.0\.0/,
    );
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

// Audit run 2, NO-GO reason 1: the release could not be built because npm audit flags zod@3.25.76
// (GHSA-mrhx-c7xc-m3w5). A reviewed allowlist entry lets exactly that advisory on exactly that
// version through; any other high, the same advisory on another version, or a stale review still
// fails. Wave 13 moved to zod 4.6.x and emptied the production list, so the mechanism is proven
// here against FIXTURE_ALLOWLIST, the entry the list held until then.
// The report below is npm 11's real `npm audit --omit=dev --audit-level=high --json` for zod@3.25.76.
function advisory(name, version, ghsa, severity = 'high') {
  return {
    report: JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        [name]: {
          name,
          severity,
          isDirect: true,
          via: [
            {
              source: 1243066,
              name,
              dependency: name,
              title: 'Zod can exhaust memory while validating oversized constrained collections',
              url: `https://github.com/advisories/${ghsa}`,
              severity,
              range: '<4.6.6',
            },
          ],
          effects: [],
          range: '<4.6.6',
          nodes: [`node_modules/${name}`],
        },
      },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
      },
    }),
    lock: {
      lockfileVersion: 3,
      packages: { '': { name: 'tmanage-hostinger' }, [`node_modules/${name}`]: { version } },
    },
  };
}

const REVIEW_DAY = new Date('2026-10-26T12:00:00Z');

/** The reviewed entry the production list held until wave 13 (a test fixture now). */
const FIXTURE_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: 'GHSA-mrhx-c7xc-m3w5',
    package: 'zod@3.25.76',
    reason: 'Test fixture: the reviewed zod 3 entry the production list held until wave 13.',
    reviewed: '2026-10-26',
  }),
]);

test('wave 13: the production allowlist is empty, so the old zod advisory fails the build', () => {
  assert.deepEqual([...AUDIT_ADVISORY_ALLOWLIST], []);
  const { report, lock } = advisory('zod', '3.25.76', 'GHSA-mrhx-c7xc-m3w5');
  assert.deepEqual(unallowedAuditFindings(report, lock, undefined, REVIEW_DAY), [
    'GHSA-mrhx-c7xc-m3w5 zod@3.25.76 (high)',
  ]);
});

test('wave 13: the runtime packages pin a zod with the advisory fixed (>= 4.6.6)', () => {
  for (const pkg of ['apps/api', 'apps/mcp-server', 'packages/config']) {
    const manifest = JSON.parse(
      readFileSync(new URL(`../../${pkg}/package.json`, import.meta.url), 'utf8'),
    );
    const [major, minor, patch] = manifest.dependencies.zod
      .replace(/^\^/, '')
      .split('.')
      .map(Number);
    assert.ok(major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6))), pkg);
  }
});

test('the allowlist entry is complete: id, exact package@version, reason, review date', () => {
  for (const entry of [...AUDIT_ADVISORY_ALLOWLIST, ...FIXTURE_ALLOWLIST]) {
    assert.match(entry.id, /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
    assert.match(entry.package, /^[^@]+@\d+\.\d+\.\d+$/);
    assert.ok(entry.reason.length > 20);
    assert.ok(Number.isFinite(Date.parse(entry.reviewed)));
  }
});

test('a reviewed advisory on its exact version passes', () => {
  const { report, lock } = advisory('zod', '3.25.76', 'GHSA-mrhx-c7xc-m3w5');
  assert.deepEqual(unallowedAuditFindings(report, lock, FIXTURE_ALLOWLIST, REVIEW_DAY), []);
});

test('exploit: any other high advisory fails the build', () => {
  const { report, lock } = advisory('left-pad', '1.3.0', 'GHSA-aaaa-bbbb-cccc');
  assert.deepEqual(unallowedAuditFindings(report, lock, FIXTURE_ALLOWLIST, REVIEW_DAY), [
    'GHSA-aaaa-bbbb-cccc left-pad@1.3.0 (high)',
  ]);
  const critical = advisory('zod', '3.25.76', 'GHSA-zzzz-yyyy-xxxx', 'critical');
  assert.equal(
    unallowedAuditFindings(critical.report, critical.lock, FIXTURE_ALLOWLIST, REVIEW_DAY).length,
    1,
  );
});

test('exploit: the allowed advisory on a different zod version fails the build', () => {
  const { report, lock } = advisory('zod', '3.25.75', 'GHSA-mrhx-c7xc-m3w5');
  assert.deepEqual(unallowedAuditFindings(report, lock, FIXTURE_ALLOWLIST, REVIEW_DAY), [
    'GHSA-mrhx-c7xc-m3w5 zod@3.25.75 (high)',
  ]);
});

test('a review older than the maximum age fails the build again', () => {
  const { report, lock } = advisory('zod', '3.25.76', 'GHSA-mrhx-c7xc-m3w5');
  const later = new Date(REVIEW_DAY.getTime() + (AUDIT_ALLOWLIST_MAX_AGE_DAYS + 1) * 86_400_000);
  assert.equal(unallowedAuditFindings(report, lock, FIXTURE_ALLOWLIST, later).length, 1);
});

test('an unreadable or error report is never a pass', () => {
  const { lock } = advisory('zod', '3.25.76', 'GHSA-mrhx-c7xc-m3w5');
  assert.throws(() => unallowedAuditFindings('', lock), /no readable report/);
  assert.throws(
    () => unallowedAuditFindings(JSON.stringify({ error: { code: 'ENOLOCK' } }), lock),
    /npm audit failed/,
  );
  assert.throws(() => unallowedAuditFindings('{}', lock), /no vulnerabilities object/);
  const hidden = JSON.stringify({
    vulnerabilities: {},
    metadata: { vulnerabilities: { high: 1, critical: 0 } },
  });
  assert.equal(unallowedAuditFindings(hidden, lock).length, 1);
});

test('stageInstallPins: an allowed advisory builds, any other high throws', () => {
  for (const [ghsa, ok] of [
    ['GHSA-mrhx-c7xc-m3w5', true],
    ['GHSA-aaaa-bbbb-cccc', false],
  ]) {
    const dir = stage();
    try {
      const { report } = advisory('zod', '3.25.76', ghsa);
      const runner = (_cmd, args, _env, cwd) => {
        if (args[0] === 'audit') return { status: 1, stdout: report };
        writeFileSync(
          join(cwd, 'package-lock.json'),
          JSON.stringify({
            lockfileVersion: 3,
            packages: { '': {}, 'node_modules/zod': { version: '3.25.76' } },
          }),
        );
      };
      const expected = {
        pnpmSet: new Set(['zod@3.25.76']),
        auditAllowlist: FIXTURE_ALLOWLIST,
        now: REVIEW_DAY,
      };
      if (ok) assert.equal(stageInstallPins(dir, runner, expected).packages, 2);
      else assert.throws(() => stageInstallPins(dir, runner, expected), /GHSA-aaaa-bbbb-cccc/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
