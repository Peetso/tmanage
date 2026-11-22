import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { WorkloadForecastController } from './workload-forecast.controller.js';
import { WorkloadForecastService } from './workload-forecast.service.js';
import type { WorkloadForecastRepository } from './workload-forecast.repository.js';
import type { ProjectRow, WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x134 — the Insights workload forecast. Database-free proofs through the controller with the **real**
 * `authorize` and a fake repository, mirroring INS-05's `insights-workload.test.ts`: the per-project
 * open-work read and the project enumeration are already DB-proven, so the forecast's scoping,
 * bucketing and horizon validation need no `.db.test.ts`.
 *
 * The behaviours proven here are the ones x134 owns:
 *   - the projection buckets committed (open + dated) work into the upcoming weeks and flags a week
 *     over the constant per-member capacity — done/undated/beyond-horizon work does not count;
 *   - a cross-tenant project that reaches the loop is excluded (Known-trap) — tenant-scoped;
 *   - a client (whom `work.read` never grants) contributes nothing — defence in depth for the
 *     route's `work.read` ceiling, whose 403 the chain's e2e proves;
 *   - `?weeks` out of `[1, 12]` (or non-integer) is a 400, not a silent clamp.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT_A = 'project-0000-0000-0000-0000-0000000000a1';
const FOREIGN_PROJECT = 'project-0000-0000-0000-0000-0000000000f9';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Only the fields the forecast reads on a project: id and tenancy (for `mayReadProject`). */
function project(overrides: Partial<ProjectRow>): ProjectRow {
  return {
    id: PROJECT_A,
    organizationId: ORG,
    archivedAt: null,
    ...overrides,
  } as unknown as ProjectRow;
}

/** Only the fields the forecast reads on a work item: id, tenancy/audience, due date, owner, state. */
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

function client(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000003',
    organizationId: ORG,
    kind: 'client',
    role: 'client_admin',
    membershipId: 'membership-0000-0000-000000000003',
    membershipStatus: 'active',
    clientOrganizationId: 'client-org-0000-0000-000000000001',
    projectIds: [PROJECT_A],
    hasOrgWideScope: false,
  };
}

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

/**
 * A controller wired to a real service over a fake repository: the enumeration returns `projectRows`
 * **unscoped** (so a cross-tenant row reaches the loop and must be dropped by `mayReadProject`), and
 * the item read returns the open, non-deleted items for the asked project out of `itemRows`.
 */
function controllerWith(
  projectRows: readonly ProjectRow[],
  itemRows: readonly WorkItemRow[],
  aiOwners: readonly string[] = [],
): WorkloadForecastController {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    aiUserIds: async () => new Set<string>(aiOwners),
    listProjects: async (_runner: unknown, _context: unknown, options: { limit?: number } = {}) =>
      projectRows.slice(0, options.limit ?? projectRows.length),
    listOpenProjectItems: async (
      _runner: unknown,
      _context: unknown,
      projectId: string,
      openStates: readonly WorkItemRow['state'][],
      options: { audiences?: readonly WorkItemRow['audience'][] } = {},
    ) =>
      itemRows.filter(
        (row) =>
          row.projectId === projectId &&
          row.deletedAt === null &&
          openStates.includes(row.state) &&
          (options.audiences === undefined || options.audiences.includes(row.audience)),
      ),
  } as unknown as WorkloadForecastRepository;

  return new WorkloadForecastController(new WorkloadForecastService(database, repository));
}

