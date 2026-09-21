import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkViewsService } from './work-views.service.js';
import type { SavedViewInput } from './work-views.service.js';
import type { TimelineItemRow, WorkTimelineRepository } from './timeline.repository.js';
import type {
  CreateSavedViewInput,
  SavedViewsRepository,
  UpdateSavedViewInput,
} from './saved-views.repository.js';
import type { PredecessorHealthRow } from '../work/work-graph.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRow, SavedViewRow, WorkItemRow } from '../../common/database/schema.js';

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
