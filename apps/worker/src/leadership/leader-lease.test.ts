import { describe, expect, it } from 'vitest';
import type { ClaimResult, LeaseRow, LeaseStore } from '../common/database/runtime-lease-store.js';
import { createLeaderLease, newLeaseHolder } from './leader-lease.js';

/**
 * DC-3 / RT-3. The lease state machine over an in-memory store with the row's semantics
 * (`WHERE holder = me OR expires_at < now`), two copies of the app sharing it, and injected
 * clocks. The real SQL is proven on MariaDB by `apps/api/test/rt-003-leader-lease.db.test.ts`.
 */

interface Clock {
  wall: number;
  mono: number;
}

function memoryStore(): LeaseStore & { row: LeaseRow | null; fail: boolean } {
  const state: { row: LeaseRow | null; fail: boolean } = { row: null, fail: false };
  return {
    get row() {
      return state.row;
    },
    set row(value) {
      state.row = value;
    },
    get fail() {
      return state.fail;
    },
    set fail(value) {
      state.fail = value;
    },
    claim(_name, holder, now, expiresAt): Promise<ClaimResult> {
      if (state.fail) return Promise.reject(new Error('connection lost'));
      const row = state.row;
      if (row === null || row.holder === holder || row.expiresAt.getTime() < now.getTime()) {
        const generation =
          row === null ? 1 : row.holder === holder ? row.generation : row.generation + 1;
        state.row = { holder, generation, expiresAt };
        return Promise.resolve({ won: true, generation });
      }
      return Promise.resolve({ won: false, row });
    },
    release(_name, holder, now) {
      if (state.fail) return Promise.reject(new Error('connection lost'));
      if (state.row?.holder === holder) {
        state.row = { ...state.row, expiresAt: new Date(now.getTime() - 1) };
      }
      return Promise.resolve();
    },
    end: () => Promise.resolve(),
  };
}

function copy(store: LeaseStore, clock: Clock, holder: string) {
  return createLeaderLease({
    store,
    holder,
    ttlMs: 30_000,
    renewEveryMs: 10_000,
    now: () => new Date(clock.wall),
    monotonic: () => clock.mono,
  });
}

function advance(clock: Clock, ms: number): void {
  clock.wall += ms;
  clock.mono += ms;
}

describe('RT-3 leader lease', () => {
  it('lets exactly one of two copies lead; the other follows and names the holder', async () => {
    const store = memoryStore();
    const clock = { wall: Date.UTC(2026, 10, 20, 12), mono: 1_000 };
    const a = copy(store, clock, 'aaaa');
    const b = copy(store, clock, 'bbbb');
    expect(await a.tick()).toEqual({ kind: 'leader', generation: 1, changed: true });
    expect(await b.tick()).toEqual({ kind: 'follower', holder: 'aaaa', changed: true });
    expect(a.holds()).toBe(true);
    expect(b.holds()).toBe(false);
    // Renewals keep it; the follower keeps following, and says nothing new.
    for (let i = 0; i < 5; i += 1) {
      advance(clock, 10_000);
      expect(await a.tick()).toEqual({ kind: 'leader', generation: 1, changed: false });
      expect(await b.tick()).toEqual({ kind: 'follower', holder: 'aaaa', changed: false });
    }
  });

  it('a follower takes over only after the lease expired, with a new generation', async () => {
    const store = memoryStore();
    const clock = { wall: Date.UTC(2026, 10, 20, 12), mono: 1_000 };
    const a = copy(store, clock, 'aaaa');
    const b = copy(store, clock, 'bbbb');
    await a.tick();
    // A dies (stops renewing). Before the expiry B still follows...
    advance(clock, 29_999);
    expect((await b.tick()).kind).toBe('follower');
    // ...after it, B leads.
    advance(clock, 2);
    expect(await b.tick()).toEqual({ kind: 'leader', generation: 2, changed: true });
    expect(b.holds()).toBe(true);
  });

  it('a holder stops trusting its lease one renewal period before anyone can take it', async () => {
    const store = memoryStore();
    const clock = { wall: Date.UTC(2026, 10, 20, 12), mono: 1_000 };
    const a = copy(store, clock, 'aaaa');
    await a.tick();
    advance(clock, 19_999);
    expect(a.holds()).toBe(true);
    advance(clock, 1);
    // ttl − renewEvery = 20 s: no new pass may start, while the row is live for 10 s more.
    expect(a.holds()).toBe(false);
    expect(store.row?.expiresAt.getTime()).toBe(clock.wall + 10_000);
  });

  it('the deadline is taken before the statement: a slow claim shortens the window', async () => {
    const store = memoryStore();
    const clock = { wall: Date.UTC(2026, 10, 20, 12), mono: 1_000 };
    const slow: LeaseStore = {
      ...store,
      claim: async (...args) => {
        const result = await store.claim(...args);
        clock.mono += 15_000; // the answer arrives 15 s later
        return result;
      },
    };
    const a = copy(slow, clock, 'aaaa');
    expect((await a.tick()).kind).toBe('leader');
    advance(clock, 4_999);
    expect(a.holds()).toBe(true);
    advance(clock, 1);
    expect(a.holds()).toBe(false);
  });

  it('a database error is its own outcome: never leader, and a held lease keeps its deadline', async () => {
    const store = memoryStore();
    const clock = { wall: Date.UTC(2026, 10, 20, 12), mono: 1_000 };
    const a = copy(store, clock, 'aaaa');
    const b = copy(store, clock, 'bbbb');
    store.fail = true;
    const first = await b.tick();
    expect(first.kind).toBe('error');
    expect(first.kind === 'error' && first.holds).toBe(false);
    expect(b.holds()).toBe(false);
    store.fail = false;
    await a.tick();
    store.fail = true;
    advance(clock, 10_000);
    const renew = await a.tick();
    expect(renew).toMatchObject({ kind: 'error', holds: true });
    advance(clock, 10_000);
    expect(a.holds()).toBe(false);
  });

  it('a clean release hands the lease over at once', async () => {
    const store = memoryStore();
    const clock = { wall: Date.UTC(2026, 10, 20, 12), mono: 1_000 };
    const a = copy(store, clock, 'aaaa');
    const b = copy(store, clock, 'bbbb');
    await a.tick();
    await a.release();
    expect(a.holds()).toBe(false);
    expect(await b.tick()).toEqual({ kind: 'leader', generation: 2, changed: true });
  });

  it('a follower release touches nothing', async () => {
    const store = memoryStore();
    const clock = { wall: Date.UTC(2026, 10, 20, 12), mono: 1_000 };
    const a = copy(store, clock, 'aaaa');
    const b = copy(store, clock, 'bbbb');
    await a.tick();
    await b.tick();
    await b.release();
    expect(store.row?.holder).toBe('aaaa');
    expect(a.holds()).toBe(true);
  });

  it('refuses a renewal period that would let a healthy holder lapse', () => {
    expect(() =>
      createLeaderLease({ store: memoryStore(), holder: 'x', ttlMs: 20_000, renewEveryMs: 10_000 }),
    ).toThrow(RangeError);
  });

  it('holder tags are opaque and distinct', () => {
    const a = newLeaseHolder();
    expect(a).toMatch(/^[0-9a-f]{12}$/u);
    expect(newLeaseHolder()).not.toBe(a);
  });
});
