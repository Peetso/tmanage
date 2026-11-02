import { describe, expect, it } from 'vitest';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformTeamRow } from '../platform-admins.repository.js';
import type { AccessReviewStore } from './access-review.repository.js';
import { AccessReviewService, parseMonth } from './access-review.service.js';

const NOW = new Date('2026-11-02T09:00:00.000Z');
const id = (n: number) => `0190a000-0000-7000-8000-00000000000${String(n)}`;
const OCT = new Date('2026-10-10T10:00:00.000Z');
const teamRow = (n: number, over: Partial<PlatformTeamRow> = {}): PlatformTeamRow => ({
  ...{ id: id(n), userId: id(n), preset: 'support', permissions: [], customPermissions: null },
  ...{ status: 'active' },
  ...{ email: `a${String(n)}@x.test`, displayName: `A${String(n)}`, createdBy: null },
  ...{ createdByEmail: null, createdAt: new Date('2026-01-01'), disabledAt: null },
  ...{ disabledReason: null, lastStepUpAt: null },
  ...over,
});
const audits: unknown[] = [];
const store: AccessReviewStore = {
  monthActivity: () =>
    Promise.resolve([
      { userId: id(1), email: 'a1@x.test', signIns: 4, lastActionAt: OCT },
      { userId: id(9), email: 'gone@x.test', signIns: 1, lastActionAt: OCT },
    ]),
  monthSupport: () =>
    Promise.resolve([{ userId: id(1), sessions: 3, organizations: 2, lastStartedAt: NOW }]),
  users: (ids) =>
    Promise.resolve(
      ids.map((u) => ({ userId: u, email: '', displayName: 'P', twoStep: u === id(1) })),
    ),
  recordReview: (audit) => Promise.resolve(void audits.push(audit)),
};
const team = {
  listTeam: () =>
    Promise.resolve([
      teamRow(1),
      teamRow(2, { status: 'disabled', disabledAt: new Date('2026-09-01') }),
      teamRow(3, { createdAt: new Date('2026-11-01') }),
    ]),
  findUsersByEmails: () => Promise.resolve([]),
};
const service = new AccessReviewService(team, store, ['root@x.test'], () => NOW);
const actor = (permissions: string[]) =>
  ({
    account: { userId: id(1), email: 'a1@x.test' },
    permissions,
  }) as unknown as PlatformAdminActor;
const manager = actor(['platform.team.manage']);
const req = { correlationId: 'c', ip: null, userAgent: null };

describe('platform access review', () => {
  it('lists who had access that month with their activity', async () => {
    const view = await service.review(manager, { month: '2026-10' }, req);
    expect(view.admins.map((a) => [a.email, a.source, a.status])).toEqual([
      ['root@x.test', 'env', 'active'],
      ['a1@x.test', 'db', 'active'],
      ['gone@x.test', 'former', 'removed'],
    ]);
    expect(view.admins[1]).toMatchObject({
      signIns: 4,
      supportSessions: 3,
      organizationsEntered: 2,
    });
    expect(view.admins[1]?.lastActiveAt).toBe(NOW.toISOString());
    expect(view.withoutTwoStep).toBe(2);
  });

  it('defaults to last month and refuses a bad or future month', () => {
    expect(parseMonth(undefined, NOW).month).toBe('2026-10');
    expect(() => parseMonth('2026-13', NOW)).toThrow();
    expect(() => parseMonth('2026-12', NOW)).toThrow();
  });

  it('records the review in the platform log and refuses without platform.team.manage', async () => {
    const done = await service.record(manager, { month: '2026-10' }, req);
    expect(done).toMatchObject({ month: '2026-10', admins: 3 });
    expect(audits[0]).toMatchObject({
      action: 'platform.access_review_recorded',
      targetLabel: '2026-10',
    });
    await expect(service.review(actor([]), {}, req)).rejects.toMatchObject({ status: 403 });
    await expect(service.record(actor([]), { month: '2026-10' }, req)).rejects.toMatchObject({
      status: 403,
    });
  });
});
