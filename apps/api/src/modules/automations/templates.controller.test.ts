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

function controllerWith(
  seed: readonly WorkflowTemplateRow[] = [],
  options: { readonly locked?: boolean } = {},
) {
  const store: WorkflowTemplateRow[] = [...seed];
  let seq = store.length;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const live = (ctx: TenantContext, id: string) =>
    store.find(
      (row) => row.organizationId === ctx.organizationId && row.id === id && !row.deletedAt,
    ) ?? null;

  const repository = {
    findById: async (_runner: unknown, ctx: TenantContext, id: string) => live(ctx, id),
    softDelete: async (_runner: unknown, ctx: TenantContext, id: string) => {
      // A run in flight holds the row: the engine refuses the NOWAIT lock (MySQL errno 3572).
      if (options.locked) throw Object.assign(new Error('locked'), { errno: 3572 });
      const found = live(ctx, id);
      if (!found) return false;
      found.deletedAt = new Date('2026-10-23T09:00:00.000Z');
      found.enabled = false;
      return true;
    },
    list: async (_runner: unknown, ctx: TenantContext) =>
      store
        .filter((row) => row.organizationId === ctx.organizationId && !row.deletedAt)
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
        deletedAt: null,
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
    // workspace_admin does not hold `org.manage`, so it is denied here.
    const actor = principal('workspace_admin');

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
      deletedAt: null,
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

  describe('DELETE templates/:id (A14)', () => {
    async function seeded(options: { readonly locked?: boolean } = {}) {
      const harness = controllerWith([], options);
      const created = await harness.controller.create(context, principal('owner'), {
        name: 'Due-date reminder',
        triggerKind: 'work_item_created',
        actionKind: 'notify_owner',
        config: {},
      });
      return { ...harness, id: created.id };
    }

    it('soft-deletes the rule: it leaves the list, is turned off, and its row stays', async () => {
      const { controller, store, id } = await seeded();
      await expect(controller.remove(context, principal('owner'), id)).resolves.toBeUndefined();
      expect(store[0]?.deletedAt).toBeInstanceOf(Date);
      expect(store[0]?.enabled).toBe(false);
      const listed = await controller.list(context, principal('owner'));
      expect(listed.templates).toHaveLength(0);
      // Deleting it again is a 404 — the id no longer names a live rule.
      await expect(controller.remove(context, principal('owner'), id)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('refuses with 409 while a run is in flight, and deletes nothing', async () => {
      const { controller, store, id } = await seeded({ locked: true });
      await expect(controller.remove(context, principal('owner'), id)).rejects.toMatchObject({
        status: 409,
        auditCode: 'workflow_template_run_in_flight',
      });
      expect(store[0]?.deletedAt).toBeNull();
    });

    it('is a 404 for another tenant and a 403 without org.manage, deleting nothing', async () => {
      const { controller, store, id } = await seeded();
      const otherContext = {
        organizationId: 'organization-0000-0000-0000-000000000002',
        userId: USER,
      } as unknown as TenantContext;
      await expect(controller.remove(otherContext, principal('owner'), id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        controller.remove(context, principal('workspace_admin'), id),
      ).rejects.toMatchObject({ status: 403 });
      expect(store[0]?.deletedAt).toBeNull();
    });
  });
});
