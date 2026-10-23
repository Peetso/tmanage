import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { InsightsService } from './insights.service.js';
import { parseProjectIds } from './insights.controller.js';
import { DeliveryFlowRepository } from './delivery-flow.repository.js';
import {
  ApprovalCycleRepository,
  type ApprovalCycleListOptions,
  type ApprovalCycleReader,
} from './approval-cycle.repository.js';
import type { ListWorkItemsOptions, WorkItemsRepository } from '../work/work-items.repository.js';
import type { ListProjectsOptions, ProjectsRepository } from '../projects/projects.repository.js';
import type { ApprovalRow, ProjectRow, WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * INS-01 portfolio roll-up (x120), database-free over the module's fakes with a **real**
 * `authorize`. The underlying delivery-flow / approval-cycle reads are already DB-proven (x89/x96)
 * and the projects list is DB-proven (PROJECT-001), so the roll-up composition needs no
 * `.db.test.ts`: off-project + cross-tenant exclusion is unit-proven here, no schema change.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT_A = 'project-a-0000-0000-0000-000000000001';
const PROJECT_B = 'project-b-0000-0000-0000-000000000002';
const PROJECT_X = 'project-x-0000-0000-0000-000000000099';

/** An internal member whose only project relations are the ids given. */
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

function projectRow(id: string, overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id,
    organizationId: ORG,
    name: `Project ${id}`,
    archivedAt: null,
    ...overrides,
  } as unknown as ProjectRow;
}

function workItem(overrides: Partial<WorkItemRow>): WorkItemRow {
  return {
    organizationId: ORG,
    projectId: PROJECT_A,
    audience: 'internal',
    state: 'in_progress',
    deletedAt: null,
    ...overrides,
  } as unknown as WorkItemRow;
}

function approval(overrides: Partial<ApprovalRow>): ApprovalRow {
  return {
    organizationId: ORG,
    projectId: PROJECT_A,
    state: 'approved',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    decidedAt: new Date('2026-09-03T00:00:00.000Z'),
    ...overrides,
  } as unknown as ApprovalRow;
}

/** A keyset page: rows with `id > after`, ascending by `id`, capped at `limit`. */
function page<T extends { id: string }>(
  all: readonly T[],
  after: string | undefined,
  limit: number,
) {
  return [...all]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter((row) => after === undefined || row.id > after)
    .slice(0, limit);
}

/** A fake database whose `read` runs the unit of work with an ignored runner. */
function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_context: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
  } as unknown as TenantDatabase;
}

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

/**
 * Build the service under test. The project/work/approval fakes mirror each real query's
 * project/keyset/soft-delete/audience predicates but NOT the tenant scope, so a cross-tenant row
 * reaches the roll-up and must be dropped by the real `authorize` the service applies per row.
 */
function serviceWith(input: {
  projects: readonly ProjectRow[];
  workItems: readonly WorkItemRow[];
  approvals: readonly ApprovalRow[];
}): InsightsService {
  const projects = {
    list: async (_runner: unknown, _ctx: TenantContext, options: ListProjectsOptions = {}) =>
      page(input.projects, options.after, options.limit ?? 50),
  } as unknown as ProjectsRepository;

  const workItems = {
    list: async (_runner: unknown, _ctx: TenantContext, options: ListWorkItemsOptions = {}) =>
      page(input.workItems, options.after, options.limit ?? 200).filter(
        (row) =>
          (options.projectId === undefined || row.projectId === options.projectId) &&
          row.deletedAt === null &&
          (options.audiences === undefined || options.audiences.includes(row.audience)),
      ),
  } as unknown as WorkItemsRepository;

  const approvalsReader: ApprovalCycleReader = {
    list: async (_runner, _ctx, options: ApprovalCycleListOptions) =>
      page(input.approvals, options.after, options.limit).filter(
        (row) => row.projectId === options.projectId,
      ),
  };

  return new InsightsService(
    fakeDatabase(),
    new DeliveryFlowRepository(workItems),
    new ApprovalCycleRepository(approvalsReader),
    undefined,
    projects,
  );
}

