import { describe, expect, it } from 'vitest';
import { RecurrenceSpawner } from './recurrence-spawner.service.js';
import { DEFAULT_RECURRENCE_CALENDAR } from './item-recurrence.service.js';

// 53-09: a lost `work.create` pauses + notifies (fail closed); a claimed occurrence never re-creates.
const ORG = '01890000-0000-7000-8000-00000000000a';
const rule = {
  id: 'r1',
  workItemId: 'w1',
  ownerUserId: 'u1',
  rrule: 'FREQ=DAILY',
  startsOn: '2026-11-01',
  status: 'active',
  spawnMode: 'on_schedule',
  spawnAheadDays: 1,
  createdAt: new Date(),
};
const seed = { id: 'w1', organizationId: ORG, projectId: 'p1', deletedAt: null, completedAt: null };
const owner = (projectIds: string[]) => ({
  context: {},
  principal: {
    userId: 'u1',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  },
});

function harness(projectIds: string[], claim: string | null) {
  const log: string[] = [];
  const work = async (_c: unknown, fn: (db: unknown) => unknown) => fn({});
  const spawner = new RecurrenceSpawner({
    database: { bootstrapRead: work, read: work, transaction: work } as never,
    workItems: { create: async () => (log.push('create'), { id: 'w2' }) } as never,
    workItemsRepository: { findById: async () => seed } as never,
    calendars: DEFAULT_RECURRENCE_CALENDAR,
    repository: {
      organizationsWithActiveRules: async () => [ORG],
      activeRules: async () => [rule],
      countSpawnedSince: async () => 0,
      principalOfUser: async () => owner(projectIds),
      lastCreatedInstance: async () => null,
      completeInstance: async () => log.push('complete'),
      advanceLastOccurrence: async () => undefined,
    } as never,
    recurrence: {
      insertInstance: async () => claim,
      setStatus: async (_r: unknown, _c: unknown, _id: string, s: string) => log.push(s),
    } as never,
    notifications: {
      insertForRecipient: async (_r: unknown, _c: unknown, n: { type: string }) => log.push(n.type),
    } as never,
  });
  return { spawner, log };
}

describe('RecurrenceSpawner', () => {
  it('pauses the rule and tells the owner when they lost work.create', async () => {
    const { spawner, log } = harness([], 'claim');
    expect((await spawner.sweep(new Date('2026-11-04T08:00:00Z'))).paused).toBe(1);
    expect(log).toEqual(['paused', 'recurrence.paused']);
  });

  it('a duplicate claim creates nothing; a pass inside 15 minutes does not run', async () => {
    const { spawner, log } = harness(['p1'], null);
    expect((await spawner.sweep(new Date('2026-11-04T08:00:00Z'))).duplicates).toBeGreaterThan(0);
    expect((await spawner.sweep(new Date('2026-11-04T08:10:00Z'))).ran).toBe(false);
    expect(log).toEqual([]);
  });
});
