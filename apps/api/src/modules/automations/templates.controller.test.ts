import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkflowTemplatesController } from './templates.controller.js';
import type { WorkflowTemplatesRepository } from './templates.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkflowTemplateRow } from '../../common/database/schema.js';

/**
 * Automations workflow-templates (x162) controller proofs, database-free over fakes with the *real*
 * `authorize`. The migration and the tenant-scoped SQL round-trip are the chain's DB suite, not here;
 * this file proves the controller's own security logic: the org-scoped `org.manage` decision, a
 * create→list, the off-list trigger/action and over-size config 400s with no write, and the 403 for a
 * role without `org.manage`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
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

function controllerWith(seed: readonly WorkflowTemplateRow[] = []) {
  const store: WorkflowTemplateRow[] = [...seed];
  let seq = store.length;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    list: async (_runner: unknown, ctx: TenantContext) =>
      store
        .filter((row) => row.organizationId === ctx.organizationId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        name: string;
        triggerKind: string;
        actionKind: string;
        config: WorkflowTemplateRow['configJson'];
        enabled: boolean;
        createdBy: string;
      },
    ) => {
      const row: WorkflowTemplateRow = {
        id: `workflow-template-${(seq += 1).toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        name: input.name,
        triggerKind: input.triggerKind,
        actionKind: input.actionKind,
        configJson: input.config,
        enabled: input.enabled,
        createdBy: input.createdBy,
        createdAt: new Date('2026-09-27T10:00:00.000Z'),
      };
      store.push(row);
      return row;
    },
  } as unknown as WorkflowTemplatesRepository;

  return { controller: new WorkflowTemplatesController(database, repository), store };
}

describe('WorkflowTemplatesController', () => {
  it('defines a template and lists it, without echoing the tenant id', async () => {
    const { controller } = controllerWith();
    const actor = principal('owner');

    const created = await controller.create(context, actor, {
      name: 'Notify owner on new work',
      triggerKind: 'work_item_created',
      actionKind: 'notify_owner',
      config: { channel: 'in_app' },
    });
    expect(created.name).toBe('Notify owner on new work');
    expect(created.enabled).toBe(true);
    expect(created).not.toHaveProperty('organizationId');

    const listed = await controller.list(context, actor);
    expect(listed.templates.map((t) => t.id)).toContain(created.id);
  });

  it('rejects an off-list trigger with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal('owner'), {
        name: 'Bad trigger',
        triggerKind: 'when_the_moon_is_full',
        actionKind: 'notify_owner',
        config: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('rejects an off-list action with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal('owner'), {
        name: 'Bad action',
        triggerKind: 'work_item_created',
        actionKind: 'launch_the_missiles',
        config: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('rejects an over-size config with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal('owner'), {
        name: 'Huge config',
        triggerKind: 'work_item_created',
        actionKind: 'notify_owner',
        config: { blob: 'x'.repeat(5000) },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('refuses a role without org.manage with 403 on both routes', async () => {
    const { controller, store } = controllerWith();
    // org_admin holds every capability except `org.manage` (capabilities.ts), so it is denied here.
    const actor = principal('org_admin');

    await expect(controller.list(context, actor)).rejects.toMatchObject({ status: 403 });
    await expect(
      controller.create(context, actor, {
        name: 'Denied',
        triggerKind: 'work_item_created',
        actionKind: 'notify_owner',
        config: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store).toHaveLength(0);
  });

  it('lists only the acting tenant, name-ascending', async () => {
    const other: WorkflowTemplateRow = {
      id: 'workflow-template-other',
      organizationId: 'organization-0000-0000-0000-000000000002',
      name: 'Another tenant',
      triggerKind: 'work_item_created',
      actionKind: 'notify_owner',
      configJson: {},
      enabled: true,
      createdBy: USER,
      createdAt: new Date('2026-09-27T10:00:00.000Z'),
    };
    const { controller } = controllerWith([other]);
    const actor = principal('owner');
    await controller.create(context, actor, {
      name: 'Beta',
      triggerKind: 'work_item_created',
      actionKind: 'notify_owner',
      config: {},
    });
    await controller.create(context, actor, {
      name: 'Alpha',
      triggerKind: 'work_item_created',
      actionKind: 'notify_owner',
      config: {},
    });

    const listed = await controller.list(context, actor);
    expect(listed.templates.map((t) => t.name)).toEqual(['Alpha', 'Beta']);
  });
});
