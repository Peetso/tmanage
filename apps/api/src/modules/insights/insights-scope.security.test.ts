import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { hasCapability } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { ApiError } from '../../common/http/errors.js';
import type { ApprovalRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { InsightsAdoptionController } from './adoption.controller.js';
import type { InsightsAdoptionRepository } from './adoption.repository.js';
import { emptyApprovalCycleMetrics } from './approval-cycle.repository.js';
import type { ApprovalCycleOptions, ApprovalCycleRepository } from './approval-cycle.repository.js';
import { InsightComparisonController } from './comparison.controller.js';
import { InsightComparisonService } from './comparison.service.js';
import type { DeliveryFlowRepository } from './delivery-flow.repository.js';
import { InsightsController } from './insights.controller.js';
import { InsightsService } from './insights.service.js';
import type { InsightsPortfolioView } from './insights.service.js';
import type { InsightMetricAlertsRepository } from './metric-alerts.repository.js';
import { InsightMetricAlertsService } from './metric-alerts.service.js';
import type { InsightSnapshotsRepository, SnapshotProjectScope } from './snapshots.repository.js';
import { InsightSnapshotsService } from './snapshots.service.js';

/**
 * Wave 9 lane S9 — regression proofs for audit findings F08, F21 and F39, with the real
 * `authorize`. Each block reproduces the audit's exploit and shows it now fails.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const P1 = 'project-0000-0000-0000-000000000001';
const P2 = 'project-0000-0000-0000-000000000002';
const context = { organizationId: ORG } as unknown as TenantContext;

function internal(role: Principal['role'], projectIds: string[], orgWide: boolean): Principal {
  return {
    userId: `user-${role}`,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: `membership-${role}`,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: orgWide,
  };
}

const owner = (): Principal => internal('owner', [], true);
const guestOnP1 = (): Principal => internal('guest', [P1], false);
const memberOnP1 = (): Principal => internal('member', [P1], false);

function clientOnP1(): Principal {
  return {
    userId: 'user-client',
    organizationId: ORG,
    kind: 'client',
    role: 'client_admin',
    membershipId: 'membership-client',
    membershipStatus: 'active',
    clientOrganizationId: 'client-org-1',
    projectIds: [P1],
    hasOrgWideScope: false,
  };
}

/** A database that runs each read against a dummy runner and counts how often it was touched. */
function countingDatabase(): { database: TenantDatabase; touches: () => number } {
  let touched = 0;
  const database = {
    read: async (_context: unknown, work: (runner: unknown) => Promise<unknown>) => {
      touched += 1;
      return work({});
    },
  } as unknown as TenantDatabase;
  return { database, touches: () => touched };
}

describe('F08 — org-level adoption and compare need org-wide scope', () => {
  it('refuses a guest and a project-scoped member on adoption with a 403 before any read', async () => {
    for (const principal of [guestOnP1(), memberOnP1()]) {
      const { database, touches } = countingDatabase();
      const controller = new InsightsAdoptionController(
        database,
        {} as unknown as InsightsAdoptionRepository,
      );
      await expect(controller.adoptionMetrics(context, principal, '90')).rejects.toMatchObject({
        status: 403,
      } as Partial<ApiError>);
      expect(touches()).toBe(0);
    }
  });

  it('refuses a guest and a project-scoped member on compare with a 403 before any count', async () => {
    for (const principal of [guestOnP1(), memberOnP1()]) {
      const service = new InsightComparisonService({} as unknown as TenantDatabase);
      let counted = false;
      Object.assign(service, {
        compare: async () => {
          counted = true;
          return {};
        },
      });
      const controller = new InsightComparisonController(service);
      await expect(
        controller.compare(
          context,
          principal,
          'work_items_created',
          '2026-10-01T00:00:00Z..2026-10-01T01:00:00Z',
          '2026-10-01T01:00:00Z..2026-10-01T02:00:00Z',
        ),
      ).rejects.toMatchObject({ status: 403 } as Partial<ApiError>);
      expect(counted).toBe(false);
    }
  });

  it('still lets the owner read the org-level aggregates', () => {
    const service = new InsightComparisonService({} as unknown as TenantDatabase);
    expect(service.mayReadOrgInsights(owner(), context)).toBe(true);
    const adoption = new InsightsAdoptionController(
      {} as unknown as TenantDatabase,
      {} as unknown as InsightsAdoptionRepository,
    ) as unknown as {
      mayReadOrgAdoption(principal: Principal, context: TenantContext): boolean;
    };
    expect(adoption.mayReadOrgAdoption(owner(), context)).toBe(true);
    expect(adoption.mayReadOrgAdoption(guestOnP1(), context)).toBe(false);
  });
});

const SCOPES: SnapshotProjectScope[] = [
  { id: P1, organizationId: ORG, archivedAt: null },
  { id: P2, organizationId: ORG, archivedAt: null },
];

/** A snapshot repository holding one owner-captured snapshot of each kind. */
function snapshotRepository(): InsightSnapshotsRepository {
  const cycle = (projectId: string) => ({
    projectId,
    metrics: {
      ...emptyApprovalCycleMetrics(),
      approved: { count: 3, decidedCount: 3, totalDurationMs: 9 },
    },
    approvalCount: 3,
    computedAt: '2026-10-25T00:00:00.000Z',
  });
  const portfolio = {
    projects: [
      {
        projectId: P1,
        name: 'Alpha',
        deliveryFlow: { projectId: P1, itemCount: 2 },
        approvalCycle: cycle(P1),
      },
      {
        projectId: P2,
        name: 'Secret Merger',
        deliveryFlow: { projectId: P2, itemCount: 7 },
        approvalCycle: cycle(P2),
      },
    ],
    projectCount: 2,
    computedAt: '2026-10-25T00:00:00.000Z',
  };
  const workload = {
    projects: [
      { projectId: P1, openItemCount: 2, scheduledItemCount: 1, assigneeCount: 1 },
      { projectId: P2, openItemCount: 9, scheduledItemCount: 4, assigneeCount: 5 },
    ],
    totals: { projectCount: 2, assigneeCount: 6, openItemCount: 11, scheduledItemCount: 5 },
    computedAt: '2026-10-25T00:00:00.000Z',
  };
  const row = (id: string, kind: 'portfolio' | 'workload', payloadJson: unknown) => ({
    id,
    organizationId: ORG,
    kind,
    capturedAt: new Date('2026-10-25T00:00:00.000Z'),
    payloadJson,
    createdAt: new Date('2026-10-25T00:00:00.000Z'),
  });
  const rows = [
    row('snap-portfolio', 'portfolio', portfolio),
    row('snap-workload', 'workload', workload),
  ];
  return {
    list: async (_runner: unknown, _context: unknown, kind: string) =>
      rows.filter((candidate) => candidate.kind === kind),
    findById: async (_runner: unknown, _context: unknown, id: string) =>
      rows.find((candidate) => candidate.id === id),
    projectScopes: async (_runner: unknown, _context: unknown, ids: readonly string[]) =>
      SCOPES.filter((scope) => ids.includes(scope.id)),
  } as unknown as InsightSnapshotsRepository;
}

function snapshotService(): InsightSnapshotsService {
  return new InsightSnapshotsService(
    countingDatabase().database,
    {} as unknown as InsightsService,
    snapshotRepository(),
  );
}

describe('F21 — snapshot payloads are filtered for the reader', () => {
  it("a guest on P1 reading the owner's portfolio snapshot sees only P1, counts recomputed", async () => {
    const service = snapshotService();
    const [listed] = await service.list(context, guestOnP1(), 'portfolio');
    const byId = await service.getById(context, guestOnP1(), 'snap-portfolio');
    for (const view of [listed, byId]) {
      const payload = view?.payload as InsightsPortfolioView;
      expect(payload.projects.map((project) => project.projectId)).toEqual([P1]);
      expect(payload.projectCount).toBe(1);
      expect(JSON.stringify(payload)).not.toContain('Secret Merger');
    }
  });

  it("a guest on P1 reading the owner's workload snapshot gets only P1's figures", async () => {
    const view = await snapshotService().getById(context, guestOnP1(), 'snap-workload');
    expect(view.payload).toMatchObject({
      projects: [{ projectId: P1 }],
      totals: { projectCount: 1, openItemCount: 2, scheduledItemCount: 1, assigneeCount: 1 },
    });
    expect(JSON.stringify(view.payload)).not.toContain(P2);
  });

  it('the owner still sees the whole snapshot unchanged', async () => {
    const view = await snapshotService().getById(context, owner(), 'snap-workload');
    expect(view.payload).toMatchObject({
      totals: { projectCount: 2, assigneeCount: 6, openItemCount: 11, scheduledItemCount: 5 },
    });
  });

  it("metric alerts evaluate against the reader-scoped totals, not the owner's", async () => {
    const workload = await snapshotRepository().findById({} as never, context, 'snap-workload');
    const alerts = {
      listForMember: async () => [
        { metricKey: 'open_items', comparator: 'gte', threshold: 5, memberUserId: 'user-guest' },
      ],
      latestWorkloadPayload: async () => workload?.payloadJson,
    } as unknown as InsightMetricAlertsRepository;
    const service = new InsightMetricAlertsService(
      countingDatabase().database,
      alerts,
      snapshotRepository(),
    );
    const [status] = await service.list(context, guestOnP1());
    expect(status).toMatchObject({ currentValue: 2, breached: false });
  });
});

describe('F39 — approval-cycle insight refuses client principals', () => {
  it('the route is gated on internal-only work.read, which no client role holds', () => {
    const required = Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      InsightsController.prototype.approvalCycle,
    ) as string;
    expect(required).toBe('work.read');
    expect(hasCapability('client_admin', 'work.read')).toBe(false);
    expect(hasCapability('member', 'work.read')).toBe(true);
  });

  it('the service counts no approval for a client and still counts for an internal member', async () => {
    const approval = {
      id: 'approval-1',
      organizationId: ORG,
      projectId: P1,
      state: 'changes_requested',
    } as unknown as ApprovalRow;
    const approvalCycle = {
      approvalCycle: async (
        _runner: unknown,
        _context: unknown,
        projectId: string,
        options: ApprovalCycleOptions = {},
      ) => {
        const kept = [approval].filter((row) => options.keep?.(row) ?? true);
        return { projectId, metrics: emptyApprovalCycleMetrics(), approvalCount: kept.length };
      },
    } as unknown as ApprovalCycleRepository;
    const service = new InsightsService(
      countingDatabase().database,
      {} as unknown as DeliveryFlowRepository,
      approvalCycle,
    );
    await expect(service.projectApprovalCycle(context, clientOnP1(), P1)).resolves.toMatchObject({
      approvalCount: 0,
    });
    await expect(service.projectApprovalCycle(context, memberOnP1(), P1)).resolves.toMatchObject({
      approvalCount: 1,
    });
  });
});
