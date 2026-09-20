import { describe, expect, it } from 'vitest';
import {
  APPROVAL_CYCLE_PAGE_SIZE,
  ApprovalCycleRepository,
  emptyApprovalCycleMetrics,
} from './approval-cycle.repository.js';
import type { ApprovalCycleListOptions, ApprovalCycleReader } from './approval-cycle.repository.js';
import type { ApprovalRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * INS-02's roll-up behaviour, database-free over the module's fakes. The approvals reads are
 * already DB-proven (FR-05, x92), so the approval-cycle tally needs no `.db.test.ts` — the same
 * posture INS-01's delivery-flow test takes over the DB-proven work reads.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';

/** Only the fields the roll-up reads: id (keyset), tenancy, project, state, request/decide times. */
function approval(overrides: Partial<ApprovalRow>): ApprovalRow {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    state: 'requested',
    createdAt: new Date(0),
    decidedAt: null,
    ...overrides,
  } as unknown as ApprovalRow;
}

/**
 * A fake `list` that mirrors the real query's project/keyset predicates and page limit but NOT the
 * tenant scope, so a cross-tenant row reaches the roll-up and must be dropped by `keep` —
 * belt-and-braces to the tenant-scoped SQL, exactly as INS-01's fake proves. It sorts by id and
 * honours `after` + `limit`, so paging over it exercises the real keyset continuation.
 */
function repoWith(rows: readonly ApprovalRow[]): ApprovalCycleRepository {
  const reader: ApprovalCycleReader = {
    list: async (
      _runner: TenantQueryRunner,
      _context: TenantContext,
      options: ApprovalCycleListOptions,
    ) =>
      [...rows]
        .filter((row) => row.projectId === options.projectId)
        .filter((row) => options.after === undefined || row.id > options.after)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, options.limit),
  };
  return new ApprovalCycleRepository(reader);
}

const runner = {} as unknown as TenantQueryRunner;
const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

/** The service's per-row authorization, reduced here to the tenant check the fake needs proved. */
const sameTenant = (row: ApprovalRow) => row.organizationId === ORG;

describe('ApprovalCycleRepository.approvalCycle', () => {
  it('rolls decided approvals up by outcome with durations, excludes pending and cross-tenant', async () => {
    const rows = [
      approval({
        id: 'approval-0000-0000-0000-000000000001',
        state: 'approved',
        createdAt: new Date(1_000),
        decidedAt: new Date(2_000),
      }),
      approval({
        id: 'approval-0000-0000-0000-000000000002',
        state: 'approved',
        createdAt: new Date(1_000),
        decidedAt: new Date(4_000),
      }),
      approval({
        id: 'approval-0000-0000-0000-000000000003',
        state: 'changes_requested',
        createdAt: new Date(0),
        decidedAt: new Date(5_000),
      }),
      // Invalidated records a reason, never a decision time (§8) — counts, adds no duration.
      approval({
        id: 'approval-0000-0000-0000-000000000004',
        state: 'invalidated',
        createdAt: new Date(0),
        decidedAt: null,
      }),
      // Still pending — not an outcome, never part of an outcome roll-up.
      approval({ id: 'approval-0000-0000-0000-000000000005', state: 'requested' }),
      approval({ id: 'approval-0000-0000-0000-000000000006', state: 'viewed' }),
      // Another tenant's decided approval, returned by the fake but never this project's business.
      approval({
        id: 'approval-0000-0000-0000-000000000009',
        state: 'approved',
        organizationId: OTHER_ORG,
        createdAt: new Date(0),
        decidedAt: new Date(9_000),
      }),
    ];

    const rollup = await repoWith(rows).approvalCycle(runner, context, PROJECT, {
      keep: sameTenant,
    });

    expect(rollup.metrics).toEqual({
      approved: { count: 2, decidedCount: 2, totalDurationMs: 4_000 },
      changes_requested: { count: 1, decidedCount: 1, totalDurationMs: 5_000 },
      invalidated: { count: 1, decidedCount: 0, totalDurationMs: 0 },
    });
    expect(rollup.approvalCount).toBe(4);
    // The other tenant's row never contributes.
    expect(JSON.stringify(rollup)).not.toContain(OTHER_ORG);
  });

  it('walks every page: a project with more than one keyset page counts each row once', async () => {
    // One more than a full page, so the walk must continue past `after = last.id` to a second
    // page — the continuation INS-01's first test could not reach (x89-review Minor-1).
    const total = APPROVAL_CYCLE_PAGE_SIZE + 1;
    const rows = Array.from({ length: total }, (_unused, index) =>
      approval({
        id: `approval-page-${String(index).padStart(6, '0')}-000000000000`,
        state: 'approved',
        createdAt: new Date(1_000),
        decidedAt: new Date(2_000),
      }),
    );

    const rollup = await repoWith(rows).approvalCycle(runner, context, PROJECT, {
      keep: sameTenant,
    });

    expect(rollup.approvalCount).toBe(total);
    expect(rollup.metrics.approved).toEqual({
      count: total,
      decidedCount: total,
      totalDurationMs: total * 1_000,
    });
  });

  it('rolls an empty project up to the documented empty value: every outcome zero', async () => {
    const rollup = await repoWith([]).approvalCycle(runner, context, PROJECT, { keep: sameTenant });

    expect(rollup.metrics).toEqual(emptyApprovalCycleMetrics());
    expect(rollup.approvalCount).toBe(0);
  });
});
