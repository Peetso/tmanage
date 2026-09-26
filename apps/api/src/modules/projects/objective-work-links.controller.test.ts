import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ObjectiveWorkLinksController } from './objective-work-links.controller.js';
import { ObjectiveWorkLinksService } from './objective-work-links.service.js';
import { DuplicateObjectiveWorkLinkError } from './objective-work-links.repository.js';
import type {
  CreateObjectiveWorkLinkInput,
  ObjectiveWorkLinkWithItem,
  ObjectiveWorkLinksRepository,
} from './objective-work-links.repository.js';
import type { ProjectObjectivesRepository } from './project-objectives.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  ObjectiveWorkLinkRow,
  ProjectObjectiveRow,
  WorkItemRow,
} from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x138). The objective→work-links controller over the module's fakes with the **real**
 * `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are the chain's DB suite;
 * here the subject is the controller + service logic:
 *
 * - the link → list → unlink round-trip;
 * - a duplicate pair is a 409 with no second row;
 * - the Known-trap — an unknown / cross-tenant `objectiveId`, a work item in another project, and an
 *   unknown / cross-tenant `linkId` are each a 404 with no write, never a foreign-key 500;
 * - the relation gate (real authorize) — a manager related to the objective's project may link; one who
 *   is not gets not-found, never a 403 that confirms it exists;
 * - the route ceilings the `CapabilityGuard` enforces — writes require `project.manage`, the list
 *   requires `work.read`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const OTHER_PROJECT = 'project-0000-0000-0000-0000-000000000002';
const OBJECTIVE = 'objective-0000-0000-0000-000000000001';
const WORK_ITEM = 'work-0000-0000-0000-0000-000000000001';
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

function objectiveRow(id: string, organizationId = ORG, projectId = PROJECT): ProjectObjectiveRow {
  return {
    id,
    organizationId,
    projectId,
    name: 'Cut lead time',
    description: null,
    target: null,
    status: 'open',
    createdBy: USER,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
  } as ProjectObjectiveRow;
}

function workItemRow(
  id: string,
  organizationId = ORG,
  projectId = PROJECT,
  deletedAt: Date | null = null,
): WorkItemRow {
  return {
    id,
    organizationId,
    projectId,
    type: 'task',
    title: 'Draft the brief',
    state: 'in_progress',
    ownerUserId: USER,
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, 1)),
    deletedAt,
  } as WorkItemRow;
}

function build(options: {
  objectives?: readonly ProjectObjectiveRow[];
  workItemsSeed?: readonly WorkItemRow[];
  linksSeed?: readonly ObjectiveWorkLinkRow[];
}): { controller: ObjectiveWorkLinksController; store: ObjectiveWorkLinkRow[] } {
  const objectivesStore = [...(options.objectives ?? [objectiveRow(OBJECTIVE)])];
  const workItemsStore = [...(options.workItemsSeed ?? [workItemRow(WORK_ITEM)])];
  const store: ObjectiveWorkLinkRow[] = [...(options.linksSeed ?? [])];
  let seq = store.length;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const objectivesRepo = {
    findById: async (_runner: unknown, ctx: TenantContext, objectiveId: string) =>
      objectivesStore.find(
        (row) => row.id === objectiveId && row.organizationId === ctx.organizationId,
      ) ?? null,
  } as unknown as ProjectObjectivesRepository;

  const workItemsRepo = {
    findById: async (_runner: unknown, ctx: TenantContext, workItemId: string) =>
      workItemsStore.find(
        (row) => row.id === workItemId && row.organizationId === ctx.organizationId,
      ) ?? null,
  } as unknown as WorkItemsRepository;

  const linksRepo = {
    listByObjective: async (
      _runner: unknown,
      ctx: TenantContext,
      objectiveId: string,
    ): Promise<readonly ObjectiveWorkLinkWithItem[]> =>
      store
        .filter((row) => row.objectiveId === objectiveId && row.organizationId === ctx.organizationId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((link) => {
          const item = workItemsStore.find((w) => w.id === link.workItemId);
          return {
            link,
            workItemTitle: item?.title ?? '',
            workItemState: item?.state ?? '',
          };
        }),
    findById: async (_runner: unknown, ctx: TenantContext, linkId: string) =>
      store.find((row) => row.id === linkId && row.organizationId === ctx.organizationId) ?? null,
    create: async (_runner: unknown, ctx: TenantContext, input: CreateObjectiveWorkLinkInput) => {
      if (
        store.some(
          (row) =>
            row.organizationId === ctx.organizationId &&
            row.objectiveId === input.objectiveId &&
            row.workItemId === input.workItemId,
        )
      ) {
        throw new DuplicateObjectiveWorkLinkError(input.objectiveId, input.workItemId);
      }
      const row = {
        id: `link-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        objectiveId: input.objectiveId,
        workItemId: input.workItemId,
        createdBy: input.createdBy,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as ObjectiveWorkLinkRow;
      store.push(row);
      return row;
    },
    deleteById: async (_runner: unknown, ctx: TenantContext, linkId: string) => {
      const index = store.findIndex(
        (row) => row.id === linkId && row.organizationId === ctx.organizationId,
      );
      if (index >= 0) store.splice(index, 1);
    },
  } as unknown as ObjectiveWorkLinksRepository;

  const service = new ObjectiveWorkLinksService(
    database,
    linksRepo,
    objectivesRepo,
    workItemsRepo,
  );
  return { controller: new ObjectiveWorkLinksController(service), store };
}

