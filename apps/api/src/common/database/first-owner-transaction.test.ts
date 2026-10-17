import type { Pool, PoolConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { FirstOwnerLockUnavailableError, TenantDatabase } from './tenant-context.js';

/** A fake pool whose one connection records every call in order. No database involved. */
function fakeDatabase(lockResult: number | null) {
  const calls: string[] = [];
  const connection = {
    query: (options: unknown) => {
      const sql = typeof options === 'string' ? options : (options as { sql: string }).sql;
      calls.push(sql.startsWith('SELECT GET_LOCK') ? 'GET_LOCK' : sql);
      if (sql.startsWith('SELECT GET_LOCK')) {
        return Promise.resolve([[{ acquired: lockResult }], []]);
      }
      if (sql.startsWith('SELECT RELEASE_LOCK')) {
        calls[calls.length - 1] = 'RELEASE_LOCK';
      }
      return Promise.resolve([[], []]);
    },
    beginTransaction: () => {
      calls.push('beginTransaction');
      return Promise.resolve();
    },
    commit: () => {
      calls.push('commit');
      return Promise.resolve();
    },
    rollback: () => {
      calls.push('rollback');
      return Promise.resolve();
    },
    release: () => {
      calls.push('release');
    },
  } as unknown as PoolConnection;
  const pool = { getConnection: () => Promise.resolve(connection) } as unknown as Pool;
  return { calls, db: new TenantDatabase(pool, { guardMode: 'enforce' }) };
}

const options = {
  correlationId: 'test-correlation',
  lockName: 'tmanage.first_owner',
  lockTimeoutSeconds: 5,
};

describe('TenantDatabase.firstOwnerTransaction', () => {
  it('takes the lock before BEGIN and releases it after COMMIT, then the connection', async () => {
    const { calls, db } = fakeDatabase(1);
    const result = await db.firstOwnerTransaction(options, (scope) => {
      calls.push('work');
      expect(typeof scope.tenant).toBe('function');
      return Promise.resolve('created');
    });
    expect(result).toBe('created');
    expect(calls).toEqual([
      'GET_LOCK',
      'beginTransaction',
      'work',
      'commit',
      'RELEASE_LOCK',
      'release',
    ]);
  });

  it('throws FirstOwnerLockUnavailableError without beginning a transaction when the lock is busy', async () => {
    const { calls, db } = fakeDatabase(0);
    let workRan = false;
    await expect(
      db.firstOwnerTransaction(options, () => {
        workRan = true;
        return Promise.resolve();
      }),
    ).rejects.toBeInstanceOf(FirstOwnerLockUnavailableError);
    expect(workRan).toBe(false);
    expect(calls).not.toContain('beginTransaction');
    expect(calls).toEqual(['GET_LOCK', 'release']);
  });
});
