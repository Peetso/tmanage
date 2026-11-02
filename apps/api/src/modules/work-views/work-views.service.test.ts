import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkViewsService } from './work-views.service.js';
import type { SavedViewInput } from './work-views.service.js';
import type { TimelineItemRow, WorkTimelineRepository } from './timeline.repository.js';
import type { WorkloadRepository } from './workload.repository.js';
import type { WorkCalendarRepository } from './calendar.repository.js';
import type {
  CreateSavedViewInput,
  SavedViewsRepository,
  UpdateSavedViewInput,
} from './saved-views.repository.js';
import type { PredecessorHealthRow } from '../work/work-graph.repository.js';
import { ProjectNotFoundError } from '../projects/projects.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  ProjectMilestoneRow,
  ProjectPhaseRow,
  ProjectRow,
  SavedViewRow,
  WorkItemRow,
} from '../../common/database/schema.js';

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
function serviceWith(
  rows: readonly TimelineItemRow[],
  stats: ReadonlyMap<string, { floatDays: number | null; critical: boolean }> = new Map(),
  layer: {
    phases?: readonly Partial<ProjectPhaseRow>[];
    milestones?: readonly Partial<ProjectMilestoneRow>[];
    links?: readonly { milestoneId: string; dependsOnMilestoneId: string }[];
  } = {},
): WorkViewsService {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const timeline = {
    listProjectTimeline: async () => rows,
    listScheduleStats: async () => stats,
    listTimelinePhases: async () => layer.phases ?? [],
    listTimelineMilestones: async () => layer.milestones ?? [],
    listMilestoneLinks: async () => layer.links ?? [],
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
  const savedViews = {} as unknown as SavedViewsRepository;
  return new WorkViewsService(
    database,
    undefined,
    workload,
    calendar,
    savedViews,
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

    expect(view).toEqual({ projectId: PROJECT, items: [], phases: [], milestones: [] });
  });

  it('53-06: carries float and critical from the stats, null / false without a row', async () => {
    const [a, b] = [
      item({ id: 'work-a', startAt: DAY_ONE }),
      item({ id: 'work-b', startAt: DAY_TWO }),
    ];
    const stats = new Map([[a.id, { floatDays: 0, critical: true }]]);
    const rows = [a, b].map((row) => ({ item: row, predecessors: [] }));
    const view = await serviceWith(rows, stats).projectTimeline(
      context,
      member([PROJECT]),
      PROJECT,
    );
    expect(view.items.map((r) => [r.floatDays, r.critical])).toEqual([
      [0, true],
      [null, false],
    ]);
  });
});