describe('ObjectiveWorkLinksController link → list → unlink', () => {
  it('links a work item to an objective, lists it, and unlinks it', async () => {
    const { controller, store } = build({});

    const created = await controller.link(context, owner, OBJECTIVE, { workItemId: WORK_ITEM });
    expect(created.objectiveId).toBe(OBJECTIVE);
    expect(created.workItemId).toBe(WORK_ITEM);
    expect(created.workItemTitle).toBe('Draft the brief');
    expect((created as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const listed = await controller.list(context, owner, OBJECTIVE);
    expect(listed.workLinks.map((l) => l.linkId)).toEqual([created.linkId]);

    await controller.unlink(context, owner, OBJECTIVE, created.linkId);
    expect(store).toHaveLength(0);
  });
});

describe('a duplicate pair is a 409 with no second row', () => {
  it('rejects linking the same work item twice', async () => {
    const { controller, store } = build({});
    await controller.link(context, owner, OBJECTIVE, { workItemId: WORK_ITEM });
    await expect(
      controller.link(context, owner, OBJECTIVE, { workItemId: WORK_ITEM }),
    ).rejects.toEqual(expect.objectContaining({ status: 409, code: 'conflict' }));
    expect(store).toHaveLength(1);
  });
});

describe('the Known-trap: an unknown or cross-tenant id is a 404, no write, never a 500', () => {
  it('link against an unknown objective is a 404 and writes nothing', async () => {
    const { controller, store } = build({ objectives: [] });
    await expect(
      controller.link(context, owner, OBJECTIVE, { workItemId: WORK_ITEM }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });

  it('link a work item from another project is a 404 and writes nothing', async () => {
    const { controller, store } = build({
      workItemsSeed: [workItemRow(WORK_ITEM, ORG, OTHER_PROJECT)],
    });
    await expect(
      controller.link(context, owner, OBJECTIVE, { workItemId: WORK_ITEM }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });

  it('link a soft-deleted work item is a 404 and writes nothing', async () => {
    const { controller, store } = build({
      workItemsSeed: [workItemRow(WORK_ITEM, ORG, PROJECT, new Date())],
    });
    await expect(
      controller.link(context, owner, OBJECTIVE, { workItemId: WORK_ITEM }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });

  it('a cross-tenant objective is invisible to link (resolved tenant-scoped first)', async () => {
    const { controller, store } = build({
      objectives: [objectiveRow(OBJECTIVE, OTHER_ORG, PROJECT)],
    });
    await expect(
      controller.link(context, owner, OBJECTIVE, { workItemId: WORK_ITEM }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });

  it('unlink an unknown link is a 404', async () => {
    const { controller } = build({});
    await expect(
      controller.unlink(context, owner, OBJECTIVE, 'link-0000-0000-0000-0000000000ff'),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
  });

  it('unlink a link that belongs to another objective is a 404 and writes nothing', async () => {
    const foreign = {
      id: 'link-0000-0000-0000-0000000000aa',
      organizationId: ORG,
      objectiveId: 'objective-0000-0000-0000-0000000000ff',
      workItemId: WORK_ITEM,
      createdBy: USER,
      createdAt: new Date(),
    } as ObjectiveWorkLinkRow;
    const { controller, store } = build({ linksSeed: [foreign] });
    await expect(controller.unlink(context, owner, OBJECTIVE, foreign.id)).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
    expect(store).toHaveLength(1);
  });
});

describe('the relation gate (real authorize)', () => {
  it('a manager related to the objective’s project may link and unlink', async () => {
    const { controller, store } = build({});
    const created = await controller.link(context, managerOnProject, OBJECTIVE, {
      workItemId: WORK_ITEM,
    });
    await controller.unlink(context, managerOnProject, OBJECTIVE, created.linkId);
    expect(store).toHaveLength(0);
  });

  it('a manager not related to the project gets not-found, never a 403 that confirms it exists', async () => {
    const { controller, store } = build({});
    await expect(
      controller.link(context, managerElsewhere, OBJECTIVE, { workItemId: WORK_ITEM }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });
});

describe('the route ceilings the CapabilityGuard enforces', () => {
  it('requires project.manage to link/unlink and work.read to list', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(ObjectiveWorkLinksController.prototype.link)).toBe('project.manage');
    expect(cap(ObjectiveWorkLinksController.prototype.unlink)).toBe('project.manage');
    expect(cap(ObjectiveWorkLinksController.prototype.list)).toBe('work.read');
  });
});
