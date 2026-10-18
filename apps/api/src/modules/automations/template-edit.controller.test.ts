import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkflowTemplateEditController } from './template-edit.controller.js';
import type {
  UpdateWorkflowTemplateInput,
  WorkflowTemplatesRepository,
} from './templates.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkflowTemplateRow } from '../../common/database/schema.js';

/**
 * Automations workflow-template *edit* (x189) controller proofs, database-free over fakes with the
 * *real* `authorize`. The SQL round-trip and grant are the chain's DB suite, not here; this file
 * proves the controller's own security logic: the id is tenant-scoped BEFORE authorize/mutate
 * (unknown and cross-tenant → 404 with no write), the org-scoped `org.manage` decision (403 on an
 * existing template), the off-list 400, the empty-body 400, and that a valid edit persists.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';
const TEMPLATE_ID = 'workflow-template-0000-0000-000000000001';

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

function row(overrides: Partial<WorkflowTemplateRow> = {}): WorkflowTemplateRow {
  return {
    id: TEMPLATE_ID,
    organizationId: ORG,
    name: 'Notify owner on new work',
    triggerKind: 'work_item_created',
    actionKind: 'notify_owner',
    configJson: { channel: 'in_app' },
    enabled: true,
    createdBy: USER,
    createdAt: new Date('2026-09-27T10:00:00.000Z'),
    ...overrides,
  };
}

function controllerWith(seed: readonly WorkflowTemplateRow[] = []) {
  const store: WorkflowTemplateRow[] = seed.map((r) => ({ ...r }));

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      store.find((r) => r.organizationId === ctx.organizationId && r.id === id) ?? null,
    update: async (
      _runner: unknown,
      ctx: TenantContext,
      id: string,
      input: UpdateWorkflowTemplateInput,
    ) => {
      const found = store.find((r) => r.organizationId === ctx.organizationId && r.id === id);
      if (!found) return null;
      if (input.name !== undefined) found.name = input.name;
      if (input.triggerKind !== undefined) found.triggerKind = input.triggerKind;
      if (input.actionKind !== undefined) found.actionKind = input.actionKind;
      if (input.config !== undefined) found.configJson = input.config;
      if (input.enabled !== undefined) found.enabled = input.enabled;
      return { ...found };
    },
  } as unknown as WorkflowTemplatesRepository;

  return { controller: new WorkflowTemplateEditController(database, repository), store };
}

describe('WorkflowTemplateEditController', () => {
  it('edits a tenant-owned template and persists the change, without echoing the tenant id', async () => {
    const { controller, store } = controllerWith([row()]);
    const updated = await controller.update(context, principal('owner'), TEMPLATE_ID, {
      name: 'Renamed template',
      enabled: false,
    });
    expect(updated.name).toBe('Renamed template');
    expect(updated.enabled).toBe(false);
    expect(updated).not.toHaveProperty('organizationId');
    expect(store[0]?.name).toBe('Renamed template');
  });

  it('returns 404 for an unknown id and writes nothing', async () => {
    const { controller, store } = controllerWith([row()]);
    await expect(
      controller.update(context, principal('owner'), 'workflow-template-nope', { name: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store[0]?.name).toBe('Notify owner on new work');
  });

  it('returns 404 for a cross-tenant id (isolation) and writes nothing', async () => {
    // The template exists, but in another tenant — invisible to this context's (org,id) lookup.
    const { controller } = controllerWith([row({ organizationId: OTHER_ORG })]);
    await expect(
      controller.update(context, principal('owner'), TEMPLATE_ID, { name: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a role without org.manage with 403 on an existing template', async () => {
    // workspace_admin does not hold `org.manage`, so it is denied here.
    const { controller, store } = controllerWith([row()]);
    await expect(
      controller.update(context, principal('workspace_admin'), TEMPLATE_ID, { name: 'x' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store[0]?.name).toBe('Notify owner on new work');
  });

  it('rejects an off-list trigger with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith([row()]);
    await expect(
      controller.update(context, principal('owner'), TEMPLATE_ID, {
        triggerKind: 'when_the_moon_is_full',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store[0]?.triggerKind).toBe('work_item_created');
  });

  it('rejects an empty edit with 400', async () => {
    const { controller } = controllerWith([row()]);
    await expect(
      controller.update(context, principal('owner'), TEMPLATE_ID, {}),
    ).rejects.toMatchObject({ status: 400 });
  });
});
