import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkViewsService } from './work-views.service.js';
import type { TimelineItemRow, WorkTimelineRepository } from './timeline.repository.js';
import type { WorkloadRepository } from './workload.repository.js';
import type { WorkCalendarRepository } from './calendar.repository.js';
import type { PredecessorHealthRow } from '../work/work-graph.repository.js';
import { ProjectNotFoundError } from '../projects/projects.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';

/**
 * WK-04 Work timeline: `projectTimeline` composes the work + work-graph reads into an ordered,
 * authorized, accessible-list view. Database-free proofs over fakes — the underlying reads are
 * already DB-proven, so the composition needs no `.db.test.ts` (NEXT-SCOPES §x94 budget).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';

const DAY_ONE = new Date('2026-02-01T09:00:00.000Z');
const DAY_TWO = new Date('2026-02-02T09:00:00.000Z');

/** Only the fields the timeline reads (id, tenancy/audience for `mayRead`, dates, title, state). */
function item(overrides: Partial<WorkItemRow>): WorkItemRow {
  return {
    id: 'work-x-0000000000-0000-000000000000',
    organizationId: ORG,
    projectId: PROJECT,
    audience: 'internal',
    state: 'in_progress',
    title: 'a task',
    startAt: null,
    dueAt: null,
    deletedAt: null,
    ...overrides,
  } as unknown as WorkItemRow;
}

