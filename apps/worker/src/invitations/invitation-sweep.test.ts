import { describe, expect, it } from 'vitest';
import { sweepOverdueInvitations } from './invitation-sweep.js';
import type { InvitationSweepStore } from './invitation-sweep.js';

/**
 * ON-04 / TEN-003 §4: the sweep over a fake store. The DB-clock comparison lives in the store's
 * SQL (`invitations-sweep-store.ts`, proved by the UNEXECUTED db case); this fake reproduces the
 * same predicate in memory so the command's contract holds without a database.
 */
interface Row {
  status: string;
  expiresAt: number;
}
function fakeStore(rows: Row[], now: number): InvitationSweepStore {
  return {
    expireOverdue: async () =>
      rows
        .filter((r) => r.status === 'pending' && r.expiresAt <= now)
        .map((r) => (r.status = 'expired')).length,
  };
}

describe('sweepOverdueInvitations', () => {
  it('expires only overdue pending rows, reports the count, and a second run is a no-op', async () => {
    const rows: Row[] = [
      { status: 'pending', expiresAt: 10 }, // overdue -> expired
      { status: 'pending', expiresAt: 30 }, // not yet due -> kept
      { status: 'accepted', expiresAt: 10 }, // never touched
      { status: 'revoked', expiresAt: 5 }, // never touched
    ];
    const store = fakeStore(rows, 20);
    expect((await sweepOverdueInvitations(store)).expired).toBe(1);
    expect(rows.map((r) => r.status)).toEqual(['expired', 'pending', 'accepted', 'revoked']);
    expect((await sweepOverdueInvitations(store)).expired).toBe(0); // idempotent (§3)
  });
});
