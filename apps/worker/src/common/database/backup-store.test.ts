import { describe, expect, it } from 'vitest';

import { BACKUP_SQL, createBackupSession } from './backup-store.js';
import type { BackupConnection } from './backup-store.js';

type Rows = readonly Record<string, unknown>[];

function fakeConnection(
  answer: (sql: string, params: readonly unknown[]) => Rows,
): BackupConnection & {
  asked: { sql: string; params: readonly unknown[] }[];
} {
  const asked: { sql: string; params: readonly unknown[] }[] = [];
  return {
    asked,
    query: (sql, params = []) => {
      asked.push({ sql, params });
      return Promise.resolve(answer(sql, params));
    },
    stream: (sql) => {
      asked.push({ sql, params: [] });
      return (async function* () {
        yield [Buffer.from('1')];
      })();
    },
    close: () => Promise.resolve(),
  };
}

describe('backup session (OFFSITE-BACKUP)', () => {
  it('reads the last OCI success and attempt from platform_backup_runs', async () => {
    const conn = fakeConnection(() => [
      {
        last_success: new Date('2026-11-19T03:00:00Z'),
        last_attempt: new Date('2026-11-19T03:00:00Z'),
      },
    ]);
    const times = await createBackupSession(conn, 'db', '11.8').offsiteRunTimes();
    expect(times.lastSuccessAt?.toISOString()).toBe('2026-11-19T03:00:00.000Z');
    expect(conn.asked[0]?.sql).toBe(BACKUP_SQL.runTimes);
    expect(BACKUP_SQL.runTimes).toContain("offsite_location LIKE 'oci:%'");
  });

  it('opens a read-only consistent snapshot before any dump read', async () => {
    const conn = fakeConnection(() => []);
    await createBackupSession(conn, 'db', '11.8').beginSnapshot();
    expect(conn.asked.map((a) => a.sql)).toEqual([
      'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
    ]);
  });

  it('refuses a routine or trigger whose body the credential cannot see', async () => {
    const conn = fakeConnection((sql) =>
      sql === BACKUP_SQL.triggers
        ? [{ name: 'trg' }]
        : sql.startsWith('SHOW CREATE TRIGGER')
          ? [{ Trigger: 'trg', sql_mode: '', 'SQL Original Statement': null }]
          : [],
    );
    const source = await createBackupSession(conn, 'db', '11.8').beginSnapshot();
    await expect(source.triggers()).rejects.toThrow(/missing privilege/u);
  });

  it('quotes identifiers in the SHOW CREATE and SELECT it builds', async () => {
    const conn = fakeConnection(() => [{ 'Create Table': 'CREATE TABLE `we``ird` (x int)' }]);
    const source = await createBackupSession(conn, 'db', '11.8').beginSnapshot();
    await source.createTable('we`ird');
    for await (const row of source.rows('we`ird', ['a`b'])) void row;
    expect(conn.asked.map((a) => a.sql)).toContain('SHOW CREATE TABLE `we``ird`');
    expect(conn.asked.map((a) => a.sql)).toContain('SELECT `a``b` FROM `we``ird`');
  });

  it('records a run with bound parameters, the error cut to the column width', async () => {
    const conn = fakeConnection(() => []);
    await createBackupSession(conn, 'db', '11.8').recordRun({
      id: 'r1',
      kind: 'scheduled',
      frequencyKind: 'daily',
      stamp: '20261120T030000Z',
      startedAt: new Date('2026-11-20T03:00:00Z'),
      finishedAt: new Date('2026-11-20T03:01:00Z'),
      status: 'failed',
      dbBytes: null,
      manifestSha: null,
      gitSha: null,
      offsiteStatus: 'failed',
      offsiteLocation: 'oci:b/db/20261120T030000Z/',
      offsiteAt: null,
      error: 'x'.repeat(900),
    });
    const insert = conn.asked[0];
    expect(insert?.sql).toBe(BACKUP_SQL.insertRun);
    expect(insert?.params).toHaveLength(14);
    expect(String(insert?.params[13])).toHaveLength(500);
  });
});
