import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { HomeService } from './home.service.js';
import type { MyDayRepository } from './my-day.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';

// HOME-03's ranking over the read repository's rows, proven over fakes: the `work_items` reads
// are already DB-proven and the ranking is pure over rows + `now`, so no `.db.test.ts` is owed.
const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const ME = 'user-0000-0000-0000-0000-000000000001';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Only the fields the ranking and `mayRead` read; the rest are filled so `toWorkItemView` runs. */
function item(overrides: Partial<WorkItemRow>): WorkItemRow {
  return {
    id: 'work-0000-0000-0000-0000-000000000000',
    organizationId: ORG,
    projectId: PROJECT,
    type: 'task',
    title: 'a task',
    state: 'in_progress',
    ownerUserId: ME,
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 1n,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  } as unknown as WorkItemRow;
}

function member(projectIds: readonly string[]): Principal {
  return {
    userId: ME,
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

// The fake repository returns the canned rows; the service still authorizes each through
// `mayRead`, so a cross-tenant row placed in the set must be dropped there (belt-and-braces).
function serviceWith(rows: readonly WorkItemRow[]): HomeService {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const myDay = {
    listOwnedOpen: async () => rows,
  } as unknown as MyDayRepository;
  return new HomeService(database, myDay);
}

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

describe('HomeService.myDayOf ranking', () => {
  it('ranks overdue then due-soon by due_at then the rest by id, dropping a cross-tenant row', async () => {
    // Shuffled input; ids chosen so id-order and due-order disagree.
    const overdueEarlier = item({
      id: 'w-overdue-earlier-00000000000002',
      dueAt: new Date(NOW.getTime() - 2 * DAY),
    });
    const overdueLater = item({
      id: 'w-overdue-later-000000000000001',
      dueAt: new Date(NOW.getTime() - 1 * HOUR),
    });
    const dueSoon = item({
      id: 'w-duesoon-0000000000000000000003',
      dueAt: new Date(NOW.getTime() + 6 * HOUR),
    });
    const noDate = item({ id: 'w-assigned-nodate-0000000000004' });
    const farOff = item({
      id: 'w-assigned-faroff-0000000000005',
      dueAt: new Date(NOW.getTime() + 30 * DAY),
    });
    const foreign = item({
      id: 'w-foreign-00000000000000000009',
      organizationId: OTHER_ORG,
      projectId: 'project-0000-0000-0000-0000-000000000099',
      dueAt: new Date(NOW.getTime() - 3 * DAY),
    });

    const service = serviceWith([dueSoon, noDate, overdueLater, farOff, foreign, overdueEarlier]);

    const view = await service.myDayOf(context, member([PROJECT]), NOW);

    // Overdue (most overdue first), then due-soon, then the rest by id; the foreign row is gone.
    expect(view.items.map((entry) => [entry.workItem.id, entry.reason])).toEqual([
      [overdueEarlier.id, 'overdue'],
      [overdueLater.id, 'overdue'],
      [dueSoon.id, 'due_soon'],
      [farOff.id, 'assigned'],
      [noDate.id, 'assigned'],
    ]);
    expect(JSON.stringify(view)).not.toContain(OTHER_ORG);
  });

  it('returns no items for a user with none', async () => {
    const service = serviceWith([]);

    const view = await service.myDayOf(context, member([PROJECT]), NOW);

    expect(view.items).toEqual([]);
  });
});