describe('53-07 timeline phases and milestones', () => {
  it('draws a band from explicit dates and one from its milestones, and places each diamond', async () => {
    const milestone = (overrides: Partial<ProjectMilestoneRow>): Partial<ProjectMilestoneRow> => ({
      title: 'm',
      status: 'planned',
      dueOn: null,
      committedOn: null,
      forecastOn: null,
      timelineOrder: null,
      ...overrides,
    });
    const view = await serviceWith([], new Map(), {
      phases: [
        {
          id: 'p1',
          name: 'Design',
          position: 0,
          milestoneId: null,
          phaseId: null,
          startsOn: '2026-01-01',
          endsOn: '2026-02-01',
          colorToken: 'accent.teal',
        },
        {
          id: 'p2',
          name: 'Build',
          position: 1,
          milestoneId: null,
          phaseId: null,
          startsOn: null,
          endsOn: null,
          colorToken: null,
        },
        { id: 'a1', name: null, position: null, milestoneId: 'm1', phaseId: 'p2' },
        { id: 'a2', name: null, position: null, milestoneId: 'm2', phaseId: 'p2' },
      ],
      milestones: [
        milestone({ id: 'm1', title: 'Beta', committedOn: '2099-03-01', forecastOn: '2099-04-01' }),
        milestone({ id: 'm2', title: 'Launch', dueOn: '2099-05-01' }),
      ],
      links: [{ milestoneId: 'm2', dependsOnMilestoneId: 'm1' }],
    }).projectTimeline(context, member([PROJECT]), PROJECT);

    expect(view.phases?.map((p) => [p.id, p.startsOn, p.endsOn])).toEqual([
      ['p1', '2026-01-01', '2026-02-01'],
      ['p2', '2099-03-01', '2099-05-01'],
    ]);
    expect(
      view.milestones?.map((m) => [m.id, m.date, m.health, m.phaseId, m.linkedItemIds]),
    ).toEqual([
      ['m1', '2099-03-01', 'at_risk', 'p2', []],
      ['m2', '2099-05-01', 'on_track', 'p2', ['m1']],
    ]);
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
  const savedViews = {} as unknown as SavedViewsRepository;
  return new WorkViewsService(database, timeline, workload, calendar, savedViews, projects);
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

// ─────────────────────────────────────────────────────────────────────────────
// WK-08 saved views (x107): create / update / list over fakes, with the real ownership
// rule and the Known-trap project resolution. Database-free proofs; the repository's tenant
// scoping is DB-proven in work-008-saved-views.db.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER = 'user-0000-0000-0000-0000-000000000001';
const OTHER_USER = 'user-0000-0000-0000-0000-000000000002';

const SAMPLE_CONFIG: SavedViewInput['config'] = {
  filters: [{ field: 'state', value: 'in_progress' }],
  grouping: null,
  columns: ['title', 'state'],
};

/** A member of `PROJECT`, org-wide scope off — the ordinary caller. */
function ownerMember(): Principal {
  return { ...member([PROJECT]), userId: OWNER };
}

/** An org-wide caller (passes the relation gate) — the Known-trap's subject. */
function orgWideCaller(): Principal {
  return { ...member([]), userId: OWNER, role: 'owner', hasOrgWideScope: true };
}

/** An in-memory saved-views repository: enough of the real one to prove the service's rules. */
class FakeSavedViews {
  readonly rows: SavedViewRow[] = [];
  createCalls = 0;
  updateCalls = 0;

  seed(row: Partial<SavedViewRow>): SavedViewRow {
    const full = savedViewRow(row);
    this.rows.push(full);
    return full;
  }

  async findById(_r: unknown, _c: unknown, id: string): Promise<SavedViewRow | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async listForViewer(_r: unknown, _c: unknown, viewer: string): Promise<readonly SavedViewRow[]> {
    return this.rows
      .filter((row) => row.ownerUserId === viewer || row.shared)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  }

  async create(_r: unknown, _c: unknown, input: CreateSavedViewInput): Promise<SavedViewRow> {
    this.createCalls += 1;
    const row = savedViewRow({
      id: `saved-000000000000-0000-00000000000${this.rows.length + 1}`,
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      name: input.name,
      config: input.config,
      shared: input.shared,
    });
    this.rows.push(row);
    return row;
  }

  async update(
    _r: unknown,
    _c: unknown,
    id: string,
    input: UpdateSavedViewInput,
  ): Promise<SavedViewRow> {
    this.updateCalls += 1;
    const existing = this.rows.find((row) => row.id === id);
    if (!existing) throw new Error(`no such row ${id}`);
    const updated = savedViewRow({ ...existing, ...input });
    this.rows.splice(this.rows.indexOf(existing), 1, updated);
    return updated;
  }
}

function savedViewRow(overrides: Partial<SavedViewRow>): SavedViewRow {
  return {
    id: 'saved-000000000000-0000-000000000001',
    organizationId: ORG,
    ownerUserId: OWNER,
    projectId: null,
    name: 'My view',
    config: SAMPLE_CONFIG,
    shared: false,
    createdAt: DAY_ONE,
    updatedAt: DAY_ONE,
    ...overrides,
  } as SavedViewRow;
}

/** A service wired to fakes: `project` is what `ProjectsRepository.findById` returns (or null). */
function savedViewService(project: ProjectRow | null): {
  service: WorkViewsService;
  saved: FakeSavedViews;
} {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const saved = new FakeSavedViews();
  const projects = { findById: async () => project } as unknown as ProjectsRepository;
  const service = new WorkViewsService(
    database,
    {} as unknown as WorkTimelineRepository,
    {} as unknown as WorkloadRepository,
    {} as unknown as WorkCalendarRepository,
    saved as unknown as SavedViewsRepository,
    projects,
  );
  return { service, saved };
}

const PROJECT_ROW = { id: PROJECT, organizationId: ORG } as unknown as ProjectRow;

describe('WorkViewsService saved views', () => {
  it('persists the caller’s own view and lists it back (org-wide, no project)', async () => {
    const { service } = savedViewService(null);
    const input: SavedViewInput = {
      projectId: null,
      name: 'My view',
      config: SAMPLE_CONFIG,
      shared: false,
    };

    const created = await service.createSavedView(context, ownerMember(), input);
    expect(created.ownerUserId).toBe(OWNER);
    expect(created.projectId).toBeNull();
    expect(created.config).toEqual(SAMPLE_CONFIG);

    const listed = await service.listSavedViews(context, ownerMember());
    expect(listed.map((view) => view.id)).toEqual([created.id]);
  });

  it('lists a colleague’s shared view but not their private one', async () => {
    const { service, saved } = savedViewService(null);
    saved.seed({ id: 'saved-a', ownerUserId: OTHER_USER, name: 'Shared', shared: true });
    saved.seed({ id: 'saved-b', ownerUserId: OTHER_USER, name: 'Private', shared: false });
    saved.seed({ id: 'saved-c', ownerUserId: OWNER, name: 'Mine', shared: false });

    const listed = await service.listSavedViews(context, ownerMember());
    const ids = listed.map((view) => view.id);
    expect(ids).toContain('saved-a');
    expect(ids).toContain('saved-c');
    expect(ids).not.toContain('saved-b');
  });

  it('resolves an unknown/cross-tenant project to 404 with no write, even for an org-wide caller (Known-trap)', async () => {
    const { service, saved } = savedViewService(null); // findById → null: unknown or cross-tenant.
    const input: SavedViewInput = {
      projectId: PROJECT,
      name: 'Scoped',
      config: SAMPLE_CONFIG,
      shared: false,
    };

    await expect(service.createSavedView(context, orgWideCaller(), input)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(saved.createCalls).toBe(0);
  });

  it('refuses to scope a view to a project the caller cannot read (404, no write)', async () => {
    const { service, saved } = savedViewService(PROJECT_ROW);
    // A member of no project: the project exists in the tenant but the relation gate denies read.
    const stranger: Principal = { ...member([]), userId: OWNER };
    const input: SavedViewInput = {
      projectId: PROJECT,
      name: 'Scoped',
      config: SAMPLE_CONFIG,
      shared: false,
    };

    await expect(service.createSavedView(context, stranger, input)).rejects.toMatchObject({
      status: 404,
    });
    expect(saved.createCalls).toBe(0);
  });

  it('lets the owner edit their own view', async () => {
    const { service, saved } = savedViewService(null);
    const seeded = saved.seed({ id: 'saved-own', ownerUserId: OWNER, name: 'Before' });

    const updated = await service.updateSavedView(context, ownerMember(), seeded.id, {
      projectId: null,
      name: 'After',
      config: SAMPLE_CONFIG,
      shared: true,
    });
    expect(updated.name).toBe('After');
    expect(updated.shared).toBe(true);
    expect(saved.updateCalls).toBe(1);
  });

  it('refuses an off-owner edit at the object layer (403 for a shared view, no write)', async () => {
    const { service, saved } = savedViewService(null);
    saved.seed({ id: 'saved-theirs', ownerUserId: OTHER_USER, name: 'Theirs', shared: true });

    await expect(
      service.updateSavedView(context, ownerMember(), 'saved-theirs', {
        projectId: null,
        name: 'Hijack',
        config: SAMPLE_CONFIG,
        shared: true,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(saved.updateCalls).toBe(0);
  });

  it('hides a private view the caller does not own behind a 404 on edit (no write)', async () => {
    const { service, saved } = savedViewService(null);
    saved.seed({ id: 'saved-hidden', ownerUserId: OTHER_USER, name: 'Hidden', shared: false });

    await expect(
      service.updateSavedView(context, ownerMember(), 'saved-hidden', {
        projectId: null,
        name: 'Peek',
        config: SAMPLE_CONFIG,
        shared: false,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(saved.updateCalls).toBe(0);
  });

  it('returns 404 when the view does not exist in the tenant', async () => {
    const { service } = savedViewService(null);
    await expect(
      service.updateSavedView(context, ownerMember(), 'saved-missing', {
        projectId: null,
        name: 'X',
        config: SAMPLE_CONFIG,
        shared: false,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
