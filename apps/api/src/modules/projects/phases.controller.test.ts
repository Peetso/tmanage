import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ProjectPhasesController } from './phases.controller.js';
import { ProjectPhasesService } from './phases.service.js';
import type { MilestoneRef, ProjectPhasesRepository } from './phases.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectPhaseRow } from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x294). The project-phases controller over the module's fakes with the **real**
 * `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are proven in the DB
 * suites (out of this build's scope); here the subject is the controller + service logic: the
 * define → list → assign round-trip; the Known-trap (unknown/cross-tenant id ⇒ 404, no write, never
 * a foreign-key 500); duplicate-name 409 and empty-name 400; the relation gate; and the route
 * ceilings the `CapabilityGuard` enforces (all four routes require `project.manage`).
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

const owner = principal('owner', [], true);
const managerElsewhere = principal('manager', []);
const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function build(
  seedMilestones: readonly { id: string; organizationId: string; projectId: string }[] = [
    { id: 'milestone-0000-0000-0000-0000-00000000000a', organizationId: ORG, projectId: PROJECT },
  ],
  knownProjectIds: readonly string[] = [PROJECT],
): { controller: ProjectPhasesController; store: ProjectPhaseRow[] } {
  const store: ProjectPhaseRow[] = [];
  let seq = 0;
  const isDef = (r: ProjectPhaseRow): boolean => r.milestoneId === null;

  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    listDefinitions: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      store.filter(
        (r) => isDef(r) && r.organizationId === ctx.organizationId && r.projectId === projectId,
      ),
    listAssignments: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      store.filter(
        (r) => !isDef(r) && r.organizationId === ctx.organizationId && r.projectId === projectId,
      ),
    findDefinitionById: async (_r: unknown, ctx: TenantContext, phaseId: string) =>
      store.find((r) => isDef(r) && r.id === phaseId && r.organizationId === ctx.organizationId) ??
      null,
    findDefinitionByName: async (
      _r: unknown,
      ctx: TenantContext,
      projectId: string,
      name: string,
    ) =>
      store.find(
        (r) =>
          isDef(r) &&
          r.organizationId === ctx.organizationId &&
          r.projectId === projectId &&
          r.name === name,
      ) ?? null,
    createDefinition: async (
      _r: unknown,
      ctx: TenantContext,
      input: { projectId: string; name: string; position: number },
    ) => {
      const row = {
        id: `phase-0000-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        name: input.name,
        position: input.position,
        milestoneId: null,
        phaseId: null,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as ProjectPhaseRow;
      store.push(row);
      return row;
    },
    deleteDefinition: async (_r: unknown, ctx: TenantContext, phaseId: string) => {
      for (let i = store.length - 1; i >= 0; i -= 1) {
        const r = store[i] as ProjectPhaseRow;
        if (
          r.organizationId === ctx.organizationId &&
          (r.id === phaseId || r.phaseId === phaseId)
        ) {
          store.splice(i, 1);
        }
      }
    },
    findAssignmentByMilestone: async (_r: unknown, ctx: TenantContext, milestoneId: string) =>
      store.find((r) => r.milestoneId === milestoneId && r.organizationId === ctx.organizationId) ??
      null,
    assignMilestone: async (
      _r: unknown,
      ctx: TenantContext,
      input: { projectId: string; milestoneId: string; phaseId: string },
    ) => {
      const existing = store.find(
        (r) => r.milestoneId === input.milestoneId && r.organizationId === ctx.organizationId,
      );
      if (existing) {
        existing.phaseId = input.phaseId;
        return existing;
      }
      const row = {
        id: `phase-0000-0000-0000-0000-0000000000a${++seq}`,
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        name: null,
        position: null,
        milestoneId: input.milestoneId,
        phaseId: input.phaseId,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as ProjectPhaseRow;
      store.push(row);
      return row;
    },
    updateDefinitionDates: async (
      _r: unknown,
      ctx: TenantContext,
      phaseId: string,
      input: { startsOn: string | null; endsOn: string | null; colorToken: string | null },
    ) => {
      const row = store.find(
        (r) => isDef(r) && r.id === phaseId && r.organizationId === ctx.organizationId,
      );
      if (!row) return null;
      Object.assign(row, input);
      return row;
    },
    findMilestoneRef: async (
      _r: unknown,
      ctx: TenantContext,
      milestoneId: string,
    ): Promise<MilestoneRef | null> => {
      const m = seedMilestones.find(
        (x) => x.id === milestoneId && x.organizationId === ctx.organizationId,
      );
      return m ? { id: m.id, projectId: m.projectId } : null;
    },
  } as unknown as ProjectPhasesRepository;

  const projects = {
    findById: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      knownProjectIds.includes(projectId) && ctx.organizationId === ORG
        ? ({ id: projectId } as unknown)
        : null,
  } as unknown as ProjectsRepository;

  const service = new ProjectPhasesService(database, repository, projects);
  return { controller: new ProjectPhasesController(service), store };
}

