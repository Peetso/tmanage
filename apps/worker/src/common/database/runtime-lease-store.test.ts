import { describe, expect, it } from 'vitest';
import {
  CLAIM_LEASE_SQL,
  ENSURE_LEASE_SQL,
  READ_LEASE_SQL,
  RELEASE_LEASE_SQL,
  createLeaseStore,
} from './runtime-lease-store.js';

/**
 * DC-3 / RT-3. The statements and their bound values. What the WHERE does on a real server is
 * proven by `apps/api/test/rt-003-leader-lease.db.test.ts`.
 */

function recorder(answers: Record<string, unknown>) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const query = <T>(sql: string, params: readonly unknown[]): Promise<T> => {
    calls.push({ sql, params });
    return Promise.resolve(answers[sql] as T);
  };
  return { calls, store: createLeaseStore(query, () => Promise.resolve()) };
}

const NOW = new Date('2026-11-20T12:00:00.000Z');
const UNTIL = new Date('2026-11-20T12:00:30.000Z');

describe('RT-3 lease store', () => {
  it('binds every time as a JS Date and never asks the server for its clock', () => {
    for (const sql of [ENSURE_LEASE_SQL, CLAIM_LEASE_SQL, READ_LEASE_SQL, RELEASE_LEASE_SQL]) {
      expect(sql).not.toMatch(/current_timestamp|now\(|utc_timestamp|sysdate/iu);
    }
  });

  it('assigns holder LAST, so generation and acquired_at read the previous holder', () => {
    const set = CLAIM_LEASE_SQL.slice(
      CLAIM_LEASE_SQL.indexOf(' SET ') + 5,
      CLAIM_LEASE_SQL.indexOf(' WHERE '),
    ).trim();
    // The assignment targets, in order (an IF(...) argument is not a target).
    const targets = set.split(/, (?=[a-z_]+ = )/u).map((part) => part.split(' = ')[0]);
    expect(targets).toEqual(['generation', 'acquired_at', 'renewed_at', 'expires_at', 'holder']);
    expect(CLAIM_LEASE_SQL).toMatch(/WHERE name = \? AND \(holder = \? OR expires_at < \?\)$/u);
  });

  it('wins when the conditional UPDATE matched and the row names this copy', async () => {
    const { calls, store } = recorder({
      [CLAIM_LEASE_SQL]: { affectedRows: 1 },
      [READ_LEASE_SQL]: [{ holder: 'aaaa', generation: 3, expires_at: UNTIL }],
    });
    expect(await store.claim('leader', 'aaaa', NOW, UNTIL)).toEqual({ won: true, generation: 3 });
    expect(calls.map((c) => c.sql)).toEqual([ENSURE_LEASE_SQL, CLAIM_LEASE_SQL, READ_LEASE_SQL]);
    expect(calls[0]?.params).toEqual(['leader', '', new Date(0)]);
    expect(calls[1]?.params).toEqual([
      'aaaa', // generation = IF(holder = ?, ...)
      'aaaa', // acquired_at = IF(holder = ?, ...
      NOW, //   ... , ?)
      NOW, // renewed_at
      UNTIL, // expires_at
      'aaaa', // holder
      'leader', // WHERE name
      'aaaa', // holder = me
      NOW, // OR expires_at < now
    ]);
  });

  it('loses when nothing matched, and reports the live row', async () => {
    const { store } = recorder({
      [CLAIM_LEASE_SQL]: { affectedRows: 0 },
      [READ_LEASE_SQL]: [{ holder: 'bbbb', generation: 4, expires_at: UNTIL }],
    });
    expect(await store.claim('leader', 'aaaa', NOW, UNTIL)).toEqual({
      won: false,
      row: { holder: 'bbbb', generation: 4, expiresAt: UNTIL },
    });
  });

  it('does not count a match as a win when the row then names someone else', async () => {
    const { store } = recorder({
      [CLAIM_LEASE_SQL]: { affectedRows: 1 },
      [READ_LEASE_SQL]: [{ holder: 'bbbb', generation: 4, expires_at: UNTIL }],
    });
    expect((await store.claim('leader', 'aaaa', NOW, UNTIL)).won).toBe(false);
  });

  it('a release expires only its own row, just before now', async () => {
    const { calls, store } = recorder({});
    await store.release('leader', 'aaaa', NOW);
    expect(calls).toEqual([
      { sql: RELEASE_LEASE_SQL, params: [new Date(NOW.getTime() - 1), 'leader', 'aaaa'] },
    ]);
    expect(RELEASE_LEASE_SQL).toMatch(/WHERE name = \? AND holder = \?$/u);
  });

  it('lets a database error through, for the lease to classify', async () => {
    const store = createLeaseStore(
      () => Promise.reject(new Error('ECONNRESET')),
      () => Promise.resolve(),
    );
    await expect(store.claim('leader', 'aaaa', NOW, UNTIL)).rejects.toThrow('ECONNRESET');
  });
});