function predecessor(overrides: Partial<PredecessorHealthRow>): PredecessorHealthRow {
  return {
    dependencyId: 'dep-0000-0000-0000-0000-000000000001',
    workItemId: 'work-pred-000000000-0000-000000000099',
    projectId: PROJECT,
    audience: 'internal',
    title: 'an upstream task',
    state: 'in_progress',
    dueAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function member(projectIds: readonly string[]): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
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

/** A service whose repository returns exactly `rows`, unscoped, so `mayRead` must drop the foreign one. */
function serviceWith(rows: readonly TimelineItemRow[]): WorkViewsService {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const timeline = {
    listProjectTimeline: async () => rows,
  } as unknown as WorkTimelineRepository;
  return new WorkViewsService(database, timeline);
}

/**
 * A service whose workload repository returns exactly `rows`, unscoped, so `mayRead` must drop the
 * foreign one. The rows are the open items the underlying (open-state-filtered) query would return;
 * the grouping, counting and ordering are the service's, which is what these cases prove.
 */
function workloadServiceWith(
  rows: readonly WorkItemRow[],
  projects: Partial<ProjectsRepository> = { requireById: async () => ({ id: PROJECT }) as never },
): WorkViewsService {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workload = {
    listOpenProjectItems: async () => rows,
  } as unknown as WorkloadRepository;
  const calendar = {} as unknown as WorkCalendarRepository;
  return new WorkViewsService(
    database,
    undefined,
    workload,
    calendar,
    projects as ProjectsRepository,
  );
}

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

describe('WorkViewsService.projectTimeline', () => {
  it('orders items by start then due then id, carries the dependency edge, and drops a cross-tenant item', async () => {
    const later = item({ id: 'work-a-0000000000-0000-000000000001', startAt: DAY_TWO });
    const earlier = item({ id: 'work-b-0000000000-0000-000000000002', startAt: DAY_ONE });
    const undated = item({
      id: 'work-c-0000000000-0000-000000000003',
      startAt: null,
      dueAt: DAY_ONE,
    });
    const foreign = item({ id: 'work-z-0000000000-0000-000000000009', organizationId: OTHER_ORG });

    const service = serviceWith([
      // `later` depends on `earlier`.
      { item: later, predecessors: [predecessor({ workItemId: earlier.id })] },
      { item: earlier, predecessors: [] },
      { item: undated, predecessors: [] },
      { item: foreign, predecessors: [] },
    ]);

    const view = await service.projectTimeline(context, member([PROJECT]), PROJECT);

    expect(view.projectId).toBe(PROJECT);
    // Sorted: earlier (day1 start), later (day2 start), undated (null start sorts last).
    expect(view.items.map((row) => row.id)).toEqual([earlier.id, later.id, undated.id]);
    // The edge is carried on the dependent item.
    expect(view.items[1]?.predecessorIds).toEqual([earlier.id]);
    expect(view.items[0]?.predecessorIds).toEqual([]);
    // Dates are serialised; the earlier item carries its start.
    expect(view.items[0]?.startAt).toBe(DAY_ONE.toISOString());
    // The other tenant's row never contributes.
    expect(JSON.stringify(view)).not.toContain(OTHER_ORG);
    expect(view.items.some((row) => row.id === foreign.id)).toBe(false);
  });

  it('drops an unreadable predecessor id and a soft-deleted edge while the item itself stays', async () => {
    const OTHER_PROJECT = 'project-0000-0000-0000-0000-000000000002';
    const dependent = item({ id: 'work-d-0000000000-0000-000000000004', startAt: DAY_ONE });
    // A predecessor in the caller's own project: readable, its id is listed.
    const readablePred = predecessor({ workItemId: 'work-pred-000000000-0000-000000000001' });
    // A predecessor in a project the member is not on: its id must not leak (R01 / audit F3).
    const unreadablePred = predecessor({
      workItemId: 'work-pred-000000000-0000-000000000002',
      projectId: OTHER_PROJECT,
    });
    // A soft-deleted edge is not a live dependency and is dropped before authorization.
    const deletedPred = predecessor({
      workItemId: 'work-pred-000000000-0000-000000000003',
      deletedAt: DAY_ONE,
    });

    const service = serviceWith([
      { item: dependent, predecessors: [readablePred, unreadablePred, deletedPred] },
    ]);

    const view = await service.projectTimeline(context, member([PROJECT]), PROJECT);

    // The item itself stays even though two of its three predecessors are redacted.
    expect(view.items.map((row) => row.id)).toEqual([dependent.id]);
    // Only the readable, live predecessor id is present; neither redacted id leaks.
    expect(view.items[0]?.predecessorIds).toEqual([readablePred.workItemId]);
    expect(view.items[0]?.predecessorIds).not.toContain(unreadablePred.workItemId);
    expect(view.items[0]?.predecessorIds).not.toContain(deletedPred.workItemId);
    expect(JSON.stringify(view)).not.toContain(OTHER_PROJECT);
  });

  it('returns the documented empty value for a project with no readable items', async () => {
    const service = serviceWith([]);

    const view = await service.projectTimeline(context, member([PROJECT]), PROJECT);

    expect(view).toEqual({ projectId: PROJECT, items: [] });
  });
});

const OWNER_A = 'user-0000-0000-0000-0000-0000000000aa';
const OWNER_B = 'user-0000-0000-0000-0000-0000000000bb';

describe('WorkViewsService.projectWorkload', () => {
  it('groups open items by owner with counts and derived load, ordered heaviest first, unassigned last', async () => {
    const service = workloadServiceWith([
      // Owner A: three open items, two on the calendar (one has a start, one a due).
      item({ id: 'work-a-0000000000-0000-000000000001', ownerUserId: OWNER_A, startAt: DAY_ONE }),
      item({ id: 'work-a-0000000000-0000-000000000002', ownerUserId: OWNER_A, dueAt: DAY_TWO }),
      item({ id: 'work-a-0000000000-0000-000000000003', ownerUserId: OWNER_A }),
      // Owner B: one open item, none scheduled.
      item({ id: 'work-b-0000000000-0000-000000000001', ownerUserId: OWNER_B }),
      // Unassigned: two open items, one scheduled.
      item({ id: 'work-u-0000000000-0000-000000000001', ownerUserId: null, dueAt: DAY_ONE }),
      item({ id: 'work-u-0000000000-0000-000000000002', ownerUserId: null }),
    ]);

    const view = await service.projectWorkload(context, member([PROJECT]), PROJECT);

    expect(view.projectId).toBe(PROJECT);
    // Heaviest first (A:3), then the unassigned pile and B tie at… no: unassigned has 2, B has 1,
    // and the unassigned pile sorts after a real owner only within the same count — here its count
    // is higher, so it precedes B.
    expect(view.groups).toEqual([
      { ownerUserId: OWNER_A, openItemCount: 3, scheduledItemCount: 2 },
      { ownerUserId: null, openItemCount: 2, scheduledItemCount: 1 },
      { ownerUserId: OWNER_B, openItemCount: 1, scheduledItemCount: 0 },
    ]);
  });

  it('sorts a real owner ahead of the unassigned pile when their open-item counts tie', async () => {
    const service = workloadServiceWith([
      item({ id: 'work-u-0000000000-0000-000000000001', ownerUserId: null, dueAt: DAY_ONE }),
      item({ id: 'work-b-0000000000-0000-000000000001', ownerUserId: OWNER_B, dueAt: DAY_ONE }),
    ]);

    const view = await service.projectWorkload(context, member([PROJECT]), PROJECT);

    // Both have one open item, one scheduled; the named owner leads, "nobody yet" trails it.
    expect(view.groups.map((group) => group.ownerUserId)).toEqual([OWNER_B, null]);
  });

  it('drops a cross-tenant item from the workload — it never contributes to a count', async () => {
    const service = workloadServiceWith([
      item({ id: 'work-a-0000000000-0000-000000000001', ownerUserId: OWNER_A }),
      // Another tenant's row, returned unscoped by the fake: `mayRead` must refuse it.
      item({
        id: 'work-z-0000000000-0000-000000000009',
        ownerUserId: OWNER_A,
        organizationId: OTHER_ORG,
      }),
    ]);

    const view = await service.projectWorkload(context, member([PROJECT]), PROJECT);

    // Owner A carries only the in-tenant item; the foreign row is gone, count and load unaffected.
    expect(view.groups).toEqual([
      { ownerUserId: OWNER_A, openItemCount: 1, scheduledItemCount: 0 },
    ]);
    expect(JSON.stringify(view)).not.toContain(OTHER_ORG);
  });

  it('returns the documented empty value for a project with no readable open items', async () => {
    const service = workloadServiceWith([]);

    const view = await service.projectWorkload(context, member([PROJECT]), PROJECT);

    expect(view).toEqual({ projectId: PROJECT, groups: [] });
  });

  it('rejects with ProjectNotFoundError (→ 404) for an unknown or cross-tenant project id', async () => {
    // The project resolve fails before any workload work — a missing or cross-tenant id is a 404,
    // never a 500 (no FK/lookup miss reaches the caller) and never a misleading empty workload.
    const service = workloadServiceWith([], {
      requireById: async () => {
        throw new ProjectNotFoundError('project-unknown');
      },
    });

    await expect(
      service.projectWorkload(context, member([PROJECT]), 'project-unknown'),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

/**
 * WK-05 Work calendar: `projectCalendar` resolves the project, buckets the work read by anchor
 * day into a requested range, and authorizes each item — all over fakes, DB-free, because the
 * underlying `list` is already DB-proven (brief §Gates: no DB test).
 */

const DAY_OUT = new Date('2026-03-01T09:00:00.000Z');
const RANGE = { from: '2026-02-01', to: '2026-02-28' } as const;

/**
 * A calendar service whose project resolves (or not) and whose work read returns exactly `rows`,
 * unscoped — so `mayRead` must drop the foreign one and the project resolve must 404 when absent.
 */
function calendarServiceWith(
  rows: readonly WorkItemRow[],
  options: { projectExists?: boolean } = {},
): WorkViewsService {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const timeline = {} as unknown as WorkTimelineRepository;
  const calendar = {
    listProjectItems: async () => rows,
  } as unknown as WorkCalendarRepository;
  const projects = {
    findById: async () => ((options.projectExists ?? true) ? {} : null),
  } as unknown as ProjectsRepository;
  const workload = {} as unknown as WorkloadRepository;
  return new WorkViewsService(database, timeline, workload, calendar, projects);
}

describe('WorkViewsService.projectCalendar', () => {
  it('buckets items by anchor day in range order, drops a cross-tenant item, and excludes dateless and out-of-range items', async () => {
    // Anchor = dueAt, or startAt when there is no due date.
    const dueDayOne = item({ id: 'work-a-0000000000-0000-000000000001', dueAt: DAY_ONE });
    const startDayOne = item({
      id: 'work-c-0000000000-0000-000000000003',
      startAt: DAY_ONE,
      dueAt: null,
    });
    const dueDayTwo = item({ id: 'work-b-0000000000-0000-000000000002', dueAt: DAY_TWO });
    const undated = item({ id: 'work-u-0000000000-0000-000000000004', startAt: null, dueAt: null });
    const outOfRange = item({ id: 'work-o-0000000000-0000-000000000005', dueAt: DAY_OUT });
    const foreign = item({
      id: 'work-z-0000000000-0000-000000000009',
      organizationId: OTHER_ORG,
      dueAt: DAY_ONE,
    });

    const service = calendarServiceWith([
      dueDayOne,
      startDayOne,
      dueDayTwo,
      undated,
      outOfRange,
      foreign,
    ]);

    const view = await service.projectCalendar(context, member([PROJECT]), PROJECT, RANGE);

    expect(view.projectId).toBe(PROJECT);
    expect(view.range).toEqual(RANGE);
    // Only the two in-range days that carry an item, ascending.
    expect(view.days.map((day) => day.date)).toEqual(['2026-02-01', '2026-02-02']);
    // Within day one, the started item sorts before the due-only item (start, then due, then id).
    expect(view.days[0]?.items.map((row) => row.id)).toEqual([startDayOne.id, dueDayOne.id]);
    expect(view.days[1]?.items.map((row) => row.id)).toEqual([dueDayTwo.id]);
    // Dates are serialised.
    expect(view.days[1]?.items[0]?.dueAt).toBe(DAY_TWO.toISOString());
    // The other tenant's row never contributes; neither does a dateless or out-of-range item.
    expect(JSON.stringify(view)).not.toContain(OTHER_ORG);
    const allIds = view.days.flatMap((day) => day.items.map((row) => row.id));
    expect(allIds).not.toContain(undated.id);
    expect(allIds).not.toContain(outOfRange.id);
    expect(allIds).not.toContain(foreign.id);
  });

  it('is 404, not an empty calendar, for an unknown or cross-tenant project id', async () => {
    // An org-wide caller passes the per-item read, so an unknown project must be turned away by
    // the tenant-scoped resolve before anything is bucketed (FAST-PROTOCOL known trap).
    const service = calendarServiceWith([], { projectExists: false });

    await expect(
      service.projectCalendar(context, member([PROJECT]), 'project-does-not-exist', RANGE),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('returns the documented empty value for a project with no in-range readable items', async () => {
    const service = calendarServiceWith([]);

    const view = await service.projectCalendar(context, member([PROJECT]), PROJECT, RANGE);

    expect(view).toEqual({ projectId: PROJECT, range: RANGE, days: [] });
  });
});
