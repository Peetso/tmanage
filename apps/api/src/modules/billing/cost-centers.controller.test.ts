import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { CostCentersController } from './cost-centers.controller.js';
import { CostCentersService } from './cost-centers.service.js';
import type { CostCentersRepository } from './cost-centers.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingCostCenterRow } from '../../common/database/schema.js';

/**
 * Billing cost-centers (x281) proofs, database-free over a fake repository with the *real* `authorize`
 * (the controller delegates to a real {@link CostCentersService} built on the fake). The migration and
 * the tenant-scoped SQL round-trip are the chain's DB suite, not here; this file proves the slice's own
 * security and shape logic: create→list, the empty-field 400 and duplicate-code 409 with no write, the
 * idempotent assign/unassign, the delete, and — the refusal the brief names — a cross-tenant project
 * assignment that is a 404 with no write, and a POST without `org.manage` that is a 403.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-00000000aaaa';
const FOREIGN_PROJECT = 'project-0000-0000-0000-0000-00000000bbbb';

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

/** A per-tenant project registry: only these ids resolve for their org (a cross-tenant id is a 404). */
const PROJECTS_BY_ORG: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [ORG, new Set([PROJECT])],
  [OTHER_ORG, new Set([FOREIGN_PROJECT])],
]);

function controllerWith(seed: readonly BillingCostCenterRow[] = []) {
  const store: BillingCostCenterRow[] = [...seed];
  let seq = store.length;
  const now = new Date('2026-09-27T10:00:00.000Z');

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const rowsFor = (ctx: TenantContext) =>
    store.filter((r) => r.organizationId === ctx.organizationId);

  const repository = {
    listDefs: async (_runner: unknown, ctx: TenantContext) =>
      rowsFor(ctx)
        .filter((r) => r.rowKind === 'def')
        .sort((a, b) => a.code.localeCompare(b.code)),
    listAssignmentsForCodes: async (
      _runner: unknown,
      ctx: TenantContext,
      codes: readonly string[],
    ) => rowsFor(ctx).filter((r) => r.rowKind === 'assignment' && codes.includes(r.code)),
    findDefById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      rowsFor(ctx).find((r) => r.rowKind === 'def' && r.id === id) ?? null,
    findDefByCode: async (_runner: unknown, ctx: TenantContext, code: string) =>
      rowsFor(ctx).find((r) => r.rowKind === 'def' && r.code === code) ?? null,
    projectExists: async (_runner: unknown, ctx: TenantContext, projectId: string) =>
      PROJECTS_BY_ORG.get(ctx.organizationId)?.has(projectId) ?? false,
    createDef: async (
      _runner: unknown,
      ctx: TenantContext,
      input: { code: string; name: string },
    ) => {
      const row: BillingCostCenterRow = {
        id: `cost-center-${(seq += 1).toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        rowKind: 'def',
        code: input.code,
        name: input.name,
        projectId: null,
        createdAt: now,
        defCode: input.code,
      };
      store.push(row);
      return row;
    },
    assign: async (_runner: unknown, ctx: TenantContext, code: string, projectId: string) => {
      const exists = store.some(
        (r) =>
          r.organizationId === ctx.organizationId &&
          r.rowKind === 'assignment' &&
          r.code === code &&
          r.projectId === projectId,
      );
      if (exists) return;
      store.push({
        id: `assignment-${(seq += 1).toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        rowKind: 'assignment',
        code,
        name: null,
        projectId,
        createdAt: now,
        defCode: null,
      });
    },
    unassign: async (_runner: unknown, ctx: TenantContext, code: string, projectId: string) => {
      for (let i = store.length - 1; i >= 0; i -= 1) {
        const r = store[i] as BillingCostCenterRow;
        if (
          r.organizationId === ctx.organizationId &&
          r.rowKind === 'assignment' &&
          r.code === code &&
          r.projectId === projectId
        ) {
          store.splice(i, 1);
        }
      }
    },
    removeByCode: async (_runner: unknown, ctx: TenantContext, id: string, code: string) => {
      for (let i = store.length - 1; i >= 0; i -= 1) {
        const r = store[i] as BillingCostCenterRow;
        if (r.organizationId !== ctx.organizationId) continue;
        if (r.rowKind === 'assignment' && r.code === code) store.splice(i, 1);
        else if (r.rowKind === 'def' && r.id === id) store.splice(i, 1);
      }
    },
  } as unknown as CostCentersRepository;

  const service = new CostCentersService(database, repository);
  return { controller: new CostCentersController(service), store };
}

