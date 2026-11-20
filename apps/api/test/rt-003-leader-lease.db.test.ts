import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import {
  createLeaderLease,
  createLeaseStoreDatabase,
  createWorkerDatabase,
  LEADER_LEASE_NAME,
} from '@tmanage/worker';
import type { LeaseStore, WorkerDatabase } from '@tmanage/worker';
import { startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';

/**
 * DC-3 / RT-3 (lane K) — the leader lease on a real MariaDB 11.8, on the worker credential.
 *
 * What only this suite proves (the unit suites use an in-memory row):
 *
 * 1. **One winner.** Many copies claiming the same row at the same instant, each on its own
 *    connection: the conditional UPDATE matches for exactly one.
 * 2. **No takeover while live; takeover after expiry**, with `generation` raised and
 *    `acquired_at` set to the new holder's bound time; a renewal keeps both.
 * 3. **A clean release hands over at once.**
 * 4. **Times are the copy's bound JS Dates**, stored to the millisecond, whatever the server
 *    clock says (the admin pool's clock is SYSTEM, ARCH memory "Admin pool clock is SYSTEM").
 * 5. **The whole state machine** (`createLeaderLease`) over two real stores: one leads, the
 *    other follows and names it.
 */

let db: TestDatabase;
const databases: WorkerDatabase[] = [];

function store(): LeaseStore {
  const database = createWorkerDatabase({
    url: db.workerUrl,
    connectionLimit: 1,
    statementTimeoutMs: 15_000,
  });
  databases.push(database);
  return createLeaseStoreDatabase(database);
}

async function row(): Promise<RowDataPacket | undefined> {
  const [rows] = await db.admin.query<RowDataPacket[]>(
    "SELECT holder, generation, acquired_at, renewed_at, expires_at, DATE_FORMAT(expires_at, '%Y-%m-%d %H:%i:%s.%f') AS expires_text FROM runtime_leases WHERE name = ?",
    [LEADER_LEASE_NAME],
  );
  return rows[0];
}

const T0 = new Date('2031-03-04T05:06:07.089Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

beforeAll(async () => {
  db = await startTestDatabase();
}, 300_000);

beforeEach(async () => {
  await db.admin.query('DELETE FROM runtime_leases');
});

afterAll(async () => {
  await Promise.all(databases.map((d) => d.end()));
  await db?.stop();
});

describe('RT-3 leader lease on MariaDB', () => {
  it('twelve copies claiming at once: exactly one wins, every time', async () => {
    const copies = Array.from({ length: 12 }, () => store());
    for (let round = 0; round < 5; round += 1) {
      // Each round starts on an expired row, so every copy is eligible.
      const now = at(round * 60_000);
      const results = await Promise.all(
        copies.map((s, i) =>
          s.claim(LEADER_LEASE_NAME, `copy-${String(i)}`, now, at(round * 60_000 + 30_000)),
        ),
      );
      expect(results.filter((r) => r.won)).toHaveLength(1);
    }
  });

  it('holds while live, is taken after expiry with a new generation, and renewals keep it', async () => {
    const a = store();
    const b = store();
    expect(await a.claim(LEADER_LEASE_NAME, 'aaaa', T0, at(30_000))).toEqual({
      won: true,
      generation: 1,
    });
    // A renewal 10 s later: same generation, acquired_at unchanged, expiry moved.
    expect(await a.claim(LEADER_LEASE_NAME, 'aaaa', at(10_000), at(40_000))).toEqual({
      won: true,
      generation: 1,
    });
    let current = await row();
    expect((current?.['acquired_at'] as Date).toISOString()).toBe(T0.toISOString());
    expect((current?.['renewed_at'] as Date).toISOString()).toBe(at(10_000).toISOString());
    // B, while A's lease is live (expires at +40 s): refused, and told who holds it.
    const refused = await b.claim(LEADER_LEASE_NAME, 'bbbb', at(39_999), at(69_999));
    expect(refused.won).toBe(false);
    expect(refused.won === false && refused.row?.holder).toBe('aaaa');
    // B after the expiry: wins, generation 2, acquired now.
    expect(await b.claim(LEADER_LEASE_NAME, 'bbbb', at(40_001), at(70_001))).toEqual({
      won: true,
      generation: 2,
    });
    current = await row();
    expect(current?.['holder']).toBe('bbbb');
    expect((current?.['acquired_at'] as Date).toISOString()).toBe(at(40_001).toISOString());
    // A comes back: refused.
    expect((await a.claim(LEADER_LEASE_NAME, 'aaaa', at(50_000), at(80_000))).won).toBe(false);
  });

  it('a clean release hands over at once; a release by a non-holder changes nothing', async () => {
    const a = store();
    const b = store();
    await a.claim(LEADER_LEASE_NAME, 'aaaa', T0, at(30_000));
    await b.release(LEADER_LEASE_NAME, 'bbbb', at(1_000));
    expect((await b.claim(LEADER_LEASE_NAME, 'bbbb', at(2_000), at(32_000))).won).toBe(false);
    await a.release(LEADER_LEASE_NAME, 'aaaa', at(3_000));
    expect(await b.claim(LEADER_LEASE_NAME, 'bbbb', at(3_000), at(33_000))).toEqual({
      won: true,
      generation: 2,
    });
  });

  it('stores the bound times to the millisecond, independent of the server clock', async () => {
    const a = store();
    // A time far from the server's own clock: only a bound value can produce it.
    await a.claim(LEADER_LEASE_NAME, 'aaaa', T0, at(30_000));
    const current = await row();
    expect(current?.['expires_text']).toBe('2031-03-04 05:06:37.089000');
  });

  it('two copies of the state machine: one leads, the other follows and names it', async () => {
    const wall = { now: T0.getTime() };
    const lease = (holder: string) =>
      createLeaderLease({
        store: store(),
        holder,
        now: () => new Date(wall.now),
      });
    const a = lease('aaaa');
    const b = lease('bbbb');
    const [ta, tb] = await Promise.all([a.tick(), b.tick()]);
    const kinds = [ta.kind, tb.kind].sort();
    expect(kinds).toEqual(['follower', 'leader']);
    const leader = ta.kind === 'leader' ? a : b;
    const follower = leader === a ? tb : ta;
    expect(follower.kind === 'follower' && follower.holder).toBe(leader.holder);
    expect(leader.holds()).toBe(true);
    await leader.release();
    const next = leader === a ? b : a;
    expect((await next.tick()).kind).toBe('leader');
  });
});
