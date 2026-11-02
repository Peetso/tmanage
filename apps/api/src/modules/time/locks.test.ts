import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { financeManagers, parseLockWindow } from './locks-rules.js';
import { TimeLocksService } from './locks.service.js';
import type { TimeLocksServiceOptions } from './locks.service.js';

/** 52-03 — period-lock rules over in-memory fakes (no database). */

const LOCK = '01890000-0000-7000-8000-0000000000aa';
const context = { organizationId: 'o1', userId: 'u1', membershipId: 'm1' } as TenantContext;
const principal = { kind: 'internal', role: 'owner' } as unknown as Principal;
const NOW = new Date('2026-11-02T09:00:00Z');
const openRow = { id: LOCK, periodStart: '2026-09-01', periodEnd: '2026-09-30', unlockedAt: null };

function harness(o: { overlap?: boolean; entries?: number; requested?: boolean } = {}) {
  let left = o.entries ?? 0;
  let stored = 0;
  const notices: string[] = [];
  const options = {
    now: () => NOW,
    batchSize: 2,
    database: { transaction: (_c: unknown, fn: never) => (fn as (t: unknown) => unknown)({}) },
    audit: { record: async () => ({}) },
    notifications: {
      insertForRecipient: async (_r: unknown, _c: unknown, n: { recipientUserId: string }) =>
        void notices.push(n.recipientUserId),
    },
    repository: {
      findOverlappingOpen: async () => (o.overlap ? [openRow] : []),
      findByStart: async () => null,
      insert: async () => LOCK,
      stampBatch: async () => {
        const picked = Math.min(2, left);
        left -= picked;
        return { picked, changed: picked };
      },
      setEntriesLocked: async (_r: unknown, _c: unknown, _i: string, n: number) =>
        void (stored = n),
      findById: async () => ({
        ...openRow,
        lockedAt: NOW,
        unlockedAt: null,
        entriesLocked: stored,
      }),
      unlockRequestedSince: async () => o.requested ?? false,
      financeCandidates: async () => [
        { userId: 'u1', role: 'owner', customCapabilitiesJson: null },
        { userId: 'u2', role: 'org_admin', customCapabilitiesJson: null },
        { userId: 'u3', role: 'member', customCapabilitiesJson: null },
      ],
    },
  } as unknown as TimeLocksServiceOptions;
  return { service: new TimeLocksService(options), notices };
}

describe('52-03 period locks', () => {
  it('accepts whole calendar months only, within five years', () => {
    expect(parseLockWindow('2026-02-01', '2026-03-31', NOW)).toEqual({
      periodStart: '2026-02-01',
      periodEnd: '2026-03-31',
    });
    for (const [s, e] of [
      ['2026-02-02', '2026-02-28'],
      ['2026-02-01', '2026-02-27'],
      ['2026-03-01', '2026-02-28'],
      ['2020-01-01', '2020-01-31'],
    ]) {
      expect(() => parseLockWindow(s, e, NOW)).toThrow();
    }
  });

  it('refuses a window that overlaps an open lock with 409 period_overlaps', async () => {
    const body = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
    await expect(
      harness({ overlap: true }).service.lock(context, principal, body),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('stamps entries in batches and stores the count', async () => {
    const body = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };
    const view = await harness({ entries: 5 }).service.lock(context, principal, body);
    expect(view.entriesLocked).toBe(5);
  });

  it('requires a reason of 3..500 characters to unlock', async () => {
    await expect(
      harness().service.unlock(context, principal, LOCK, { reason: ' x ' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('notifies exactly the finance.manage holders, not the requester', async () => {
    const h = harness();
    await h.service.requestUnlock(context, principal, LOCK, { reason: 'typo on the 3rd' });
    expect(h.notices).toEqual(['u2']);
    expect(
      financeManagers([{ userId: 'c', role: 'client_admin', customCapabilitiesJson: null }]),
    ).toEqual([]);
  });

  it('allows one unlock request per member per lock per 24 h', async () => {
    await expect(
      harness({ requested: true }).service.requestUnlock(context, principal, LOCK, {
        reason: 'again',
      }),
    ).rejects.toMatchObject({ status: 429 });
  });
});
