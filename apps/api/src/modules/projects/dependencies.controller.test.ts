import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ProjectDependenciesController } from './dependencies.controller.js';
import { ProjectDependenciesService } from './dependencies.service.js';
import type {
  CreateProjectDependencyInput,
  ProjectDependenciesRepository,
  ProjectDependencyWithProject,
} from './dependencies.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectDependencyRow, ProjectRow } from '../../common/database/schema.js';

/**
 * PROJ / cross-project dependencies (x309). The controller over the module's fakes with the **real**
 * `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are the chain's DB
 * suite; here the subject is the controller + service logic:
 *
 * - the create → list → remove round-trip;
 * - the invariants — a self-dependency is 400, a duplicate pair is 409;
 * - the Known-trap / tenant scope — an unknown or cross-tenant project is a 404 with no write;
 * - the relation gate (real authorize) — a manager not related to the project gets not-found;
 * - the route ceiling — every route requires `project.manage`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const P1 = 'project-0000-0000-0000-00000000000a';
const P2 = 'project-0000-0000-0000-00000000000b';
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

function projectRow(id: string, organizationId = ORG): ProjectRow {
  return {
    id,
    organizationId,
    workspaceId: 'workspace-0000-0000-0000-000000000001',
    name: `Project ${id}`,
    status: 'active',
    ownerUserId: USER,
    committedAt: null,
    forecastAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, 1)),
    archivedAt: null,
  } as ProjectRow;
}

function build(options: {
  projects?: readonly ProjectRow[];
  seed?: readonly ProjectDependencyRow[];
}): { controller: ProjectDependenciesController; store: ProjectDependencyRow[] } {
  const projectsStore = [...(options.projects ?? [projectRow(P1), projectRow(P2)])];
  const store: ProjectDependencyRow[] = [...(options.seed ?? [])];
  let seq = store.length;

  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const projectsRepo = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      projectsStore.find((row) => row.id === id && row.organizationId === ctx.organizationId) ??
      null,
  } as unknown as ProjectsRepository;

  const toWith = (edge: ProjectDependencyRow, farId: string): ProjectDependencyWithProject => {
    const far = projectsStore.find((p) => p.id === farId);
    return { edge, projectName: far?.name ?? '', projectStatus: far?.status ?? 'active' };
  };

  const depsRepo = {
    listBlocking: async (_r: unknown, ctx: TenantContext, blockerId: string) =>
      store
        .filter(
          (row) => row.blockerProjectId === blockerId && row.organizationId === ctx.organizationId,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((edge) => toWith(edge, edge.blockedProjectId)),
    listBlockedBy: async (_r: unknown, ctx: TenantContext, blockedId: string) =>
      store
        .filter(
          (row) => row.blockedProjectId === blockedId && row.organizationId === ctx.organizationId,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((edge) => toWith(edge, edge.blockerProjectId)),
    findByPair: async (_r: unknown, ctx: TenantContext, blockerId: string, blockedId: string) =>
      store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.blockerProjectId === blockerId &&
          row.blockedProjectId === blockedId,
      ) ?? null,
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      store.find((row) => row.id === id && row.organizationId === ctx.organizationId) ?? null,
    create: async (_r: unknown, ctx: TenantContext, input: CreateProjectDependencyInput) => {
      const row = {
        id: `dep-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        blockerProjectId: input.blockerProjectId,
        blockedProjectId: input.blockedProjectId,
        note: input.note,
        createdBy: input.createdBy,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as ProjectDependencyRow;
      store.push(row);
      return row;
    },
    deleteById: async (_r: unknown, ctx: TenantContext, id: string) => {
      const index = store.findIndex(
        (row) => row.id === id && row.organizationId === ctx.organizationId,
      );
      if (index >= 0) store.splice(index, 1);
    },
  } as unknown as ProjectDependenciesRepository;

  const service = new ProjectDependenciesService(database, depsRepo, projectsRepo);
  return { controller: new ProjectDependenciesController(service), store };
}

describe('ProjectDependenciesController create → list → remove', () => {
  it('records a dependency, lists it both ways, and removes it', async () => {
    const { controller, store } = build({});

    const created = await controller.create(context, owner, P1, {
      blockedProjectId: P2,
      note: ' waits on API ',
    });
    expect(created.blockerProjectId).toBe(P1);
    expect(created.blockedProjectId).toBe(P2);
    expect(created.note).toBe('waits on API');
    expect((created as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const fromBlocker = await controller.list(context, owner, P1);
    expect(fromBlocker.blocking.map((d) => d.blockedProjectId)).toEqual([P2]);
    expect(fromBlocker.blockedBy).toHaveLength(0);

    const fromBlocked = await controller.list(context, owner, P2);
    expect(fromBlocked.blockedBy.map((d) => d.blockerProjectId)).toEqual([P1]);

    await controller.remove(context, owner, P1, P2);
    expect(store).toHaveLength(0);
  });
});

describe('the invariants', () => {
  it('a self-dependency is a 400 and writes nothing', async () => {
    const { controller, store } = build({});
    await expect(controller.create(context, owner, P1, { blockedProjectId: P1 })).rejects.toEqual(
      expect.objectContaining({ status: 400, code: 'validation_failed' }),
    );
    expect(store).toHaveLength(0);
  });

  it('a duplicate pair is a 409 and writes no second row', async () => {
    const { controller, store } = build({});
    await controller.create(context, owner, P1, { blockedProjectId: P2 });
    await expect(controller.create(context, owner, P1, { blockedProjectId: P2 })).rejects.toEqual(
      expect.objectContaining({ status: 409, code: 'conflict' }),
    );
    expect(store).toHaveLength(1);
  });
});

describe('the Known-trap: an unknown or cross-tenant project is a 404, no write', () => {
  it('a dependency to an unknown project is a 404 and writes nothing', async () => {
    const { controller, store } = build({ projects: [projectRow(P1)] });
    await expect(controller.create(context, owner, P1, { blockedProjectId: P2 })).rejects.toEqual(
      expect.objectContaining({ status: 404, code: 'not_found' }),
    );
    expect(store).toHaveLength(0);
  });

  it('an edge to another tenant’s project id is a 404 and writes nothing', async () => {
    const { controller, store } = build({
      projects: [projectRow(P1), projectRow(P2, OTHER_ORG)],
    });
    await expect(controller.create(context, owner, P1, { blockedProjectId: P2 })).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
    expect(store).toHaveLength(0);
  });
});

describe('the relation gate (real authorize)', () => {
  it('a manager not related to the project gets not-found and writes nothing', async () => {
    const { controller, store } = build({});
    await expect(
      controller.create(context, managerElsewhere, P1, { blockedProjectId: P2 }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });
});

describe('the route ceilings the CapabilityGuard enforces', () => {
  it('requires project.manage to create, remove and list', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(ProjectDependenciesController.prototype.create)).toBe('project.manage');
    expect(cap(ProjectDependenciesController.prototype.remove)).toBe('project.manage');
    expect(cap(ProjectDependenciesController.prototype.list)).toBe('project.manage');
  });
});

describe('F49: the far-end project must be readable', () => {
  const managerOfP1Only = principal('manager', [P1]);

  it('create onto a project the manager cannot read is a 404, writes nothing, echoes nothing', async () => {
    const { controller, store } = build({});
    const attempt = controller.create(context, managerOfP1Only, P1, { blockedProjectId: P2 });
    await expect(attempt).rejects.toEqual(expect.objectContaining({ status: 404 }));
    await attempt.catch((error: unknown) =>
      expect(JSON.stringify(error)).not.toContain(`Project ${P2}`),
    );
    expect(store).toHaveLength(0);
  });

  it('list omits edges whose other project the manager cannot read', async () => {
    const edge = (id: string, blocker: string, blocked: string): ProjectDependencyRow =>
      ({
        id,
        organizationId: ORG,
        blockerProjectId: blocker,
        blockedProjectId: blocked,
        note: null,
        createdBy: USER,
        createdAt: new Date(Date.UTC(2026, 0, 1)),
      }) as ProjectDependencyRow;
    const { controller } = build({
      seed: [edge('dep-b1', P1, P2), edge('dep-b2', P2, P1)],
    });

    const graph = await controller.list(context, managerOfP1Only, P1);
    expect(graph.blocking).toHaveLength(0);
    expect(graph.blockedBy).toHaveLength(0);
    expect(JSON.stringify(graph)).not.toContain(`Project ${P2}`);

    const asOwner = await controller.list(context, owner, P1);
    expect(asOwner.blocking.map((d) => d.projectName)).toEqual([`Project ${P2}`]);
    expect(asOwner.blockedBy).toHaveLength(1);
  });
});
