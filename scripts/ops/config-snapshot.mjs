#!/usr/bin/env node
/**
 * Config manifest (51-09): the **names** of the configuration variables and a salted SHA-256 of
 * each value — never a value — so a restore can confirm "the same variables with the same values"
 * without the backup ever holding a secret. The values themselves live in the operator's password
 * manager entry "TManage live env" (the config backup proper).
 *
 *   node scripts/ops/config-snapshot.mjs [--env-file <KEY=VALUE file>] [--out config-manifest.json]
 *   node scripts/ops/config-snapshot.mjs --check config-manifest.json [--env-file <file>]
 *
 * The source is the process environment (what the cron line or shell passes), or `--env-file`
 * (e.g. an export of the hPanel variables). Shell and OS variables (PATH, HOME, npm_*, …) are
 * left out. `--check` exits 1 when a recorded name is missing or its value changed.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './backup-plan.mjs';

export const CONFIG_MANIFEST_FORMAT = 1;

const OS_NAMES = new Set(
  'PATH PATHEXT HOME HOMEDRIVE HOMEPATH PWD OLDPWD SHELL SHLVL TERM TERM_PROGRAM USER USERNAME LOGNAME LANG LC_ALL TMP TEMP TMPDIR HOSTNAME MAIL _ COMSPEC SYSTEMROOT SYSTEMDRIVE WINDIR APPDATA LOCALAPPDATA PROGRAMDATA PROGRAMFILES OS PROCESSOR_ARCHITECTURE NUMBER_OF_PROCESSORS PUBLIC USERPROFILE MYSQL_PWD'.split(
    ' ',
  ),
);

export function isConfigName(name) {
  const upper = name.toUpperCase();
  return (
    /^[A-Z][A-Z0-9_]*$/.test(name) &&
    !OS_NAMES.has(upper) &&
    !upper.startsWith('NPM_') &&
    !upper.startsWith('PNPM_') &&
    !upper.startsWith('PROGRAMFILES') &&
    !upper.startsWith('COMMONPROGRAM')
  );
}

/** Parses `KEY=VALUE` lines (optional `export `, quotes, `#` comments). */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

const digest = (salt, name, value) =>
  createHmac('sha256', Buffer.from(salt, 'hex')).update(`${name}\0${value}`).digest('hex');

export function buildConfigManifest(
  env,
  { salt = randomBytes(16).toString('hex'), now = new Date() } = {},
) {
  const names = Object.keys(env)
    .filter((n) => isConfigName(n) && env[n] !== undefined)
    .sort();
  const entries = Object.fromEntries(names.map((n) => [n, digest(salt, n, env[n])]));
  return {
    format: CONFIG_MANIFEST_FORMAT,
    createdAt: now.toISOString(),
    salt,
    count: names.length,
    entries,
  };
}

/** Which recorded names are missing, changed or new in `env`; `ok` when none missing/changed. */
export function compareConfigManifest(manifest, env) {
  if (manifest?.format !== CONFIG_MANIFEST_FORMAT || typeof manifest.salt !== 'string') {
    throw new Error('not a config manifest');
  }
  const missing = [];
  const changed = [];
  for (const [name, hash] of Object.entries(manifest.entries)) {
    if (env[name] === undefined) missing.push(name);
    else if (digest(manifest.salt, name, env[name]) !== hash) changed.push(name);
  }
  const extra = Object.keys(env)
    .filter((n) => isConfigName(n) && !(n in manifest.entries))
    .sort();
  return { ok: missing.length === 0 && changed.length === 0, missing, changed, extra };
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    'env-file': 'string',
    out: 'string',
    check: 'string',
  });
  const env = args['env-file'] ? parseEnvFile(readFileSync(args['env-file'], 'utf8')) : process.env;
  if (args.check) {
    const r = compareConfigManifest(JSON.parse(readFileSync(args.check, 'utf8')), env);
    console.log(`missing: ${r.missing.join(', ') || '-'}`);
    console.log(`changed: ${r.changed.join(', ') || '-'}`);
    console.log(`new:     ${r.extra.join(', ') || '-'}`);
    console.log(r.ok ? 'Config matches the manifest.' : 'Config differs from the manifest.');
    process.exit(r.ok ? 0 : 1);
  }
  const text = `${JSON.stringify(buildConfigManifest(env), null, 2)}\n`;
  if (args.out) writeFileSync(args.out, text, { mode: 0o600 });
  else process.stdout.write(text);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error(`config-snapshot failed: ${err.message}`);
    process.exit(1);
  }
}
