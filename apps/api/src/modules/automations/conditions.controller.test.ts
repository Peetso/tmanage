import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkflowConditionsController } from './conditions.controller.js';
import { evaluateCondition } from './conditions.service.js';
import type { WorkflowTemplatesRepository } from './templates.repository.js';
import type { WorkflowConditionsRepository } from './conditions.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkflowConditionRow, WorkflowTemplateRow } from '../../common/database/schema.js';

/**
 * Automations workflow-condition (x190) proofs, database-free over fakes with the *real* `authorize`.
 * The migration and the tenant-scoped SQL round-trip are the chain's DB suite, not here; this file
 * proves the controller's own security logic — resolve-before-authorize (cross-tenant/unknown template
 * id → 404 with no write), the org-scoped `org.manage` decision (403), the operator allowlist (an
 * off-list op → 400 with no write), the succeeded create writing exactly one condition — and the pure
 * evaluator deciding true/false against a sample event.
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
  const store: WorkflowConditionRow[] = [];
  let seq = 0;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const templatesRepository = {
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      templates.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
  } as unknown as WorkflowTemplatesRepository;

  const conditionsRepository = {
    listForTemplate: async (_runner: unknown, ctx: TenantContext, templateId: string) =>
      store.filter((r) => r.organizationId === ctx.organizationId && r.templateId === templateId),
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        templateId: string;
        field: string;
        op: string;
        value: string;
        targetStep: number;
        createdBy: string;
      },
    ) => {
      const row: WorkflowConditionRow = {
        id: `workflow-condition-${(seq += 1).toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        templateId: input.templateId,
        field: input.field,
        op: input.op,
        value: input.value,
        targetStep: input.targetStep,
        createdBy: input.createdBy,
        createdAt: new Date('2026-09-27T11:00:00.000Z'),
      };
      store.push(row);
      return row;
    },
  } as unknown as WorkflowConditionsRepository;

  const controller = new WorkflowConditionsController(
    database,
    templatesRepository,
    conditionsRepository,
  );
  return { controller, store };
}

const validBody = { field: 'priority', op: 'eq', value: 'high', targetStep: 1 };

describe('WorkflowConditionsController', () => {
  it('persists a condition for an enabled template and returns it without the tenant id', async () => {
    const { controller, store } = controllerWith([template()]);
    const view = await controller.create(
      context,
      principal('owner'),
      'workflow-template-01',
      validBody,
    );

    expect(view.templateId).toBe('workflow-template-01');
    expect(view).toMatchObject({ field: 'priority', op: 'eq', value: 'high', targetStep: 1 });
    expect(view).not.toHaveProperty('organizationId');
    expect(store).toHaveLength(1);
  });

  it('rejects an off-list op with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith([template()]);
    await expect(
      controller.create(context, principal('owner'), 'workflow-template-01', {
        ...validBody,
        op: 'regex',
      }),
    ).rejects.toMatchObject({ status: 400, auditCode: 'workflow_condition_op_off_list' });
    expect(store).toHaveLength(0);
  });

  it('returns 404 with no write for a cross-tenant template id', async () => {
    const { controller, store } = controllerWith([
      template({ id: 'workflow-template-other', organizationId: OTHER_ORG }),
    ]);
    await expect(
      controller.create(context, principal('owner'), 'workflow-template-other', validBody),
    ).rejects.toMatchObject({ status: 404 });
    expect(store).toHaveLength(0);
  });

  it('refuses a role without org.manage with 403 and writes nothing', async () => {
    // workspace_admin does not hold `org.manage`, so it is denied here.
    const { controller, store } = controllerWith([template()]);
    await expect(
      controller.create(context, principal('workspace_admin'), 'workflow-template-01', validBody),
    ).rejects.toMatchObject({ status: 403 });
    expect(store).toHaveLength(0);
  });
});

describe('evaluateCondition', () => {
  it('evaluates true and false against a sample event across the operators', () => {
    expect(
      evaluateCondition({ field: 'priority', op: 'eq', value: 'high' }, { priority: 'high' }),
    ).toBe(true);
    expect(
      evaluateCondition({ field: 'priority', op: 'eq', value: 'high' }, { priority: 'low' }),
    ).toBe(false);
    expect(evaluateCondition({ field: 'score', op: 'gt', value: '5' }, { score: 9 })).toBe(true);
    expect(evaluateCondition({ field: 'score', op: 'lt', value: '5' }, { score: 9 })).toBe(false);
    expect(
      evaluateCondition(
        { field: 'title', op: 'contains', value: 'bug' },
        { title: 'a bug report' },
      ),
    ).toBe(true);
    // A missing field never fires the step, even under an equality that would otherwise match "".
    expect(evaluateCondition({ field: 'absent', op: 'eq', value: '' }, { priority: 'high' })).toBe(
      false,
    );
  });
});
