import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkflowRunHistoryController } from './history.controller.js';
import type { WorkflowRunHistoryRepository } from './history.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkflowRunRow } from '../../common/database/schema.js';

/**
 * Automations run-history (x164) controller proofs, database-free over fakes with the *real*
 * `authorize`. The migration and the tenant-scoped SQL round-trip are the chain's DB suite, not here;
 * this file proves the controller's own security logic: the list returns the tenant's runs newest-first
 * behind `org.manage` (403 without it); an off-list `status` filter is a 400; and on the detail route
 * the run is resolved tenant-scoped BEFORE authorize, so a cross-tenant or unknown id is a 404, never a
 * 403 that would confirm another studio's run exists.
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

function run(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: 'workflow-run-01',
    organizationId: ORG,
    templateId: 'workflow-template-01',
    status: 'succeeded',
    detailJson: { outcome: 'ran', actionKind: 'notify_owner' },
    startedAt: new Date('2026-09-27T11:00:00.000Z'),
    finishedAt: new Date('2026-09-27T11:00:00.000Z'),
    ...overrides,
  };
}

function controllerWith(runs: readonly WorkflowRunRow[]) {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const historyRepository = {
    list: async (
      _runner: unknown,
      ctx: TenantContext,
      options: { status?: string } = {},
    ): Promise<readonly WorkflowRunRow[]> =>
      runs
        .filter(
          (row) =>
            row.organizationId === ctx.organizationId &&
            (options.status === undefined || row.status === options.status),
        )
        // Newest first, as the repository orders it.
        .slice()
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()),
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      runs.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
  } as unknown as WorkflowRunHistoryRepository;

  return new WorkflowRunHistoryController(database, historyRepository);
}

describe('WorkflowRunHistoryController', () => {
  it('lists the org-scoped runs newest first behind org.manage', async () => {
    const controller = controllerWith([
      run({ id: 'run-old', startedAt: new Date('2026-09-27T09:00:00.000Z') }),
      run({ id: 'run-new', startedAt: new Date('2026-09-27T12:00:00.000Z') }),
      run({ id: 'run-other', organizationId: OTHER_ORG }),
    ]);
    const { runs } = await controller.list(context, principal('owner'));

    expect(runs.map((r) => r.id)).toEqual(['run-new', 'run-old']);
    expect(runs[0]).not.toHaveProperty('organizationId');
    // The list projection omits detail; it is read one at a time on the detail route.
    expect(runs[0]).not.toHaveProperty('detail');
  });

  it('rejects an off-list status filter with 400', async () => {
    const controller = controllerWith([run()]);
    await expect(controller.list(context, principal('owner'), 'deleted')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('filters the list by an allowlisted status', async () => {
    const controller = controllerWith([
      run({ id: 'run-ok', status: 'succeeded' }),
      run({ id: 'run-bad', status: 'failed' }),
    ]);
    const { runs } = await controller.list(context, principal('owner'), 'failed');
    expect(runs.map((r) => r.id)).toEqual(['run-bad']);
  });

  it('refuses a role without org.manage with 403 on the list', async () => {
    // org_admin holds every capability except `org.manage` (capabilities.ts), so it is denied here.
    const controller = controllerWith([run()]);
    await expect(controller.list(context, principal('org_admin'))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('returns one run detail behind org.manage', async () => {
    const controller = controllerWith([run()]);
    const view = await controller.detail(context, principal('owner'), 'workflow-run-01');
    expect(view.id).toBe('workflow-run-01');
    expect(view.detail).toMatchObject({ outcome: 'ran' });
    expect(view).not.toHaveProperty('organizationId');
  });

  it('returns 404 for a cross-tenant run id (resolve before authorize)', async () => {
    const controller = controllerWith([run({ id: 'run-other', organizationId: OTHER_ORG })]);
    await expect(controller.detail(context, principal('owner'), 'run-other')).rejects.toMatchObject(
      { status: 404 },
    );
  });

  it('returns 404 for an unknown run id', async () => {
    const controller = controllerWith([run()]);
    await expect(
      controller.detail(context, principal('owner'), 'workflow-run-missing'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a role without org.manage with 403 on an existing run detail', async () => {
    const controller = controllerWith([run()]);
    await expect(
      controller.detail(context, principal('org_admin'), 'workflow-run-01'),
    ).rejects.toMatchObject({ status: 403 });
  });
});
