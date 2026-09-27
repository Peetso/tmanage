import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkflowTemplateCloneController } from './template-clone.controller.js';
import type {
  CreateWorkflowTemplateInput,
  WorkflowTemplatesRepository,
} from './templates.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkflowTemplateRow } from '../../common/database/schema.js';

/**
 * Automations workflow-template *clone* (x219) controller proofs, database-free over fakes with the
 * *real* `authorize`. The SQL round-trip and grant are the chain's DB suite, not here; this file
 * proves the controller's own security logic: the source id is tenant-scoped BEFORE authorize/write
 * (unknown and cross-tenant → 404 with no insert), the org-scoped `org.manage` decision (403 on an
 * existing template), the name-collision 409, and that a valid clone is a fresh, disabled copy with a
 * new identity while the source is left untouched.
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
    createdBy: 'user-0000-0000-0000-0000-00000000000a',
    createdAt: new Date('2026-09-27T10:00:00.000Z'),
    ...overrides,
  };
}

function controllerWith(seed: readonly WorkflowTemplateRow[] = []) {
  const store: WorkflowTemplateRow[] = seed.map((r) => ({ ...r }));
  let nextId = 100;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      store.find((r) => r.organizationId === ctx.organizationId && r.id === id) ?? null,
    findByName: async (_runner: unknown, ctx: TenantContext, name: string) =>
      store.find((r) => r.organizationId === ctx.organizationId && r.name === name) ?? null,
    create: async (_runner: unknown, ctx: TenantContext, input: CreateWorkflowTemplateInput) => {
      const created: WorkflowTemplateRow = {
        id: `workflow-template-clone-${nextId++}`,
        organizationId: ctx.organizationId,
        name: input.name,
        triggerKind: input.triggerKind,
        actionKind: input.actionKind,
        configJson: input.config,
        enabled: input.enabled,
        createdBy: input.createdBy,
        createdAt: new Date('2026-09-27T11:00:00.000Z'),
      };
      store.push(created);
      return { ...created };
    },
  } as unknown as WorkflowTemplatesRepository;

  return { controller: new WorkflowTemplateCloneController(database, repository), store };
}

describe('WorkflowTemplateCloneController (x219)', () => {
  it('clones a template as a fresh disabled copy, leaving the source untouched', async () => {
    const { controller, store } = controllerWith([row()]);
    const clone = await controller.clone(context, principal('owner'), TEMPLATE_ID, {
      name: 'Notify owner (copy)',
    });

    // Behaviour is copied.
    expect(clone.triggerKind).toBe('work_item_created');
    expect(clone.actionKind).toBe('notify_owner');
    expect(clone.config).toEqual({ channel: 'in_app' });
    // Identity is fresh, not the source's: new id, new author, and never firing on creation.
    expect(clone.id).not.toBe(TEMPLATE_ID);
    expect(clone.name).toBe('Notify owner (copy)');
    expect(clone.enabled).toBe(false);
    expect(clone.createdBy).toBe(USER);
    expect(clone).not.toHaveProperty('organizationId');
    // The source is unchanged and a new row now exists alongside it.
    expect(store[0]?.name).toBe('Notify owner on new work');
    expect(store[0]?.enabled).toBe(true);
    expect(store).toHaveLength(2);
  });

  it('returns 404 for an unknown source id and writes nothing', async () => {
    const { controller, store } = controllerWith([row()]);
    await expect(
      controller.clone(context, principal('owner'), 'workflow-template-nope', { name: 'copy' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store).toHaveLength(1);
  });

  it('returns 404 for a cross-tenant source id (isolation) and writes nothing', async () => {
    const { controller, store } = controllerWith([row({ organizationId: OTHER_ORG })]);
    await expect(
      controller.clone(context, principal('owner'), TEMPLATE_ID, { name: 'copy' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store).toHaveLength(1);
  });

  it('refuses a role without org.manage with 403 and writes nothing', async () => {
    // org_admin holds every capability except `org.manage`, so it is denied here.
    const { controller, store } = controllerWith([row()]);
    await expect(
      controller.clone(context, principal('org_admin'), TEMPLATE_ID, { name: 'copy' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store).toHaveLength(1);
  });

  it('rejects a duplicate name with 409 and writes nothing', async () => {
    const { controller, store } = controllerWith([row(), row({ id: 'x', name: 'Taken name' })]);
    await expect(
      controller.clone(context, principal('owner'), TEMPLATE_ID, { name: 'Taken name' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(store).toHaveLength(2);
  });

  it('rejects an empty name with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith([row()]);
    await expect(
      controller.clone(context, principal('owner'), TEMPLATE_ID, { name: '   ' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(1);
  });
});