describe('InsightsService.portfolio', () => {
  it("rolls up only the caller's accessible projects — off-project and cross-tenant excluded (no row, no throw)", async () => {
    const service = serviceWith({
      projects: [
        projectRow(PROJECT_A),
        // Same tenant, but the member has no relation to it → off-project, excluded.
        projectRow(PROJECT_B),
        // Another tenant's project, leaked by the (tenant-blind) fake → cross-tenant, excluded.
        projectRow(PROJECT_X, { organizationId: OTHER_ORG }),
      ],
      workItems: [
        workItem({
          id: 'work-a1-000000000000-000000000001',
          projectId: PROJECT_A,
          state: 'backlog',
        }),
        workItem({ id: 'work-a2-000000000000-000000000002', projectId: PROJECT_A, state: 'done' }),
        // Belongs to the off-project B and must never be counted for the caller.
        workItem({ id: 'work-b1-000000000000-000000000003', projectId: PROJECT_B, state: 'done' }),
      ],
      approvals: [
        approval({ id: 'appr-a1-000000000000-000000000001', projectId: PROJECT_A }),
        approval({ id: 'appr-b1-000000000000-000000000002', projectId: PROJECT_B }),
      ],
    });

    const view = await service.portfolio(context, member([PROJECT_A]));

    expect(view.projects.map((p) => p.projectId)).toEqual([PROJECT_A]);
    expect(view.projectCount).toBe(1);
    const only = view.projects[0]!;
    expect(only.deliveryFlow.itemCount).toBe(2);
    expect(only.deliveryFlow.counts.backlog).toBe(1);
    expect(only.deliveryFlow.counts.done).toBe(1);
    expect(only.approvalCycle.approvalCount).toBe(1);
    // No off-project or cross-tenant identifier leaks into the response.
    expect(JSON.stringify(view)).not.toContain(PROJECT_B);
    expect(JSON.stringify(view)).not.toContain(OTHER_ORG);
  });

  it('returns rows in deterministic project id order and bounds the page to the requested limit', async () => {
    const ids = [PROJECT_B, PROJECT_A, 'project-c-0000-0000-0000-000000000003'];
    const service = serviceWith({
      projects: ids.map((id) => projectRow(id)),
      workItems: [],
      approvals: [],
    });

    const view = await service.portfolio(context, member(ids), { limit: 2 });

    expect(view.projectCount).toBe(2);
    // Ascending by id — deterministic, and the same keyset order the projects list walks.
    expect(view.projects.map((p) => p.projectId)).toEqual([...ids].sort().slice(0, 2));
  });

  it('gives figures identical to the per-project reads for the same project (no divergent computation)', async () => {
    const service = serviceWith({
      projects: [projectRow(PROJECT_A)],
      workItems: [
        workItem({ id: 'work-a1-000000000000-000000000001', projectId: PROJECT_A, state: 'ready' }),
        workItem({ id: 'work-a2-000000000000-000000000002', projectId: PROJECT_A, state: 'ready' }),
      ],
      approvals: [
        approval({
          id: 'appr-a1-000000000000-000000000001',
          projectId: PROJECT_A,
          state: 'changes_requested',
        }),
      ],
    });
    const principal = member([PROJECT_A]);

    const view = await service.portfolio(context, principal);
    const directFlow = await service.projectDeliveryFlow(context, principal, PROJECT_A);
    const directCycle = await service.projectApprovalCycle(context, principal, PROJECT_A);

    const row = view.projects[0]!;
    expect(row.deliveryFlow.counts).toEqual(directFlow.counts);
    expect(row.deliveryFlow.itemCount).toBe(directFlow.itemCount);
    expect(row.approvalCycle.metrics).toEqual(directCycle.metrics);
    expect(row.approvalCycle.approvalCount).toBe(directCycle.approvalCount);
  });

  it('A13: keeps only the requested readable projects and silently drops the rest', async () => {
    const PROJECT_C = 'project-c-0000-0000-0000-000000000003';
    const service = serviceWith({
      projects: [
        projectRow(PROJECT_A),
        projectRow(PROJECT_B),
        projectRow(PROJECT_C),
        projectRow(PROJECT_X, { organizationId: OTHER_ORG }),
      ],
      workItems: [],
      approvals: [],
    });

    // Member reads A and C; asks for A, B (off-project), X (cross-tenant) and an unknown id.
    const view = await service.portfolio(context, member([PROJECT_A, PROJECT_C]), {
      projectIds: [PROJECT_A, PROJECT_B, PROJECT_X, 'project-missing'],
    });

    expect(view.projects.map((p) => p.projectId)).toEqual([PROJECT_A]);
    expect(JSON.stringify(view)).not.toContain(PROJECT_B);
    expect(JSON.stringify(view)).not.toContain(PROJECT_X);

    const all = await service.portfolio(context, member([PROJECT_A, PROJECT_C]), {
      projectIds: [],
    });
    expect(all.projects.map((p) => p.projectId)).toEqual([PROJECT_A, PROJECT_C]);
  });

  it('A13: parses ?projectIds= into a trimmed, de-duplicated, capped list', () => {
    expect(parseProjectIds(undefined)).toEqual([]);
    expect(parseProjectIds(' a, b ,,a ')).toEqual(['a', 'b']);
    const many = Array.from({ length: 80 }, (_, i) => `p${i}`).join(',');
    expect(parseProjectIds(many)).toHaveLength(50);
  });
});
