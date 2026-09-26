import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { InsightsService } from './insights.service.js';
import type { DeliveryFlowRepository } from './delivery-flow.repository.js';
import type { ApprovalCycleRepository } from './approval-cycle.repository.js';
import type {
  ListOpenProjectItemsOptions,
  WorkloadRepository,
} from '../work-views/workload.repository.js';
import type { ListProjectsOptions, ProjectsRepository } from '../projects/projects.repository.js';
import type { ProjectRow, WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * INS-05 — the org-wide workload/capacity portfolio roll-up. Database-free proofs over the module's
 * fakes with the **real** `authorize`: the per-project open-work read (x99 / WK-06) and the project
 * enumeration are already DB-proven, so the roll-up's scoping and aggregation need no `.db.test.ts`.
 *
 * The security properties proven here are the ones the composition owns, not the guard's:
 *   - a cross-tenant project that reaches the loop is excluded by the belt-and-braces relation
 *     check (Known-trap: resolve/scope before the relation check) — never a 500;
 *   - a non-org-wide principal sees only the projects they are on — no cross-project leak;
 *   - a principal off every project gets an empty roll-up, not a refusal;
 *   - a principal whose role does not grant `work.read` (a client) contributes nothing — the
 *     defence-in-depth analogue of the route's `work.read` ceiling, whose 403 the e2e journey proves.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT_A = 'project-0000-0000-0000-0000-0000000000a1';
const PROJECT_B = 'project-0000-0000-0000-0000-0000000000b2';
const FOREIGN_PROJECT = 'project-0000-0000-0000-0000-0000000000f9';

const DATED = new Date('2026-02-01T09:00:00.000Z');

/** Only the fields the roll-up reads on a project: id and tenancy (for `mayReadProject`). */
function project(overrides: Partial<ProjectRow>): ProjectRow {
  return {
    id: PROJECT_A,
    organizationId: ORG,
    archivedAt: null,
    ...overrides,
  } as unknown as ProjectRow;
}

/** Only the fields the roll-up reads on a work item: id, tenancy/audience, dates, owner, state. */
function item(overrides: Partial<WorkItemRow>): WorkItemRow {
  return {
    id: 'work-x-0000000000-0000-000000000000',
    organizationId: ORG,
    projectId: PROJECT_A,
    audience: 'internal',
    state: 'in_progress',
    ownerUserId: null,
    startAt: null,
    dueAt: null,
    deletedAt: null,
    ...overrides,
  } as unknown as WorkItemRow;
}

function orgWide(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'org_admin',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function member(projectIds: readonly string[]): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000002',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'membership-0000-0000-000000000002',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

function client(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000003',
    organizationId: ORG,
    kind: 'client',
    role: 'client_admin',
    membershipId: 'membership-0000-0000-000000000003',
    membershipStatus: 'active',
    clientOrganizationId: 'client-org-0000-0000-000000000001',
    projectIds: [PROJECT_A, PROJECT_B],
    hasOrgWideScope: false,
  };
}

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

/**
 * A service whose project enumeration returns exactly `projectRows` **unscoped** (so a cross-tenant
 * row reaches the loop and must be dropped by `mayReadProject`), and whose workload read returns the
 * open items for the asked project out of `itemRows`, mirroring the real read's project /
 * open-state / audience / soft-delete filters (but not its tenant scope, belt-and-braces again).
 */
function serviceWith(
  projectRows: readonly ProjectRow[],
  itemRows: readonly WorkItemRow[],
): InsightsService {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const projects = {
    list: async (_runner: unknown, _context: unknown, options: ListProjectsOptions = {}) => {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      return projectRows.slice(0, limit);
    },
  } as unknown as ProjectsRepository;

  const workload = {
    listOpenProjectItems: async (
      _runner: unknown,
      _context: unknown,
      projectId: string,
      openStates: readonly WorkItemRow['state'][],
      options: ListOpenProjectItemsOptions = {},
    ) =>
      itemRows.filter(
        (row) =>
          row.projectId === projectId &&
          row.deletedAt === null &&
          openStates.includes(row.state) &&
          (options.audiences === undefined || options.audiences.includes(row.audience)),
      ),
  } as unknown as WorkloadRepository;

  return new InsightsService(
    database,
    {} as unknown as DeliveryFlowRepository,
    {} as unknown as ApprovalCycleRepository,
    workload,
    projects,
  );
}

describe('InsightsService.orgWorkload', () => {
  it('rolls every readable project up for an org-wide principal, heaviest first, with a distinct-assignee capacity total', async () => {
    const projectRows = [project({ id: PROJECT_A }), project({ id: PROJECT_B })];
    const itemRows = [
      // Project A: three open items — two on the calendar, owned by two people.
      item({
        id: 'work-a1-000000000-0000-000000000001',
        projectId: PROJECT_A,
        ownerUserId: 'u1',
        startAt: DATED,
      }),
      item({
        id: 'work-a2-000000000-0000-000000000002',
        projectId: PROJECT_A,
        ownerUserId: 'u2',
        dueAt: DATED,
      }),
      item({ id: 'work-a3-000000000-0000-000000000003', projectId: PROJECT_A, ownerUserId: null }),
      // Project A: a done item is not open work and must not inflate the count.
      item({
        id: 'work-a4-000000000-0000-000000000004',
        projectId: PROJECT_A,
        state: 'done',
        ownerUserId: 'u9',
      }),
      // Project B: one open item, owned by u1 again (counted once org-wide).
      item({ id: 'work-b1-000000000-0000-000000000001', projectId: PROJECT_B, ownerUserId: 'u1' }),
    ];

    const view = await serviceWith(projectRows, itemRows).orgWorkload(context, orgWide());

    // Heaviest first: A (3 open) before B (1 open).
    expect(view.projects.map((p) => p.projectId)).toEqual([PROJECT_A, PROJECT_B]);
    expect(view.projects[0]).toMatchObject({
      projectId: PROJECT_A,
      openItemCount: 3,
      scheduledItemCount: 2,
      assigneeCount: 2,
    });
    expect(view.projects[1]).toMatchObject({
      projectId: PROJECT_B,
      openItemCount: 1,
      scheduledItemCount: 0,
      assigneeCount: 1,
    });
    // Totals: 4 open, 2 scheduled, 2 projects; u1/u2 distinct across projects -> capacity 2.
    expect(view.totals).toEqual({
      projectCount: 2,
      assigneeCount: 2,
      openItemCount: 4,
      scheduledItemCount: 2,
    });
    expect(typeof view.computedAt).toBe('string');
  });

  it('excludes a cross-tenant project that reaches the loop — Known-trap, never a 500', async () => {
    const projectRows = [
      project({ id: PROJECT_A }),
      project({ id: FOREIGN_PROJECT, organizationId: OTHER_ORG }),
    ];
    const itemRows = [
      item({ id: 'work-a1-000000000-0000-000000000001', projectId: PROJECT_A, ownerUserId: 'u1' }),
      // Even if the foreign project's items were reachable, it never enters the aggregate.
      item({
        id: 'work-f1-000000000-0000-000000000001',
        projectId: FOREIGN_PROJECT,
        organizationId: OTHER_ORG,
        ownerUserId: 'u5',
      }),
    ];

    const view = await serviceWith(projectRows, itemRows).orgWorkload(context, orgWide());

    expect(view.projects.map((p) => p.projectId)).toEqual([PROJECT_A]);
    expect(view.totals.projectCount).toBe(1);
    expect(view.totals.openItemCount).toBe(1);
  });

  it('gives a non-org-wide principal only the projects they are on — no cross-project leak', async () => {
    const projectRows = [project({ id: PROJECT_A }), project({ id: PROJECT_B })];
    const itemRows = [
      item({ id: 'work-a1-000000000-0000-000000000001', projectId: PROJECT_A, ownerUserId: 'u1' }),
      item({ id: 'work-b1-000000000-0000-000000000001', projectId: PROJECT_B, ownerUserId: 'u2' }),
    ];

    const view = await serviceWith(projectRows, itemRows).orgWorkload(context, member([PROJECT_B]));

    expect(view.projects.map((p) => p.projectId)).toEqual([PROJECT_B]);
    expect(view.totals.projectCount).toBe(1);
    expect(view.totals.openItemCount).toBe(1);
  });

  it('returns an empty roll-up (not a refusal) for a principal off every project', async () => {
    const projectRows = [project({ id: PROJECT_A }), project({ id: PROJECT_B })];
    const itemRows = [
      item({ id: 'work-a1-000000000-0000-000000000001', projectId: PROJECT_A, ownerUserId: 'u1' }),
    ];

    const view = await serviceWith(projectRows, itemRows).orgWorkload(context, member([]));

    expect(view.projects).toEqual([]);
    expect(view.totals).toEqual({
      projectCount: 0,
      assigneeCount: 0,
      openItemCount: 0,
      scheduledItemCount: 0,
    });
  });

  it('contributes nothing for a principal whose role does not grant work.read (client) — defence in depth for the route ceiling', async () => {
    const projectRows = [project({ id: PROJECT_A }), project({ id: PROJECT_B })];
    const itemRows = [
      // client-readable audience, so the audience filter alone would not exclude it — the
      // internal-only work.read ceiling is what does, at the project relation check.
      item({
        id: 'work-a1-000000000-0000-000000000001',
        projectId: PROJECT_A,
        audience: 'client_visible',
        ownerUserId: 'u1',
      }),
    ];

    const view = await serviceWith(projectRows, itemRows).orgWorkload(context, client());

    expect(view.projects).toEqual([]);
    expect(view.totals.projectCount).toBe(0);
  });

  it('bounds the roll-up: clamps the requested project limit to 50 and defaults to 20', async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      project({ id: `project-0000-0000-0000-0000-0000000${String(index).padStart(5, '0')}` }),
    );

    const clamped = await serviceWith(many, []).orgWorkload(context, orgWide(), { limit: 999 });
    expect(clamped.totals.projectCount).toBe(50);

    const defaulted = await serviceWith(many, []).orgWorkload(context, orgWide());
    expect(defaulted.totals.projectCount).toBe(20);
  });
});
