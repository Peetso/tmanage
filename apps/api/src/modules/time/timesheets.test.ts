import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { weekBounds } from './time-rules.js';
import { overflowingDay, parseEntries } from './timesheets-rules.js';
import { TimesheetsService } from './timesheets.service.js';
import type { TimesheetsServiceOptions } from './timesheets.service.js';

/** 52-02 / 52-03 — timesheet rules over in-memory fakes (no database). */

const SHEET = '01890000-0000-7000-8000-0000000000aa';
const E1 = '01890000-0000-7000-8000-0000000000e1';
const PA = '01890000-0000-7000-8000-00000000000a';
const PB = '01890000-0000-7000-8000-00000000000b';
const me = { organizationId: 'o1', userId: 'u1', membershipId: 'm1' } as TenantContext;
const manager = {
  kind: 'internal',
  role: 'manager',
  organizationId: 'o1',
  membershipId: 'm1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PA],
  hasOrgWideScope: false,
} as unknown as Principal;
const week = { periodStart: '2026-10-25', periodEnd: '2026-10-31' };
const entry = (o: Record<string, unknown>) => ({
  id: E1,
  loggedBy: 'm2',
  workItemId: null,
  projectId: PA,
  spentOn: '2026-10-26',
  minutes: 60,
  billable: true,
  note: 'secret',
  needsReview: false,
  lockedAt: null,
  ...o,
});

function harness(
  o: { owner?: string; state?: string; version?: number; entries?: unknown[] } = {},
) {
  const sheet = {
    id: SHEET,
    membershipId: o.owner ?? 'm2',
    ...week,
    state: o.state ?? 'submitted',
    version: o.version ?? 3,
    editedByManager: false,
    submittedAt: null,
    decidedAt: null,
    decisionNote: null,
  };
  const writes: string[] = [];
  const options = {
    now: () => new Date('2026-10-29T09:00:00Z'),
    database: {
      transaction: (_c: unknown, fn: (t: unknown) => unknown) => fn({}),
      read: (_c: unknown, fn: (t: unknown) => unknown) => fn({}),
    },
    audit: { record: async () => ({}) },
    notifications: { insertForRecipient: async () => void writes.push('notice') },
    holders: { financeCandidates: async () => [] },
    timeLogs: { create: async () => void writes.push('create') },
    workItems: { findById: async () => null },
    repository: {
      weekStart: async () => 0,
      findById: async () => sheet,
      internalMembers: async () => [{ membershipId: 'm2', userId: 'u2' }],
      listForPeriod: async () => [sheet],
      entriesInPeriod: async () => o.entries ?? [],
      openLocks: async () => [],
      titles: async (_r: unknown, _c: unknown, ids: string[]) => new Map(ids.map((i) => [i, 't'])),
      weeklyHours: async () => 40,
      update: async () => void writes.push('update'),
      userOf: async () => 'u2',
      updateEntry: async () => void writes.push('entry'),
    },
  } as unknown as TimesheetsServiceOptions;
  return { service: new TimesheetsService(options), writes };
}

describe('UNIT-52-05 week bounds', () => {
  it('starts the ISO week on the org week_start (Sunday, Monday, Saturday), across a year end', () => {
    expect(weekBounds('2026-W44', 1)).toEqual({
      periodStart: '2026-10-26',
      periodEnd: '2026-11-01',
    });
    expect(weekBounds('2026-W44', 0)).toEqual({
      periodStart: '2026-10-25',
      periodEnd: '2026-10-31',
    });
    expect(weekBounds('2026-W44', 6)).toEqual({
      periodStart: '2026-10-24',
      periodEnd: '2026-10-30',
    });
    expect(weekBounds('2026-W01', 1)).toEqual({
      periodStart: '2025-12-29',
      periodEnd: '2026-01-04',
    });
    expect(weekBounds('2027-W53', 1)).toBeNull();
    expect(weekBounds('2026-44', 1)).toBeNull();
  });
});

describe('52-02 timesheet rules', () => {
  it('INT-52-05 refuses the whole batch when one line falls outside the week', () => {
    const ok = { spentOn: '2026-10-26', minutes: 30 };
    expect(() => parseEntries([ok, { spentOn: '2026-11-02', minutes: 30 }], week)).toThrow();
    expect(parseEntries([ok], week)).toHaveLength(1);
  });

  it('caps a day at 24 hours over all its entries', () => {
    const day = { spentOn: '2026-10-26', minutes: 800 };
    expect(overflowingDay([day, { ...day, minutes: 640 }])).toBeNull();
    expect(overflowingDay([day, { ...day, minutes: 641 }])).toBe('2026-10-26');
  });

  it('CONC-52-01 a stale version is a 409 carrying both versions, and nothing is written', async () => {
    const { service, writes } = harness({ owner: 'm1', state: 'open', version: 4 });
    const body = { version: 3, entries: [{ spentOn: '2026-10-26', minutes: 30 }] };
    await expect(service.upsertEntries(me, manager, SHEET, body)).rejects.toMatchObject({
      status: 409,
      details: [{ message: 'version_conflict:sent=3:current=4' }],
    });
    expect(writes).toEqual([]);
  });

  it('AUTH-52-03 a manager of project A sees no title or note of project B', async () => {
    const entries = [
      entry({ workItemId: 'wa' }),
      entry({ id: 'e2', projectId: PB, workItemId: 'wb', minutes: 90 }),
    ];
    const view = await harness({ entries }).service.team(me, manager, '2026-W44', undefined);
    const row = view.members[0]!;
    expect(row.entries.map((e) => e.projectId)).toEqual([PA]);
    expect(row.otherProjectsMinutes).toBe(90);
    expect(JSON.stringify(row)).not.toContain('wb');
  });

  it('AUTH-52-04 a manager cannot approve their own week', async () => {
    const { service, writes } = harness({ owner: 'm1' });
    await expect(service.decide(me, manager, SHEET, {}, true)).rejects.toMatchObject({
      status: 403,
      details: [{ message: 'cannot_approve_own' }],
    });
    expect(writes).toEqual([]);
  });
});
