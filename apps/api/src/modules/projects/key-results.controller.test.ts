import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { KeyResultsController } from './key-results.controller.js';
import { KeyResultsService, computeProgressPercent } from './key-results.service.js';
import type { CreateKeyResultInput, KeyResultsRepository } from './key-results.repository.js';
import type { ProjectObjectivesRepository } from './project-objectives.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ObjectiveKeyResultRow, ProjectObjectiveRow } from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x207). The key-results controller over the module's fakes with the **real**
 * `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are the chain's DB suite;
 * here the subject is the controller + service logic and the pure progress computation.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const OBJECTIVE = 'objective-0000-0000-0000-000000000001';
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
const managerElsewhere = principal('manager', []);
const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function objectiveRow(id: string, organizationId = ORG, projectId = PROJECT): ProjectObjectiveRow {
  return {
    id,
    organizationId,
    projectId,
    name: 'Grow adoption',
    description: null,
    target: null,
    status: 'open',
    createdBy: USER,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
  } as ProjectObjectiveRow;
}

function build(options: { objectives?: readonly ProjectObjectiveRow[] } = {}): {
  controller: KeyResultsController;
  store: ObjectiveKeyResultRow[];
} {
  const objectivesStore = [...(options.objectives ?? [objectiveRow(OBJECTIVE)])];
  const store: ObjectiveKeyResultRow[] = [];
  let seq = 0;

  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const objectivesRepo = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      objectivesStore.find((row) => row.id === id && row.organizationId === ctx.organizationId) ??
      null,
  } as unknown as ProjectObjectivesRepository;

  const keyResultsRepo = {
    list: async (_r: unknown, ctx: TenantContext, opts: { objectiveId: string }) =>
      store
        .filter(
          (row) =>
            row.objectiveId === opts.objectiveId && row.organizationId === ctx.organizationId,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      store.find((row) => row.id === id && row.organizationId === ctx.organizationId) ?? null,
    create: async (_r: unknown, ctx: TenantContext, input: CreateKeyResultInput) => {
      const row = {
        id: `kr-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        objectiveId: input.objectiveId,
        title: input.title,
        targetValue: input.targetValue,
        currentValue: input.currentValue,
        unit: input.unit,
        createdBy: input.createdBy,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
        updatedAt: new Date(Date.UTC(2026, 0, seq)),
      } as ObjectiveKeyResultRow;
      store.push(row);
      return row;
    },
    update: async (
      _r: unknown,
      ctx: TenantContext,
      id: string,
      input: { currentValue?: number },
    ) => {
      const row = store.find((r) => r.id === id && r.organizationId === ctx.organizationId);
      if (!row) throw new Error('missing');
      if (input.currentValue !== undefined)
        (row as { currentValue: number }).currentValue = input.currentValue;
      return row;
    },
  } as unknown as KeyResultsRepository;

  const service = new KeyResultsService(database, keyResultsRepo, objectivesRepo);
  return { controller: new KeyResultsController(service), store };
}

describe('computeProgressPercent', () => {
  it('computes a bounded percentage and guards target = 0', () => {
    expect(computeProgressPercent(40, 100)).toBe(40);
    expect(computeProgressPercent(0, 0)).toBe(0); // div-by-zero safe
    expect(computeProgressPercent(150, 100)).toBe(100); // capped
    expect(computeProgressPercent(-5, 100)).toBe(0); // floored
  });
});

describe('KeyResultsController create → list → update', () => {
  it('creates a key result, lists it, and updates its current value; progress reflects the change', async () => {
    const { controller } = build();
    const created = await controller.create(context, owner, OBJECTIVE, {
      title: 'Trial-to-paid',
      targetValue: 200,
      currentValue: 50,
      unit: '%',
    });
    expect(created.progressPercent).toBe(25);
    expect((created as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const listed = await controller.list(context, owner, OBJECTIVE);
    expect(listed.keyResults.map((k) => k.id)).toEqual([created.id]);

    const updated = await controller.patch(context, owner, OBJECTIVE, created.id, {
      currentValue: 100,
    });
    expect(updated.progressPercent).toBe(50);
  });

  it('handles a target of 0 without a division error', async () => {
    const { controller } = build();
    const created = await controller.create(context, owner, OBJECTIVE, {
      title: 'Zero target',
      targetValue: 0,
      currentValue: 10,
      unit: 'x',
    });
    expect(created.progressPercent).toBe(0);
  });
});

describe('the Known-trap and the relation gate', () => {
  it('a cross-tenant objective is a 404 on create, with no write', async () => {
    const { controller, store } = build({
      objectives: [objectiveRow(OBJECTIVE, OTHER_ORG, PROJECT)],
    });
    await expect(
      controller.create(context, owner, OBJECTIVE, {
        title: 't',
        targetValue: 1,
        currentValue: 0,
        unit: 'x',
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });

  it('a manager not related to the objective’s project gets not-found, never a 403', async () => {
    const { controller } = build();
    await expect(controller.list(context, managerElsewhere, OBJECTIVE)).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe('the route ceilings the CapabilityGuard enforces', () => {
  it('requires project.manage to create/update and work.read to list', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(KeyResultsController.prototype.create)).toBe('project.manage');
    expect(cap(KeyResultsController.prototype.patch)).toBe('project.manage');
    expect(cap(KeyResultsController.prototype.list)).toBe('work.read');
  });
});
