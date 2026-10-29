import { describe, expect, it, vi } from 'vitest';
import { endExpiredSupportSession } from '../common/database/support-session-sweep-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import { membershipExitFor, sweepSupportSessions } from './support-session-sweeper.js';
import type {
  ExpiredSupportSession,
  MembershipExit,
  SupportSessionSweepStore,
} from './support-session-sweeper.js';

/** platform-admin v2 · PA-05 — the Support-session expiry sweeper. */

function session(overrides: Partial<ExpiredSupportSession> = {}): ExpiredSupportSession {
  return {
    id: 'sess-1',
    adminUserId: 'admin-1',
    organizationId: 'org-1',
    membershipId: 'mem-1',
    previousRole: null,
    previousHasOrgWideScope: null,
    actionsCount: 7,
    ...overrides,
  };
}

function fakeStore(rows: readonly ExpiredSupportSession[], alreadyEnded = new Set<string>()) {
  const ended: { session: ExpiredSupportSession; exit: MembershipExit }[] = [];
  const store: SupportSessionSweepStore = {
    listExpired: vi.fn(async () => rows),
    endExpired: vi.fn(async (s: ExpiredSupportSession, exit: MembershipExit) => {
      if (alreadyEnded.has(s.id)) return false;
      ended.push({ session: s, exit });
      return true;
    }),
  };
  return { store, ended };
}

describe('the support-session sweeper', () => {
  it('ends expired sessions and offboards their hidden rows', async () => {
    const { store, ended } = fakeStore([session()]);
    const result = await sweepSupportSessions(store);
    expect(result).toEqual({ ended: 1, offboarded: 1, restored: 0 });
    expect(ended[0]?.exit).toEqual({ kind: 'offboard', membershipId: 'mem-1' });
  });

  it("restores an upgraded row to the admin's own role, status and scope", async () => {
    const { store, ended } = fakeStore([
      session({ previousRole: 'org_admin', previousHasOrgWideScope: true }),
      session({ id: 'sess-2', previousRole: 'offboarded:member', previousHasOrgWideScope: false }),
    ]);
    const result = await sweepSupportSessions(store);
    expect(result).toEqual({ ended: 2, offboarded: 0, restored: 2 });
    expect(ended[0]?.exit).toEqual({
      kind: 'restore',
      membershipId: 'mem-1',
      role: 'org_admin',
      status: 'active',
      hasOrgWideScope: true,
    });
    expect(ended[1]?.exit).toMatchObject({ role: 'member', status: 'offboarded' });
  });

  it('skips a session someone else ended first', async () => {
    const { store } = fakeStore([session()], new Set(['sess-1']));
    expect(await sweepSupportSessions(store)).toEqual({ ended: 0, offboarded: 0, restored: 0 });
  });

  it('has nothing to do for a session without a membership', () => {
    expect(membershipExitFor(session({ membershipId: null }))).toEqual({ kind: 'none' });
  });

  it('bumps policy_version and writes both audit rows in the transaction', async () => {
    const statements: string[] = [];
    const tx: WorkerTransaction = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        return { affectedRows: 1 } as never;
      }),
    };
    const done = await endExpiredSupportSession(tx, session(), {
      kind: 'offboard',
      membershipId: 'mem-1',
    });
    expect(done).toBe(true);
    expect(statements.some((s) => s.includes("SET status = 'offboarded'"))).toBe(true);
    expect(statements.some((s) => s.includes('policy_version = policy_version + 1 WHERE id'))).toBe(
      true,
    );
    expect(statements.some((s) => s.includes("'support.session_ended'"))).toBe(true);
    expect(statements.some((s) => s.includes("'platform.support_session_ended'"))).toBe(true);
  });

  it('writes nothing when the row was already ended', async () => {
    const tx: WorkerTransaction = { query: vi.fn(async () => ({ affectedRows: 0 }) as never) };
    expect(await endExpiredSupportSession(tx, session(), { kind: 'none' })).toBe(false);
    expect(tx.query).toHaveBeenCalledTimes(1);
  });
});
