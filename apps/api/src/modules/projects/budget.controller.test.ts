import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ProjectBudgetController } from './budget.controller.js';
import { ProjectBudgetService } from './budget.service.js';
import type { ProjectBudgetRepository } from './budget.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectBudgetRow } from '../../common/database/schema.js';

/**
 * PROJ / project detail (x293). The project-budget controller over the module's fakes with the
 * **real** `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are proven in
 * the DB suites (out of this build's scope); here the subject is the controller + service logic:
 * the set → read round-trip and the budget-vs-tracked arithmetic; the Known-trap (unknown or
 * cross-tenant `projectId` ⇒ 404, no write, never a foreign-key 500); the body validation (negative
 * hours, no dimension, currency without an amount ⇒ 400, no write); the relation gate; and the route
 * ceilings the `CapabilityGuard` enforces.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const UNKNOWN_PROJECT = 'project-0000-0000-0000-0000-0000000000ff';
const USER = 'user-0000-0000-0000-0000-000000000001';

function principal(
  role: Principal['role'],
  projectIds: readonly string[],
  orgWide = false,
): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: orgWide,
  };
}

const owner = principal('owner', [], true);
const managerOnProject = principal('manager', [PROJECT]);
const managerElsewhere = principal('manager', []);
const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function build(
  trackedMinutes = 0,
  knownProjectIds: readonly string[] = [PROJECT],
): { controller: ProjectBudgetController; store: ProjectBudgetRow[] } {
  const store: ProjectBudgetRow[] = [];
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    findForProject: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      store.find((r) => r.projectId === projectId && r.organizationId === ctx.organizationId) ??
      null,
    sumTrackedMinutes: async () => trackedMinutes,
    upsert: async (
      _r: unknown,
      ctx: TenantContext,
      input: {
        readonly projectId: string;
        readonly budgetMinutes: number | null;
        readonly budgetAmountMinor: number | null;
        readonly currency: string | null;
        readonly createdBy: string;
      },
    ) => {
      const existing = store.find(
        (r) => r.projectId === input.projectId && r.organizationId === ctx.organizationId,
      );
      const row = {
        id: 'budget-0000-0000-0000-0000-000000000001',
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        budgetMinutes: input.budgetMinutes,
        budgetAmountMinor: input.budgetAmountMinor,
        currency: input.currency,
        createdBy: input.createdBy,
        createdAt: existing?.createdAt ?? new Date(Date.UTC(2026, 0, 1)),
        updatedAt: new Date(Date.UTC(2026, 0, 2)),
      } as ProjectBudgetRow;
      if (existing) Object.assign(existing, row);
      else store.push(row);
      return row;
    },
  } as unknown as ProjectBudgetRepository;
  const projects = {
    findById: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      knownProjectIds.includes(projectId) && ctx.organizationId === ORG
        ? ({ id: projectId } as unknown)
        : null,
  } as unknown as ProjectsRepository;

  const service = new ProjectBudgetService(database, repository, projects);
  return { controller: new ProjectBudgetController(service), store };
}

describe('ProjectBudgetController set → read, budget vs tracked', () => {
  it('sets a budget, then reports tracked hours, remaining and variance', async () => {
    const { controller } = build(150); // 150 tracked minutes = 2.5h
    const saved = await controller.save(context, owner, PROJECT, {
      budgetHours: 40,
      budgetAmountMinor: 500000,
      currency: 'USD',
    });
    expect(saved.budgetHours).toBe(40);
    expect(saved.budgetAmountMinor).toBe(500000);
    expect(saved.currency).toBe('USD');
    expect(saved.trackedHours).toBe(2.5);
    expect(saved.remainingHours).toBe(37.5);
    expect(saved.varianceHours).toBe(-37.5);
    expect((saved as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const read = await controller.get(context, owner, PROJECT);
    expect(read.budgetHours).toBe(40);
    expect(read.trackedHours).toBe(2.5);
  });

  it('with no budget set, GET is a 200 with null figures but a real tracked total', async () => {
    const { controller } = build(90);
    const read = await controller.get(context, owner, PROJECT);
    expect(read.budgetHours).toBeNull();
    expect(read.budgetAmountMinor).toBeNull();
    expect(read.remainingHours).toBeNull();
    expect(read.trackedHours).toBe(1.5);
    expect(read.updatedAt).toBeNull();
  });
});

describe('body validation ⇒ 400, no write', () => {
  it('rejects a negative budgetHours and writes nothing', async () => {
    const { controller, store } = build();
    await expect(controller.save(context, owner, PROJECT, { budgetHours: -1 })).rejects.toEqual(
      expect.objectContaining({ status: 400, code: 'validation_failed' }),
    );
    expect(store).toHaveLength(0);
  });

  it('rejects a body with neither dimension, and a currency without an amount', async () => {
    const { controller, store } = build();
    await expect(controller.save(context, owner, PROJECT, {})).rejects.toEqual(
      expect.objectContaining({ status: 400 }),
    );
    await expect(
      controller.save(context, owner, PROJECT, { budgetHours: 10, currency: 'USD' }),
    ).rejects.toEqual(expect.objectContaining({ status: 400 }));
    expect(store).toHaveLength(0);
  });
});

describe('the Known-trap: an unknown or cross-tenant project is a 404, no write, never a 500', () => {
  it('save against an unknown project is a 404 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.save(context, owner, UNKNOWN_PROJECT, { budgetHours: 10 }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });
});

describe('the relation gate (real authorize)', () => {
  it('a manager related to the project may set a budget', async () => {
    const { controller } = build();
    const saved = await controller.save(context, managerOnProject, PROJECT, { budgetHours: 8 });
    expect(saved.budgetHours).toBe(8);
  });

  it('a manager not related to the project gets not-found, never a 403 that confirms it exists', async () => {
    const { controller, store } = build();
    await expect(
      controller.save(context, managerElsewhere, PROJECT, { budgetHours: 8 }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });
});

describe('the route ceilings the CapabilityGuard enforces', () => {
  it('requires project.manage to read and to write', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(ProjectBudgetController.prototype.get)).toBe('project.manage');
    expect(cap(ProjectBudgetController.prototype.save)).toBe('project.manage');
  });
});