describe('ProjectPhasesController define → list → assign', () => {
  it('defines phases, lists them ordered, and folds in an assigned milestone', async () => {
    const { controller } = build();
    const discovery = await controller.create(context, owner, PROJECT, {
      name: 'Discovery',
      position: 0,
    });
    await controller.create(context, owner, PROJECT, { name: 'Build', position: 1 });
    expect((discovery as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const assignment = await controller.assign(
      context,
      owner,
      'milestone-0000-0000-0000-0000-00000000000a',
      discovery.id,
    );
    expect(assignment.phaseId).toBe(discovery.id);

    const listed = await controller.list(context, owner, PROJECT);
    expect(listed.phases.map((p) => p.name)).toEqual(['Discovery', 'Build']);
    expect(listed.phases[0]?.milestoneIds).toEqual(['milestone-0000-0000-0000-0000-00000000000a']);
  });

  it('is idempotent: re-assigning the same milestone rewrites its phase, adds no row', async () => {
    const { controller, store } = build();
    const a = await controller.create(context, owner, PROJECT, { name: 'A', position: 0 });
    const b = await controller.create(context, owner, PROJECT, { name: 'B', position: 1 });
    const mid = 'milestone-0000-0000-0000-0000-00000000000a';
    await controller.assign(context, owner, mid, a.id);
    await controller.assign(context, owner, mid, b.id);
    expect(store.filter((r) => r.milestoneId === mid)).toHaveLength(1);
    expect(store.find((r) => r.milestoneId === mid)?.phaseId).toBe(b.id);
  });
});

describe('validation', () => {
  it('rejects an empty name with a 400 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, PROJECT, { name: '   ', position: 0 }),
    ).rejects.toEqual(expect.objectContaining({ status: 400, code: 'validation_failed' }));
    expect(store).toHaveLength(0);
  });

  it('rejects a duplicate phase name in a project with a 409', async () => {
    const { controller, store } = build();
    await controller.create(context, owner, PROJECT, { name: 'Discovery', position: 0 });
    await expect(
      controller.create(context, owner, PROJECT, { name: 'Discovery', position: 1 }),
    ).rejects.toEqual(expect.objectContaining({ status: 409, code: 'conflict' }));
    expect(store).toHaveLength(1);
  });
});

describe('the Known-trap: an unknown or cross-tenant id is a 404, no write, never a 500', () => {
  it('define against an unknown project is a 404 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, UNKNOWN_PROJECT, { name: 'Orphan', position: 0 }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });

  // The mandatory refusal: a milestone from another tenant cannot be assigned.
  it('assigning a milestone from another tenant is a 404 and writes no assignment row', async () => {
    const { controller, store } = build([
      {
        id: 'milestone-0000-0000-0000-0000-0000000000ff',
        organizationId: OTHER_ORG,
        projectId: PROJECT,
      },
    ]);
    const phase = await controller.create(context, owner, PROJECT, {
      name: 'Discovery',
      position: 0,
    });
    await expect(
      controller.assign(context, owner, 'milestone-0000-0000-0000-0000-0000000000ff', phase.id),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store.filter((r) => r.milestoneId !== null)).toHaveLength(0);
  });
});

describe('the relation gate (real authorize)', () => {
  it('a manager not related to the project gets not-found, never a 403 that confirms it exists', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, managerElsewhere, PROJECT, { name: 'Not mine', position: 0 }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });
});

describe('the route ceilings the CapabilityGuard enforces', () => {
  // "Define without project.manage ⇒ 403": every write and read requires project.manage, which the
  // global CapabilityGuard turns into a 403 for a principal lacking it.
  it('requires project.manage on all four routes', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(ProjectPhasesController.prototype.create)).toBe('project.manage');
    expect(cap(ProjectPhasesController.prototype.list)).toBe('project.manage');
    expect(cap(ProjectPhasesController.prototype.remove)).toBe('project.manage');
    expect(cap(ProjectPhasesController.prototype.assign)).toBe('project.manage');
  });
});

describe('53-07 phase band dates', () => {
  it('sets a definition row’s dates and colour, and 404s on an assignment row', async () => {
    const { controller, store } = build();
    const phase = await controller.create(context, owner, PROJECT, { name: 'Build', position: 0 });
    const view = await controller.setDates(context, owner, PROJECT, phase.id, {
      startsOn: '2026-11-01',
      endsOn: '2026-12-31',
      colorToken: 'accent.teal',
    });
    expect(view).toMatchObject({
      startsOn: '2026-11-01',
      endsOn: '2026-12-31',
      colorToken: 'accent.teal',
    });

    const mid = 'milestone-0000-0000-0000-0000-00000000000a';
    await controller.assign(context, owner, mid, phase.id);
    const assignmentId = store.find((r) => r.milestoneId === mid)?.id as string;
    await expect(
      controller.setDates(context, owner, PROJECT, assignmentId, {
        startsOn: '2026-11-01',
        endsOn: null,
        colorToken: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an end before the start (400) and guards the route with project.manage', async () => {
    const { controller } = build();
    const phase = await controller.create(context, owner, PROJECT, { name: 'QA', position: 0 });
    await expect(
      controller.setDates(context, owner, PROJECT, phase.id, {
        startsOn: '2026-12-31',
        endsOn: '2026-11-01',
        colorToken: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const handler = (ProjectPhasesController.prototype as unknown as Record<string, object>)[
      'setDates'
    ] as object;
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, handler)).toBe('project.manage');
  });
});
