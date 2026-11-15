import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { insertNotification } from './notifications-store.js';
import type { WorkerTransaction } from './worker-database.js';

/**
 * 2026-11-15 nudge-flood guard. mysql2 connects with `CLIENT_FOUND_ROWS`, so the affected-rows of
 * an `INSERT … ON DUPLICATE KEY UPDATE` is 1 both for a fresh row and for a collision that changed
 * nothing: it can never say "this call created the row". The rule: no source file in the API or
 * the worker reads `affectedRows` from an upsert. A claim reads its own generated id back, as
 * `insertNotification` does. (`INSERT IGNORE` is fine: an ignored duplicate reports 0.)
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const SCANNED = ['apps/api/src', 'apps/worker/src'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.ts$/.test(name) && !/\.test\.ts$|test-fakes\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/**
 * Line numbers (1-based) where an upsert's result is read for `affectedRows`. An upsert is a
 * drizzle `.onDuplicateKeyUpdate(` or an SQL text with `ON DUPLICATE KEY UPDATE`, inline or in a
 * named constant later passed to `query(`. The statement around it is the text from the last
 * `const x = await` / `await` / `return` before it to the next `;`; it is flagged when it reads
 * `.affectedRows` itself, or when its variable's `affectedRows` is read in the next 15 lines.
 */
function upsertAffectedRowsReads(source: string): number[] {
  const sites: number[] = [];
  const upsert = /\.onDuplicateKeyUpdate\(|ON DUPLICATE KEY UPDATE/gi;
  const named = new Set<string>();
  for (const m of source.matchAll(/const\s+(\w+)\s*=\s*`[^`]*ON DUPLICATE KEY UPDATE[^`]*`/gi)) {
    if (m[1] !== undefined) named.add(m[1]);
  }
  for (const m of source.matchAll(upsert)) {
    const before = source.slice(0, m.index);
    const inNamedConst = /const\s+\w+\s*=\s*`[^`]*$/.test(before);
    if (!inNamedConst) sites.push(m.index);
  }
  for (const name of named) {
    for (const m of source.matchAll(new RegExp(`query(?:<[^>(]*>)?\\(\\s*${name}\\b`, 'g'))) {
      sites.push(m.index);
    }
  }
  const flagged = new Set<number>();
  for (const at of sites) {
    const head = source.slice(0, at);
    const start = Math.max(
      head.lastIndexOf('await '),
      head.lastIndexOf('return '),
      head.lastIndexOf('const '),
    );
    const end = source.indexOf(';', at);
    const statement = source.slice(start, end === -1 ? undefined : end + 1);
    // `const x = await …upsert…` with no `;` in between: x holds the upsert's result.
    const variable = /^const\s+(\w+)\s*=[^;]*$/.exec(
      source.slice(head.lastIndexOf('const '), at),
    )?.[1];
    const after = source
      .slice(end + 1)
      .split('\n')
      .slice(0, 15)
      .join('\n');
    const readsDirectly = /\.affectedRows/.test(statement.slice(statement.indexOf('(')));
    const readsLater =
      variable !== undefined &&
      new RegExp(`\\b${variable}(\\[0\\])?\\??\\.affectedRows\\b`).test(after);
    if (readsDirectly || readsLater) flagged.add(source.slice(0, at).split('\n').length);
  }
  return [...flagged].sort((a, b) => a - b);
}

describe('upsert affected-rows guard (2026-11-15)', () => {
  it('flags the pattern that caused the flood, and not a read-back or an INSERT IGNORE', () => {
    const old = [
      'const result = await tx.query<{ affectedRows: number }>(',
      '  `INSERT INTO notifications (id) VALUES (?) ON DUPLICATE KEY UPDATE id = id`,',
      '  [id],',
      ');',
      'return result.affectedRows === 1;',
    ].join('\n');
    expect(upsertAffectedRowsReads(old)).toEqual([2]);
    const drizzle = [
      'const result = await db.insert(t).values(v)',
      '  .onDuplicateKeyUpdate({ set: { id: sql`id` } });',
      'return result[0].affectedRows > 0;',
    ].join('\n');
    expect(upsertAffectedRowsReads(drizzle)).toEqual([2]);
    const named = [
      'const UPSERT = `INSERT INTO x (a) VALUES (?) ON DUPLICATE KEY UPDATE a = a`;',
      'async function f(tx) {',
      '  const r = await tx.query(UPSERT, [1]);',
      '  return r.affectedRows === 1;',
      '}',
    ].join('\n');
    expect(upsertAffectedRowsReads(named)).toEqual([3]);
    const fixed = [
      'await tx.query(`INSERT INTO n (id) VALUES (?) ON DUPLICATE KEY UPDATE id = id`, [id]);',
      "const mine = await tx.query('SELECT id FROM n WHERE id = ?', [id]);",
      'return mine.length === 1;',
    ].join('\n');
    expect(upsertAffectedRowsReads(fixed)).toEqual([]);
    const ignore = [
      'const claim = await tx.query(`INSERT IGNORE INTO f (k) VALUES (?)`, [k]);',
      'if (claim.affectedRows !== 1) return;',
    ].join('\n');
    expect(upsertAffectedRowsReads(ignore)).toEqual([]);
  });

  it('no API or worker source reads affectedRows from an upsert', () => {
    const offenders: string[] = [];
    for (const dir of SCANNED) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        for (const line of upsertAffectedRowsReads(readFileSync(file, 'utf8'))) {
          offenders.push(`${relative(ROOT, file).replaceAll('\\', '/')}:${String(line)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Reads every API and worker source file (~6-9 s while the other suites run in parallel).
  }, 60_000);

  it('insertNotification says "fresh" once when the driver reports found rows', async () => {
    const ids = new Map<string, string>();
    const tx: WorkerTransaction = {
      query: <T>(sql: string, params: readonly unknown[] = []): Promise<T> => {
        if (/^INSERT INTO notifications/.test(sql.trim())) {
          const [id, org, user, , , , key] = params.map(String);
          const identity = `${String(org)}|${String(user)}|${String(key)}`;
          if (!ids.has(identity)) ids.set(identity, String(id));
          return Promise.resolve({ affectedRows: 1 } as T); // CLIENT_FOUND_ROWS: 1 either way
        }
        const wanted = params[1];
        return Promise.resolve(
          [...ids.values()].filter((v) => v === wanted).map((v) => ({ id: v })) as T,
        );
      },
    };
    const input = {
      organizationId: 'o1',
      recipientUserId: 'u1',
      type: 'notification.digest_sent',
      objectType: 'membership',
      objectId: 'm1',
      dedupeKey: 'digest:daily:2026-11-15',
    };
    expect(await insertNotification(tx, input)).toBe(true);
    expect(await insertNotification(tx, input)).toBe(false);
  });
});