describe('WorkloadForecastController.workloadForecast', () => {
  it('buckets committed work into the upcoming weeks and flags a week over capacity', async () => {
    // One owner -> capacity 5/week. Week 1 gets 6 committed items (over), week 2 gets 1 (under).
    const dueInDays = (days: number) => new Date(Date.now() + days * DAY_MS);
    const week1 = Array.from({ length: 6 }, (_, i) =>
      item({ id: `work-w1-00000000-0000-00000000000${i}`, ownerUserId: 'u1', dueAt: dueInDays(2) }),
    );
    const itemRows = [
      ...week1,
      item({ id: 'work-w2-00000000-0000-000000000001', ownerUserId: 'u1', dueAt: dueInDays(9) }),
      // Undated open work is not committed to a week; a done item is not open; work beyond the
      // horizon does not count. None of these three change any bucket.
      item({ id: 'work-un-00000000-0000-000000000001', ownerUserId: 'u1', dueAt: null }),
      item({ id: 'work-dn-00000000-0000-000000000001', state: 'done', dueAt: dueInDays(2) }),
      item({ id: 'work-fa-00000000-0000-000000000001', ownerUserId: 'u1', dueAt: dueInDays(60) }),
    ];

    const view = await controllerWith([project({ id: PROJECT_A })], itemRows).workloadForecast(
      context,
      orgWide(),
      '3',
    );

    expect(view.weeks).toHaveLength(3);
    expect(view.weeks.map((w) => w.committedItemCount)).toEqual([6, 1, 0]);
    expect(view.weeks.map((w) => w.overCapacity)).toEqual([true, false, false]);
    expect(view.weeks[0]).toMatchObject({ weekIndex: 1, capacity: 5 });
    expect(view.totals).toMatchObject({
      weeks: 3,
      memberCount: 1,
      committedItemCount: 7,
      capacity: 15,
      overCapacityWeekCount: 1,
    });
    expect(typeof view.computedAt).toBe('string');
  });

  it('60-09: counts an AI employee’s open work but adds no capacity for it', async () => {
    const dueInDays = (days: number) => new Date(Date.now() + days * DAY_MS);
    const itemRows = [
      item({ id: 'work-p1-00000000-0000-000000000001', ownerUserId: 'u1', dueAt: dueInDays(2) }),
      item({ id: 'work-ai-00000000-0000-000000000001', ownerUserId: 'u-ai', dueAt: dueInDays(2) }),
    ];
    const view = await controllerWith([project({ id: PROJECT_A })], itemRows, [
      'u-ai',
    ]).workloadForecast(context, orgWide(), '1');
    expect(view.totals).toMatchObject({ memberCount: 1, committedItemCount: 2, capacity: 5 });
  });

  it('excludes a cross-tenant project that reaches the loop — Known-trap, never a 500', async () => {
    const projectRows = [
      project({ id: PROJECT_A }),
      project({ id: FOREIGN_PROJECT, organizationId: OTHER_ORG }),
    ];
    const itemRows = [
      item({
        id: 'work-a1-00000000-0000-000000000001',
        ownerUserId: 'u1',
        dueAt: new Date(Date.now() + DAY_MS),
      }),
      item({
        id: 'work-f1-00000000-0000-000000000001',
        projectId: FOREIGN_PROJECT,
        organizationId: OTHER_ORG,
        ownerUserId: 'u5',
        dueAt: new Date(Date.now() + DAY_MS),
      }),
    ];

    const view = await controllerWith(projectRows, itemRows).workloadForecast(
      context,
      orgWide(),
      '2',
    );

    expect(view.totals.committedItemCount).toBe(1);
    expect(view.totals.memberCount).toBe(1);
  });

  it('contributes nothing for a client (work.read never granted) — defence in depth for the route ceiling', async () => {
    const itemRows = [
      item({
        id: 'work-a1-00000000-0000-000000000001',
        audience: 'client_visible',
        ownerUserId: 'u1',
        dueAt: new Date(Date.now() + DAY_MS),
      }),
    ];

    const view = await controllerWith([project({ id: PROJECT_A })], itemRows).workloadForecast(
      context,
      client(),
      '2',
    );

    expect(view.totals.committedItemCount).toBe(0);
    expect(view.totals.memberCount).toBe(0);
    expect(view.weeks.every((w) => w.committedItemCount === 0)).toBe(true);
  });

  it('defaults the horizon to 4 weeks when ?weeks is absent', async () => {
    const view = await controllerWith([project({ id: PROJECT_A })], []).workloadForecast(
      context,
      orgWide(),
      undefined,
    );
    expect(view.weeks).toHaveLength(4);
    expect(view.totals.weeks).toBe(4);
  });

  it('rejects ?weeks out of [1, 12] or non-integer with a 400', async () => {
    const controller = controllerWith([project({ id: PROJECT_A })], []);
    for (const bad of ['0', '13', 'abc', '2.5', '-1']) {
      await expect(controller.workloadForecast(context, orgWide(), bad)).rejects.toMatchObject({
        status: 400,
        code: 'validation_failed',
      });
      await expect(controller.workloadForecast(context, orgWide(), bad)).rejects.toBeInstanceOf(
        ApiError,
      );
    }
  });
});
