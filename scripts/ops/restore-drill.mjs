#!/usr/bin/env node
/**
 * Monthly restore drill (51-09 OPS-02, 56-12 REL-09, 56-29 REL-12): dry run, apply, row counts,
 * ledger match, timing, then empty the scratch database again — one command, one transcript.
 *
 *   node scripts/ops/restore-drill.mjs --from <backup dir> --target mysql://u:p@h/<db>_restore \
 *     [--identity <age key file>] [--uploads <scratch dir>] [--report drill.md] [--keep]
 *
 * Env: DATABASE_URL — when set, the drill is recorded as a `drill` row in `platform_backup_runs`
 * of that (live) database; MYSQL, BACKUP_AGE_IDENTITY_FILE as for restore.mjs.
 *
 * The target must be a scratch database: its name has to contain `restore` or `test` (no
 * `--i-know` here, ever), because the drill drops every table in it at the end unless `--keep`.
 * Use the **off-site** copy for the monthly drill (REL-12): download the newest stamp folder from
 * the Ops Drive and pass it as `--from`. Exit 0 drill passed, 1 failed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  backupRunInsertSql,
  checkTargetName,
  parseArgs,
  parseDatabaseUrl,
} from './backup-plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = process.env.MYSQL || 'mysql';
const COUNTED = ['organizations', 'users', 'work_items'];

function sql(db, statement) {
  return execFileSync(
    CLIENT,
    [
      `--host=${db.host}`,
      `--port=${db.port}`,
      `--user=${db.user}`,
      `--database=${db.database}`,
      '-N',
      '-B',
    ],
    { env: { ...process.env, MYSQL_PWD: db.password }, input: statement, encoding: 'utf8' },
  );
}

function restore(args, apply) {
  const argv = [
    join(HERE, 'restore.mjs'),
    '--from',
    args.from,
    '--target',
    args.target,
    '--uploads',
    args.uploads,
  ];
  if (args.identity) argv.push('--identity', args.identity);
  if (apply) argv.push('--apply');
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Drops every table and view of the scratch database (triggers go with their tables). */
function emptyDatabase(db) {
  const rows = sql(
    db,
    'SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE();',
  )
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
  if (rows.length === 0) return 0;
  const quote = (n) => `\`${n.replace(/`/g, '``')}\``;
  const views = rows.filter(([, t]) => t === 'VIEW').map(([n]) => quote(n));
  const tables = rows.filter(([, t]) => t !== 'VIEW').map(([n]) => quote(n));
  let stmt = 'SET FOREIGN_KEY_CHECKS = 0;\n';
  if (views.length) stmt += `DROP VIEW IF EXISTS ${views.join(', ')};\n`;
  if (tables.length) stmt += `DROP TABLE IF EXISTS ${tables.join(', ')};\n`;
  sql(db, stmt);
  return rows.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    from: 'string',
    target: 'string',
    identity: 'string',
    uploads: 'string',
    report: 'string',
    keep: 'boolean',
  });
  if (!args.from || !args.target)
    throw new Error('--from <backup dir> and --target <url> are required');
  const target = parseDatabaseUrl(args.target);
  const guard = checkTargetName(target.database, false);
  if (!guard.ok) throw new Error(guard.reason);
  const scratchUploads = !args.uploads;
  args.uploads ??= mkdtempSync(join(tmpdir(), 'tm-drill-uploads-'));

  const startedAt = new Date();
  const lines = [
    `# Restore drill ${startedAt.toISOString()}`,
    '',
    `- backup: \`${resolve(args.from)}\``,
  ];
  lines.push(`- target: \`${target.user}@${target.host}:${target.port}/${target.database}\``);
  const step = (name, ok, detail = '') => {
    lines.push(`- ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
    return ok;
  };

  let passed = false;
  let error = null;
  try {
    const leftover = emptyDatabase(target);
    step(
      'scratch database empty',
      true,
      leftover ? `${leftover} leftover object(s) dropped first` : 'was empty',
    );
    const dry = restore(args, false);
    if (!step('dry run', dry.code === 0, dry.out.split('\n').pop())) throw new Error(dry.out);
    const t0 = Date.now();
    const applied = restore(args, true);
    const minutes = ((Date.now() - t0) / 60000).toFixed(1);
    if (
      !step(
        'apply + ledger match',
        applied.code === 0,
        `${minutes} min; ${applied.out.split('\n').pop()}`,
      )
    ) {
      throw new Error(applied.out);
    }
    const counts = COUNTED.map(
      (t) => `${t}=${sql(target, `SELECT COUNT(*) FROM \`${t}\`;`).trim()}`,
    );
    step('row counts', true, counts.join(', '));
    passed = true;
  } catch (err) {
    error = err.message.split('\n').slice(-3).join(' ');
  } finally {
    if (!args.keep) {
      try {
        step('scratch database dropped', true, `${emptyDatabase(target)} object(s)`);
      } catch (err) {
        step('scratch database dropped', false, err.message.split('\n')[0]);
      }
    }
    if (scratchUploads) rmSync(args.uploads, { recursive: true, force: true });
  }

  const finishedAt = new Date();
  const total = ((finishedAt - startedAt) / 60000).toFixed(1);
  lines.push('', `**Result: ${passed ? 'PASSED' : 'FAILED'}** in ${total} min (RTO target 4 h).`);
  if (error) lines.push('', `Error: ${error}`);
  const report =
    args.report ??
    join(resolve(args.from), '..', `drill-${startedAt.toISOString().slice(0, 10)}.md`);
  writeFileSync(report, `${lines.join('\n')}\n`);
  console.log(`Drill ${passed ? 'passed' : 'FAILED'}; transcript ${report}`);

  if (process.env.DATABASE_URL) {
    try {
      sql(
        parseDatabaseUrl(process.env.DATABASE_URL),
        backupRunInsertSql({
          id: randomUUID(),
          kind: 'drill',
          frequencyKind: 'drill',
          startedAt,
          finishedAt,
          status: passed ? 'ok' : 'failed',
          offsiteStatus: 'not_requested',
          error,
        }),
      );
    } catch (err) {
      console.warn(`warning: drill not recorded (${err.message.split('\n')[0]})`);
    }
  }
  return passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`restore drill failed: ${err.message}`);
    process.exit(1);
  },
);