describe('CostCentersController', () => {
  it('creates a definition and lists it with no assignments, without echoing the tenant id', async () => {
    const { controller } = controllerWith();
    const actor = principal('owner');

    const created = await controller.create(context, actor, { code: 'ENG', name: 'Engineering' });
    expect(created.code).toBe('ENG');
    expect(created.projectIds).toEqual([]);
    expect(created).not.toHaveProperty('organizationId');

    const listed = await controller.list(context, actor);
    expect(listed.costCenters.map((c) => c.code)).toEqual(['ENG']);
  });

  it('rejects an empty code or name with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal('owner'), { code: '  ', name: 'Engineering' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.create(context, principal('owner'), { code: 'ENG', name: '' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('rejects a duplicate definition code with 409 and writes nothing new', async () => {
    const { controller, store } = controllerWith();
    await controller.create(context, principal('owner'), { code: 'ENG', name: 'Engineering' });
    await expect(
      controller.create(context, principal('owner'), { code: 'ENG', name: 'Engineering 2' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(store.filter((r) => r.rowKind === 'def')).toHaveLength(1);
  });

  it('refuses a role without org.manage with 403 on create and list', async () => {
    const { controller, store } = controllerWith();
    const actor = principal('workspace_admin');
    await expect(controller.list(context, actor)).rejects.toMatchObject({ status: 403 });
    await expect(
      controller.create(context, actor, { code: 'ENG', name: 'Engineering' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store).toHaveLength(0);
  });

  it('refuses assigning a project from another tenant with 404 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    const created = await controller.create(context, principal('owner'), {
      code: 'ENG',
      name: 'Engineering',
    });
    // FOREIGN_PROJECT belongs to OTHER_ORG, so it does not resolve for the acting tenant.
    await expect(
      controller.assign(context, principal('owner'), created.id, FOREIGN_PROJECT),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.filter((r) => r.rowKind === 'assignment')).toHaveLength(0);
  });

  it('assigns a project idempotently and reflects it in the list', async () => {
    const { controller, store } = controllerWith();
    const actor = principal('owner');
    const created = await controller.create(context, actor, { code: 'ENG', name: 'Engineering' });

    await controller.assign(context, actor, created.id, PROJECT);
    await controller.assign(context, actor, created.id, PROJECT); // idempotent — no second row
    expect(store.filter((r) => r.rowKind === 'assignment')).toHaveLength(1);

    const listed = await controller.list(context, actor);
    expect(listed.costCenters[0]?.projectIds).toEqual([PROJECT]);
  });

  it('unassigns a project (idempotent) and deletes a cost center with its assignments', async () => {
    const { controller, store } = controllerWith();
    const actor = principal('owner');
    const created = await controller.create(context, actor, { code: 'ENG', name: 'Engineering' });
    await controller.assign(context, actor, created.id, PROJECT);

    await controller.unassign(context, actor, created.id, PROJECT);
    await controller.unassign(context, actor, created.id, PROJECT); // idempotent
    expect(store.filter((r) => r.rowKind === 'assignment')).toHaveLength(0);

    await controller.assign(context, actor, created.id, PROJECT);
    await controller.remove(context, actor, created.id);
    expect(store).toHaveLength(0);
  });

  it('returns 404 when deleting or assigning against a cost center of another tenant', async () => {
    const foreign: BillingCostCenterRow = {
      id: 'cost-center-foreign',
      organizationId: OTHER_ORG,
      rowKind: 'def',
      code: 'ENG',
      name: 'Engineering',
      projectId: null,
      createdAt: new Date('2026-09-27T10:00:00.000Z'),
      defCode: 'ENG',
    };
    const { controller } = controllerWith([foreign]);
    await expect(controller.remove(context, principal('owner'), foreign.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      controller.assign(context, principal('owner'), foreign.id, PROJECT),
    ).rejects.toMatchObject({ status: 404 });
  });
});
