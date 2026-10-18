import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { CostCenterReportController } from './cost-center-report.controller.js';
import { CostCenterReportService } from './cost-center-report.service.js';
import type {
  CostCenterAssignmentRow,
  CostCenterDefRow,
  CostCenterReportRepository,
  ProjectBudgetFigureRow,
} from './cost-center-report.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Billing cost-centre report (x331) proofs, database-free over a fake repository with the *real*
 * `authorize` (the controller delegates to a real {@link CostCenterReportService} built on the fake).
 * The tenant-scoped SQL is the chain's DB suite, not here; this file proves the slice's own security
 * and roll-up logic: the owner roll-up (project count, summed hours/amount, a cost centre with no
 * assignments showing zeroes, and mixed currencies collapsing to `null`) with no tenant id echoed, and
 * — the refusal the brief names — a caller without `org.manage` that is a 403 **before any read**, and
 * another tenant's rows never entering the aggregate.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';

function principal(role: Principal['role']): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

interface Seed {
  readonly defs: readonly (CostCenterDefRow & { readonly organizationId: string })[];
  readonly assignments: readonly (CostCenterAssignmentRow & { readonly organizationId: string })[];
  readonly budgets: readonly (ProjectBudgetFigureRow & { readonly organizationId: string })[];
}

function controllerWith(seed: Seed) {
  let reads = 0;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => {
      reads += 1;
      return work({});
    },
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  // Every repository method scopes to ctx.organizationId, the way the real tenant guard does, so a row
  // seeded for OTHER_ORG can never enter the roll-up.
  const repository = {
    listDefs: async (_runner: unknown, ctx: TenantContext) =>
      seed.defs
        .filter((row) => row.organizationId === ctx.organizationId)
        .sort((a, b) => a.code.localeCompare(b.code))
        .map(({ id, code, name }) => ({ id, code, name })),
    listAssignments: async (_runner: unknown, ctx: TenantContext) =>
      seed.assignments
        .filter((row) => row.organizationId === ctx.organizationId)
        .map(({ code, projectId }) => ({ code, projectId })),
    listBudgetsForProjects: async (
      _runner: unknown,
      ctx: TenantContext,
      projectIds: readonly string[],
    ) =>
      seed.budgets
        .filter(
          (row) => row.organizationId === ctx.organizationId && projectIds.includes(row.projectId),
        )
        .map(({ projectId, budgetMinutes, budgetAmountMinor, currency }) => ({
          projectId,
          budgetMinutes,
          budgetAmountMinor,
          currency,
        })),
  } as unknown as CostCenterReportRepository;

  const service = new CostCenterReportService(database, repository);
  return { controller: new CostCenterReportController(service), reads: () => reads };
}

describe('CostCenterReportController', () => {
  it('rolls up project count and summed budget, zeroes an unassigned centre, and never echoes the tenant id', async () => {
    const { controller } = controllerWith({
      defs: [
        { organizationId: ORG, id: 'cc-eng', code: 'ENG', name: 'Engineering' },
        { organizationId: ORG, id: 'cc-ops', code: 'OPS', name: 'Operations' },
      ],
      assignments: [
        { organizationId: ORG, code: 'ENG', projectId: 'project-a' },
        { organizationId: ORG, code: 'ENG', projectId: 'project-b' },
      ],
      budgets: [
        // 90 + 30 minutes = 2 hours; 100_00 + 50_00 = 150_00 minor, both USD.
        {
          organizationId: ORG,
          projectId: 'project-a',
          budgetMinutes: 90,
          budgetAmountMinor: 10_000,
          currency: 'USD',
        },
        {
          organizationId: ORG,
          projectId: 'project-b',
          budgetMinutes: 30,
          budgetAmountMinor: 5_000,
          currency: 'USD',
        },
      ],
    });

    const { costCenters } = await controller.report(context, principal('owner'));

    expect(costCenters.map((c) => c.code)).toEqual(['ENG', 'OPS']);
    const eng = costCenters[0]!;
    expect(eng).toMatchObject({
      code: 'ENG',
      projectCount: 2,
      totalBudgetHours: 2,
      totalBudgetAmountMinor: 15_000,
      currency: 'USD',
    });
    expect(eng).not.toHaveProperty('organizationId');
    // A cost centre with no assignments reports zeroes and a null currency, not an omitted row.
    expect(costCenters[1]).toMatchObject({
      code: 'OPS',
      projectCount: 0,
      totalBudgetHours: 0,
      totalBudgetAmountMinor: 0,
      currency: null,
    });
  });

  it('collapses mixed currencies to a null currency while still summing the amount', async () => {
    const { controller } = controllerWith({
      defs: [{ organizationId: ORG, id: 'cc-eng', code: 'ENG', name: 'Engineering' }],
      assignments: [
        { organizationId: ORG, code: 'ENG', projectId: 'project-a' },
        { organizationId: ORG, code: 'ENG', projectId: 'project-b' },
      ],
      budgets: [
        {
          organizationId: ORG,
          projectId: 'project-a',
          budgetMinutes: null,
          budgetAmountMinor: 10_000,
          currency: 'USD',
        },
        {
          organizationId: ORG,
          projectId: 'project-b',
          budgetMinutes: null,
          budgetAmountMinor: 20_000,
          currency: 'EUR',
        },
      ],
    });

    const { costCenters } = await controller.report(context, principal('owner'));
    expect(costCenters[0]).toMatchObject({
      projectCount: 2,
      totalBudgetHours: 0,
      totalBudgetAmountMinor: 30_000,
      currency: null,
    });
  });

  it('refuses a caller without org.manage with 403 before any read', async () => {
    const { controller, reads } = controllerWith({
      defs: [{ organizationId: ORG, id: 'cc-eng', code: 'ENG', name: 'Engineering' }],
      assignments: [],
      budgets: [],
    });
    await expect(controller.report(context, principal('workspace_admin'))).rejects.toMatchObject({
      status: 403,
    });
    // The authorization decision is made before the read opens — no row is touched on a refusal.
    expect(reads()).toBe(0);
  });

  it('never counts another tenant’s cost centres, assignments or budgets', async () => {
    const { controller } = controllerWith({
      defs: [
        { organizationId: ORG, id: 'cc-eng', code: 'ENG', name: 'Engineering' },
        { organizationId: OTHER_ORG, id: 'cc-foreign', code: 'FOR', name: 'Foreign' },
      ],
      assignments: [
        { organizationId: ORG, code: 'ENG', projectId: 'project-a' },
        // A foreign tenant's assignment sharing the same code must not leak into ORG's roll-up.
        { organizationId: OTHER_ORG, code: 'ENG', projectId: 'project-foreign' },
      ],
      budgets: [
        {
          organizationId: ORG,
          projectId: 'project-a',
          budgetMinutes: 60,
          budgetAmountMinor: null,
          currency: null,
        },
        {
          organizationId: OTHER_ORG,
          projectId: 'project-foreign',
          budgetMinutes: 600,
          budgetAmountMinor: 999_999,
          currency: 'USD',
        },
      ],
    });

    const { costCenters } = await controller.report(context, principal('owner'));
    expect(costCenters.map((c) => c.code)).toEqual(['ENG']);
    expect(costCenters[0]).toMatchObject({
      projectCount: 1,
      totalBudgetHours: 1,
      totalBudgetAmountMinor: 0,
    });
  });
});
