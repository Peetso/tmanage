import { describe, expect, it } from 'vitest';
import { REQUEST_REOPENED_NOTICE, sweepDeferredRequests } from './request-defer-sweeper.js';
import { reopenDueDeferredRequests } from '../common/database/request-defer-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';

/**
 * A7 (0220): the defer sweep. The store's statements run against a recording fake transaction —
 * the predicate, the guarded update and the reminder notice are what this proves; MariaDB itself
 * is the chain's.
 */

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakeTx(due: readonly Record<string, unknown>[], updated = 1) {
  const calls: Recorded[] = [];
  const tx: WorkerTransaction = {
    query: async <T>(sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT')) return due as T;
      if (sql.includes('UPDATE')) return { affectedRows: updated } as T;
      return { affectedRows: 1 } as T;
    },
  };
  return { tx, calls };
}

describe('A7 request defer sweep', () => {
  it('reopens due deferred requests by the database clock and reminds the deferrer', async () => {
    const { tx, calls } = fakeTx([
      {
        id: 'req-1',
        organization_id: 'org-1',
        version: 4,
        reopen_reminder: 1,
        deferred_by_user_id: 'user-mona',
      },
      {
        id: 'req-2',
        organization_id: 'org-2',
        version: '7',
        reopen_reminder: 0,
        deferred_by_user_id: 'user-sami',
      },
    ]);

    const reopened = await reopenDueDeferredRequests(tx, REQUEST_REOPENED_NOTICE);

    expect(calls[0]?.sql).toMatch(/state = 'deferred'/);
    expect(calls[0]?.sql).toMatch(/defer_until <= current_timestamp\(3\)/);
    expect(calls[0]?.sql).toMatch(/FOR UPDATE/);
    const updates = calls.filter((call) => call.sql.includes('UPDATE client_requests'));
    expect(updates.map((call) => call.params)).toEqual([
      ['org-1', 'req-1', 4],
      ['org-2', 'req-2', 7],
    ]);
    expect(updates[0]?.sql).toMatch(/SET state = 'triage', defer_until = NULL/);

    const notices = calls.filter(
      (call) => call.sql.includes('INSERT') && call.sql.includes('notifications'),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.params.slice(1)).toEqual([
      'org-1',
      'user-mona',
      'client_request.reopened.v1',
      'client_request',
      'req-1',
      'client_request.reopened:req-1:5',
    ]);
    expect(reopened.map((request) => request.remindUserId)).toEqual(['user-mona', null]);
  });

  it('skips a row a manager reopened first, and tells nobody about it', async () => {
    const { tx, calls } = fakeTx(
      [
        {
          id: 'req-1',
          organization_id: 'org-1',
          version: 4,
          reopen_reminder: 1,
          deferred_by_user_id: 'user-mona',
        },
      ],
      0,
    );
    expect(await reopenDueDeferredRequests(tx, REQUEST_REOPENED_NOTICE)).toEqual([]);
    expect(calls.some((call) => call.sql.includes('INSERT'))).toBe(false);
  });

  it('reports what one run moved, and nothing when nothing is due', async () => {
    const result = await sweepDeferredRequests({
      reopenDue: async () => [
        { id: 'a', organizationId: 'o', version: 2, remindUserId: 'u' },
        { id: 'b', organizationId: 'o', version: 3, remindUserId: null },
      ],
    });
    expect(result).toEqual({ reopened: 2, reminded: 1 });
    expect(await sweepDeferredRequests({ reopenDue: async () => [] })).toEqual({
      reopened: 0,
      reminded: 0,
    });
  });
});
