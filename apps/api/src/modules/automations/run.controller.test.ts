import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkflowRunController } from './run.controller.js';
import { WorkflowRunService } from './run.service.js';
import type { WorkflowTemplatesRepository } from './templates.repository.js';
import type { WorkflowRunsRepository } from './run.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkflowRunRow, WorkflowTemplateRow } from '../../common/database/schema.js';

/**
 * Automations workflow-run (x163) controller proofs, database-free over fakes with the *real*
 * `authorize` and the *real* {@link WorkflowRunService}. The migration and the tenant-scoped SQL
 * round-trip are the chain's DB suite, not here; this file proves the controller's own security logic:
 * resolve-before-authorize (cross-tenant/unknown id → 404 with no write), the org-scoped `org.manage`
 * decision (403), a disabled template (409, no run), the in-app-only execution boundary (an external
 * action records a failed run rather than any egress), and the succeeded path writing exactly one run.
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

function template(overrides: Partial<WorkflowTemplateRow> = {}): WorkflowTemplateRow {
  return {
    id: 'workflow-template-01',
    organizationId: ORG,
    name: 'Notify owner on new work',
    triggerKind: 'work_item_created',
    actionKind: 'notify_owner',
    configJson: {},
    enabled: true,
    createdBy: USER,
    createdAt: new Date('2026-09-27T10:00:00.000Z'),
    ...overrides,
  };
}

function controllerWith(templates: readonly WorkflowTemplateRow[]) {
  const runStore: WorkflowRunRow[] = [];
  let seq = 0;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const templatesRepository = {
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      templates.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
  } as unknown as WorkflowTemplatesRepository;

  const runsRepository = {
    record: async (
      _runner: unknown,
      ctx: TenantContext,
      input: { templateId: string; status: string; detail: Record<string, unknown> },
    ) => {
      const row: WorkflowRunRow = {
        id: `workflow-run-${(seq += 1).toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        templateId: input.templateId,
        status: input.status,
        detailJson: input.detail,
        startedAt: new Date('2026-09-27T11:00:00.000Z'),
        finishedAt: new Date('2026-09-27T11:00:00.000Z'),
      };
      runStore.push(row);
      return row;
    },
  } as unknown as WorkflowRunsRepository;

  const controller = new WorkflowRunController(
    database,
    templatesRepository,
    runsRepository,
    new WorkflowRunService(),
  );
  return { controller, runStore };
}

describe('WorkflowRunController', () => {
  it('runs an enabled in-app template and records a succeeded run', async () => {
    const { controller, runStore } = controllerWith([template()]);
    const view = await controller.run(context, principal('owner'), 'workflow-template-01');

    expect(view.status).toBe('succeeded');
    expect(view.templateId).toBe('workflow-template-01');
    expect(view).not.toHaveProperty('organizationId');
    expect(runStore).toHaveLength(1);
    expect(runStore[0]?.status).toBe('succeeded');
  });

  it('records a failed run for an external action rather than any egress', async () => {
    const { controller, runStore } = controllerWith([
      template({ actionKind: 'send_email_digest' }),
    ]);
    const view = await controller.run(context, principal('owner'), 'workflow-template-01');

    expect(view.status).toBe('failed');
    expect(view.detail).toMatchObject({ outcome: 'not_run' });
    expect(runStore).toHaveLength(1);
  });

  it('refuses a disabled template with 409 and records no run', async () => {
    const { controller, runStore } = controllerWith([template({ enabled: false })]);
    await expect(
      controller.run(context, principal('owner'), 'workflow-template-01'),
    ).rejects.toMatchObject({ status: 409 });
    expect(runStore).toHaveLength(0);
  });

  it('returns 404 with no write for a cross-tenant template id', async () => {
    const { controller, runStore } = controllerWith([
      template({ id: 'workflow-template-other', organizationId: OTHER_ORG }),
    ]);
    await expect(
      controller.run(context, principal('owner'), 'workflow-template-other'),
    ).rejects.toMatchObject({ status: 404 });
    expect(runStore).toHaveLength(0);
  });

  it('returns 404 with no write for an unknown template id', async () => {
    const { controller, runStore } = controllerWith([template()]);
    await expect(
      controller.run(context, principal('owner'), 'workflow-template-missing'),
    ).rejects.toMatchObject({ status: 404 });
    expect(runStore).toHaveLength(0);
  });

  it('refuses a role without org.manage with 403 and records no run', async () => {
    // workspace_admin does not hold `org.manage`, so it is denied here.
    const { controller, runStore } = controllerWith([template()]);
    await expect(
      controller.run(context, principal('workspace_admin'), 'workflow-template-01'),
    ).rejects.toMatchObject({ status: 403 });
    expect(runStore).toHaveLength(0);
  });
});
