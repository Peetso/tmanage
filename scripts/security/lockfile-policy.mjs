#!/usr/bin/env node
/**
 * 56-14 — install-time supply-chain policy. `node scripts/security/lockfile-policy.mjs [--audit]`
 *
 *   1. pnpm-lock.yaml is present and versioned, and every CI `pnpm install` is `--frozen-lockfile`.
 *   2. `onlyBuiltDependencies` (pnpm-workspace.yaml) holds only packages reviewed below: pnpm runs
 *      install scripts for those alone, so adding one is a security decision, made here.
 *   3. The Hostinger bundle's `.npmrc` keeps `ignore-scripts=true` (deploy/hostinger/build.mjs).
 *   4. `.node-version` is an exact version inside `engines.node` and equals CI's `NODE_VERSION`.
 *
 * `--audit` also runs `pnpm audit --prod --audit-level=moderate` and prints it as a warning only
 * (it needs the network; the deploy build's own high/critical audit gate stays the hard stop).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLE_NPMRC } from '../../deploy/hostinger/build.mjs';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/** Packages allowed to run install scripts in development, each with its review note. */
export const REVIEWED_BUILT_DEPENDENCIES = Object.freeze({
  esbuild: 'downloads its platform binary at install; used by tsx/vite, never shipped at runtime',
});

/** The `onlyBuiltDependencies` list of a pnpm-workspace.yaml, or `null` when the key is absent. */
export function onlyBuiltDependencies(workspaceYaml) {
  const lines = workspaceYaml.split(/\r?\n/);
  const at = lines.findIndex((line) => /^onlyBuiltDependencies:\s*$/.test(line));
  if (at < 0) return null;
  const names = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s+-\s+['"]?([^'"\s#]+)['"]?/.exec(line);
    if (item) names.push(item[1]);
    else if (line.trim() !== '' && !line.trim().startsWith('#')) break;
  }
  return names;
}

const parts = (v) => v.split('.').map(Number).concat([0, 0, 0]).slice(0, 3);
const compare = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** Whether `version` satisfies a space-separated comparator range such as `>=22.12.0 <23`. */
export function satisfiesRange(version, range) {
  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => {
      const m = /^(>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2})$/.exec(comparator);
      if (!m) return false;
      const c = compare(version, m[2]);
      return { '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0 }[m[1]] ?? c === 0;
    });
}

/** Every policy breach as a printable line. All inputs are file contents (`null` = missing). */
export function checkPolicy({
  lockfile,
  workspaceYaml,
  bundleNpmrc,
  ciWorkflows,
  nodeVersion,
  enginesNode,
}) {
  const findings = [];
  if (lockfile === null) findings.push('pnpm-lock.yaml is missing');
  else if (!/^lockfileVersion:/m.test(lockfile))
    findings.push('pnpm-lock.yaml has no lockfileVersion');

  for (const [file, text] of Object.entries(ciWorkflows)) {
    for (const line of text.split(/\r?\n/)) {
      if (/\bpnpm install\b/.test(line) && !line.includes('--frozen-lockfile'))
        findings.push(`${file}: \`${line.trim()}\` must use --frozen-lockfile`);
    }
  }

  const built = onlyBuiltDependencies(workspaceYaml);
  if (built === null) findings.push('pnpm-workspace.yaml has no onlyBuiltDependencies allowlist');
  for (const name of built ?? []) {
    if (!Object.hasOwn(REVIEWED_BUILT_DEPENDENCIES, name))
      findings.push(`onlyBuiltDependencies: ${name} is not reviewed in lockfile-policy.mjs`);
  }

  if (!bundleNpmrc.split(/\r?\n/).includes('ignore-scripts=true'))
    findings.push('the Hostinger bundle .npmrc must keep ignore-scripts=true');

  const pin = nodeVersion?.trim();
  if (!pin) findings.push('.node-version is missing');
  else if (!/^\d+\.\d+\.\d+$/.test(pin))
    findings.push(`.node-version "${pin}" is not an exact version`);
  else {
    if (!satisfiesRange(pin, enginesNode))
      findings.push(`.node-version ${pin} is outside engines.node "${enginesNode}"`);
    for (const [file, text] of Object.entries(ciWorkflows)) {
      const ci = /^\s*NODE_VERSION:\s*['"]?([^'"\s]+)/m.exec(text)?.[1];
      if (ci !== undefined && ci !== pin)
        findings.push(`${file}: NODE_VERSION ${ci} differs from .node-version ${pin}`);
    }
  }
  return findings;
}

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/** The policy inputs as they are in `repo`. */
export function readPolicyInputs(repo = REPO) {
  const workflowsDir = join(repo, '.github', 'workflows');
  const ciWorkflows = existsSync(workflowsDir)
    ? Object.fromEntries(
        readdirSync(workflowsDir)
          .filter((f) => /\.ya?ml$/.test(f))
          .map((f) => [`.github/workflows/${f}`, readFileSync(join(workflowsDir, f), 'utf8')]),
      )
    : {};
  return {
    lockfile: read(join(repo, 'pnpm-lock.yaml')),
    workspaceYaml: read(join(repo, 'pnpm-workspace.yaml')) ?? '',
    bundleNpmrc: BUNDLE_NPMRC,
    ciWorkflows,
    nodeVersion: read(join(repo, '.node-version')),
    enginesNode: JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).engines?.node ?? '',
  };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const findings = checkPolicy(readPolicyInputs());
  if (process.argv.includes('--audit')) {
    const audit = spawnSync('pnpm', ['audit', '--prod', '--audit-level=moderate'], {
      cwd: REPO,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (audit.status !== 0) {
      console.warn('pnpm audit (warning only, moderate or above, or no network):');
      console.warn(`${audit.stdout ?? ''}${audit.stderr ?? ''}`.trim());
    } else console.warn('pnpm audit: no moderate-or-above advisory in production dependencies');
  }
  if (findings.length > 0) {
    console.error(`lockfile policy: ${findings.length} finding(s)`);
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }
  console.warn('lockfile policy: clean');
}
