import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ProjectObjectivesController } from './project-objectives.controller.js';
import { ProjectObjectivesService } from './project-objectives.service.js';
import type { ProjectObjectivesRepository } from './project-objectives.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectObjectiveRow } from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x124). The project-objectives controller over the module's fakes with the **real**
 * `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are proven separately
 * in `apps/api/test/migrator.db.test.ts` and `apps/api/test/proj-001-objectives.db.test.ts`; here the
 * subject is the controller + service logic:
 *
 * - the create → list → transition round-trip;
 * - the guarded state machine — a transition is legal only from `open`, and an illegal one is a 409
 *   with no write;
 * - the Known-trap — an unknown / cross-tenant `projectId` (create, list) or `objectiveId` (patch) is
 *   a 404 with no write, never a foreign-key 500; a caller who names a project they do not manage
 *   gets the same not-found rather than a 403;
 * - the route ceilings — writes require `project.manage`, the list requires `work.read` (the coarse
 *   check `CapabilityGuard` makes, so a role without the ceiling is a 403 before the handler runs).
 *
 * The fake `list` deliberately does **not** apply the tenant scope the real SQL applies, so ordering
 * and relation are the service's own to get right.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
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

/** An org-wide manager: passes the relation gate for any project of the tenant. */
const owner = principal('owner', [], true);
/** A manager related to PROJECT only: holds project.manage, but relation-scoped to its projects. */
const managerOnProject = principal('manager', [PROJECT]);
/** A manager related to no project and not org-wide: holds the ceiling, fails the relation gate. */
const managerElsewhere = principal('manager', []);

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function build(
  seed: readonly ProjectObjectiveRow[] = [],
  knownProjectIds: readonly string[] = [PROJECT],
): { controller: ProjectObjectivesController; store: ProjectObjectiveRow[] } {
  const store: ProjectObjectiveRow[] = [...seed];
  let seq = store.length;
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    list: async (_runner: unknown, ctx: TenantContext, options: { readonly projectId: string }) =>
      store
        .filter(
          (row) => row.projectId === options.projectId && row.organizationId === ctx.organizationId,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    findById: async (_runner: unknown, ctx: TenantContext, objectiveId: string) =>
      store.find((row) => row.id === objectiveId && row.organizationId === ctx.organizationId) ??
      null,
    updateStatus: async (
      _runner: unknown,
      ctx: TenantContext,
      objectiveId: string,
      status: ProjectObjectiveRow['status'],
    ) => {
      const row = store.find(
        (candidate) =>
          candidate.id === objectiveId && candidate.organizationId === ctx.organizationId,
      );
      if (!row) throw new Error(`objective ${objectiveId} not found`);
      row.status = status;
      return row;
    },
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        readonly projectId: string;
        readonly name: string;
        readonly description?: string | null;
        readonly target?: string | null;
        readonly status: ProjectObjectiveRow['status'];
        readonly createdBy: string;
      },
    ) => {
      const row = {
        id: `objective-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        name: input.name,
        description: input.description ?? null,
        target: input.target ?? null,
        status: input.status,
        createdBy: input.createdBy,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as ProjectObjectiveRow;
      store.push(row);
      return row;
    },
  } as unknown as ProjectObjectivesRepository;
  const projects = {
    findById: async (_runner: unknown, ctx: TenantContext, projectId: string) =>
      knownProjectIds.includes(projectId) && ctx.organizationId === ORG
        ? ({ id: projectId } as unknown)
        : null,
  } as unknown as ProjectsRepository;

  const service = new ProjectObjectivesService(database, repository, projects);
  return { controller: new ProjectObjectivesController(service), store };
}

describe('ProjectObjectivesController create → list → transition', () => {
  it('creates an objective open, lists it, and transitions it to met', async () => {
    const { controller } = build();

    const created = await controller.create(context, owner, PROJECT, {
      name: 'Cut lead time',
      description: 'Halve the time from brief to first draft.',
      target: '≤ 3 days',
    });
    expect(created.status).toBe('open');
    expect(created.projectId).toBe(PROJECT);
    expect((created as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const listed = await controller.list(context, owner, PROJECT);
    expect(listed.objectives.map((o) => o.id)).toEqual([created.id]);

    const met = await controller.patch(context, owner, created.id, { status: 'met' });
    expect(met.status).toBe('met');
  });

  it('lists a project’s objectives in creation order', async () => {
    const { controller } = build();
    const first = await controller.create(context, owner, PROJECT, { name: 'First' });
    const second = await controller.create(context, owner, PROJECT, { name: 'Second' });
    const listed = await controller.list(context, owner, PROJECT);
    expect(listed.objectives.map((o) => o.id)).toEqual([first.id, second.id]);
  });
});

describe('the guarded transition', () => {
  it('rejects transitioning an already-closed objective with a 409 and no write', async () => {
    const { controller, store } = build();
    const created = await controller.create(context, owner, PROJECT, { name: 'Ship' });
    await controller.patch(context, owner, created.id, { status: 'met' });

    await expect(
      controller.patch(context, owner, created.id, { status: 'missed' }),
    ).rejects.toEqual(expect.objectContaining({ status: 409, code: 'conflict' }));
    // No write: the status is still the first, legal transition's result.
    expect(store.find((row) => row.id === created.id)?.status).toBe('met');
  });

  it('rejects a body status that is not met or missed with a 422', async () => {
    const { controller } = build();
    const created = await controller.create(context, owner, PROJECT, { name: 'Ship' });
    await expect(
      controller.patch(context, owner, created.id, { status: 'open' as unknown as 'met' }),
    ).rejects.toEqual(expect.objectContaining({ status: 422 }));
  });
});

describe('the Known-trap: an unknown or cross-tenant id is a 404, no write, never a 500', () => {
  it('create against an unknown project is a 404 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, UNKNOWN_PROJECT, { name: 'Orphan' }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });

  it('list against an unknown project is a 404', async () => {
    const { controller } = build();
    await expect(controller.list(context, owner, UNKNOWN_PROJECT)).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('patch against an unknown objective is a 404 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.patch(context, owner, 'objective-0000-0000-0000-0000000000ff', { status: 'met' }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });

  it('a cross-tenant objective is invisible to a patch (resolved tenant-scoped first)', async () => {
    const foreign = {
      id: 'objective-0000-0000-0000-0000000000aa',
      organizationId: OTHER_ORG,
      projectId: PROJECT,
      name: 'Someone else’s',
      description: null,
      target: null,
      status: 'open',
      createdBy: USER,
      createdAt: new Date(),
    } as ProjectObjectiveRow;
    const { controller } = build([foreign]);
    await expect(controller.patch(context, owner, foreign.id, { status: 'met' })).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe('the relation gate (real authorize)', () => {
  it('a manager related to the project may create and transition', async () => {
    const { controller } = build();
    const created = await controller.create(context, managerOnProject, PROJECT, { name: 'Owned' });
    const met = await controller.patch(context, managerOnProject, created.id, { status: 'met' });
    expect(met.status).toBe('met');
  });

  it('a manager not related to the project gets not-found, never a 403 that confirms it exists', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, managerElsewhere, PROJECT, { name: 'Not mine' }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });
});

describe('the route ceilings the CapabilityGuard enforces', () => {
  it('requires project.manage to write and work.read to list', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(ProjectObjectivesController.prototype.create)).toBe('project.manage');
    expect(cap(ProjectObjectivesController.prototype.patch)).toBe('project.manage');
    expect(cap(ProjectObjectivesController.prototype.list)).toBe('work.read');
  });
});
