import { describe, expect, it } from 'vitest';
import { DeliveryFlowRepository, emptyDeliveryFlowCounts } from './delivery-flow.repository.js';
import type { ListWorkItemsOptions, WorkItemsRepository } from '../work/work-items.repository.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * INS-01's roll-up behaviour, database-free over the module's fakes. The underlying work reads
 * are already DB-proven (WORK-001), so the delivery-flow tally needs no `.db.test.ts`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';

/** Only the fields the roll-up reads: id (keyset), tenancy, audience, state, soft-delete. */
function item(overrides: Partial<WorkItemRow>): WorkItemRow {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    audience: 'internal',
    state: 'in_progress',
    deletedAt: null,
    ...overrides,
  } as unknown as WorkItemRow;
}

/**
 * A fake `list` that mirrors the real query's project/soft-delete/audience/keyset predicates but
 * NOT the tenant scope, so a cross-tenant row reaches the roll-up and must be dropped by `keep` —
 * belt-and-braces to the tenant-scoped SQL, exactly as `WorkItemsService.list` proves.
 */
function repoWith(rows: readonly WorkItemRow[]): DeliveryFlowRepository {
  const workItems = {
    list: async (_runner: unknown, _context: unknown, options: ListWorkItemsOptions = {}) =>
      rows.filter(
        (row) =>
          (options.projectId === undefined || row.projectId === options.projectId) &&
          row.deletedAt === null &&
          (options.audiences === undefined || options.audiences.includes(row.audience)) &&
          (options.after === undefined || row.id > options.after),
      ),
  } as unknown as WorkItemsRepository;
  return new DeliveryFlowRepository(workItems);
}

const runner = {} as unknown as TenantQueryRunner;
const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

/** The service's per-row authorization, reduced here to the tenant check the fake needs proved. */
const sameTenant = (row: WorkItemRow) => row.organizationId === ORG;

describe('DeliveryFlowRepository.deliveryFlow', () => {
  it('tallies a mix of workflow statuses and excludes a cross-tenant item', async () => {
    const rows = [
      item({ id: 'work-a-0000000000-0000-000000000001', state: 'backlog' }),
      item({ id: 'work-b-0000000000-0000-000000000002', state: 'in_progress' }),
      item({ id: 'work-c-0000000000-0000-000000000003', state: 'in_progress' }),
      item({ id: 'work-d-0000000000-0000-000000000004', state: 'done' }),
      // Another tenant's row, returned by the fake but never this project's business.
      item({ id: 'work-z-0000000000-0000-000000000009', state: 'done', organizationId: OTHER_ORG }),
    ];

    const rollup = await repoWith(rows).deliveryFlow(runner, context, PROJECT, {
      keep: sameTenant,
    });

    expect(rollup.counts).toEqual({
      backlog: 1,
      ready: 0,
      in_progress: 2,
      blocked: 0,
      internal_review: 0,
      done: 1,
      archived: 0,
    });
    expect(rollup.itemCount).toBe(4);
    // The other tenant's row never contributes.
    expect(JSON.stringify(rollup)).not.toContain(OTHER_ORG);
  });

  it('rolls an empty project up to the documented empty value: every status zero', async () => {
    const rollup = await repoWith([]).deliveryFlow(runner, context, PROJECT, { keep: sameTenant });

    expect(rollup.counts).toEqual(emptyDeliveryFlowCounts());
    expect(rollup.itemCount).toBe(0);
  });
});
