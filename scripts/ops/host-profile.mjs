#!/usr/bin/env node
/**
 * Writes or shows the host's plan ceilings — `platform_settings.host_profile_json` (56-32).
 *
 *   node scripts/ops/host-profile.mjs --set '{"plan":"Business","ramMb":1536,"inodes":600000,...}'
 *   node scripts/ops/host-profile.mjs --show
 *
 * Fields (positive integers; any missing field keeps its planning value in the API):
 *   ramMb, loopLagMs, sockets, inodes, diskMb, dbConnections; plus `plan` (≤ 64 chars) and
 *   `measuredAt` (ISO date of the hPanel reading). See docs/ops/hostinger-profile.md.
 *
 * Env: DATABASE_MIGRATION_URL (the operator's migration credential; falls back to DATABASE_URL),
 * MYSQL (client binary, default `mysql`; `mariadb` on MariaDB-only hosts). The password travels in
 * MYSQL_PWD, never on the command line. The API only reads the setting.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs, parseDatabaseUrl, sqlString } from './backup-plan.mjs';

export const SETTING_KEY = 'host_profile_json';
const INT_FIELDS = ['ramMb', 'loopLagMs', 'sockets', 'inodes', 'diskMb', 'dbConnections'];

/** Validate and normalise a profile; throws with a one-line reason. */
export function normaliseProfile(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('--set needs a JSON object');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--set needs a JSON object');
  }
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (INT_FIELDS.includes(key)) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${key} must be a positive integer`);
      }
      out[key] = value;
    } else if (key === 'plan') {
      if (typeof value !== 'string' || value.length > 64) throw new Error('plan: ≤ 64 characters');
      out.plan = value;
    } else if (key === 'measuredAt') {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw new Error('measuredAt must be an ISO date');
      }
      out.measuredAt = value;
    } else {
      throw new Error(`unknown field: ${key}`);
    }
  }
  // `platform_settings.setting_value` is VARCHAR(255); a longer value would be refused (strict) or cut.
  if (JSON.stringify(out).length > 255) throw new Error('profile JSON must fit 255 characters');
  return out;
}

export function upsertSql(profile) {
  const value = sqlString(JSON.stringify(profile));
  return (
    `INSERT INTO platform_settings (setting_key, setting_value) VALUES (${sqlString(SETTING_KEY)}, ${value}) ` +
    'ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = CURRENT_TIMESTAMP(3);\n'
  );
}

function runMysql(db, sql, extra = []) {
  return execFileSync(
    process.env.MYSQL || 'mysql',
    [
      `--host=${db.host}`,
      `--port=${db.port}`,
      `--user=${db.user}`,
      `--database=${db.database}`,
      ...extra,
    ],
    {
      env: { ...process.env, MYSQL_PWD: db.password },
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2), { set: 'string', show: 'boolean' });
  const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL (or DATABASE_URL) is not set');
  const db = parseDatabaseUrl(url);
  if (args.set !== undefined) {
    const profile = normaliseProfile(args.set);
    runMysql(db, upsertSql(profile));
    console.log(`host_profile_json set: ${JSON.stringify(profile)}`);
    return;
  }
  if (args.show) {
    const out = runMysql(
      db,
      `SELECT setting_value FROM platform_settings WHERE setting_key = ${sqlString(SETTING_KEY)};\n`,
      ['--batch', '--skip-column-names', '--raw'],
    );
    console.log(out.trim() === '' ? '(not set — the API uses the planning values)' : out.trim());
    return;
  }
  throw new Error("pass --set '<json>' or --show");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`host-profile: ${err.message.split('\n')[0]}`);
    process.exit(1);
  }
}
