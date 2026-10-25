import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ProjectRetroNotesController } from './retro-notes.controller.js';
import { ProjectRetroNotesService } from './retro-notes.service.js';
import type { ProjectRetroNotesRepository } from './retro-notes.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { ProjectMilestonesRepository } from '../clients/project-milestones.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRetroNoteRow } from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x311). The retro-notes controller over the module's fakes with the **real**
 * `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are proven in the DB
 * suites (out of this build's scope); here the subject is the controller + service logic: the
 * capture → list-by-category round-trip; the Known-trap (unknown/cross-tenant `projectId` ⇒ 404,
 * never a foreign-key 500, and nothing written); the category allowlist (off-allowlist ⇒ 400); an
 * unknown/foreign milestone ⇒ 400 with nothing written; the relation gate (a non-member earns
 * not-found); idempotent delete; and the `project.manage` ceiling the `CapabilityGuard` enforces on
 * every route.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const UNKNOWN_PROJECT = 'project-0000-0000-0000-0000-0000000000ff';
const MILESTONE = 'milestone-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';

function principal(role: Principal['role'], orgWide = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: orgWide,
  };
}

const owner = principal('owner', true);
const managerElsewhere = principal('manager');
const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function build(
  knownProjectIds: readonly string[] = [PROJECT],
  milestoneProjectId: string | null = PROJECT,
): { controller: ProjectRetroNotesController; store: ProjectRetroNoteRow[] } {
  const store: ProjectRetroNoteRow[] = [];
  let seq = 0;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    listByProject: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      store
        .filter((row) => row.projectId === projectId && row.organizationId === ctx.organizationId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    create: async (
      _r: unknown,
      ctx: TenantContext,
      input: {
        readonly projectId: string;
        readonly milestoneId: string | null;
        readonly category: ProjectRetroNoteRow['category'];
        readonly body: string;
        readonly createdBy: string;
      },
    ) => {
      const row = {
        id: `retro-0000-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        milestoneId: input.milestoneId,
        category: input.category,
        body: input.body,
        createdBy: input.createdBy,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as ProjectRetroNoteRow;
      store.push(row);
      return row;
    },
    deleteById: async (_r: unknown, ctx: TenantContext, projectId: string, noteId: string) => {
      const index = store.findIndex(
        (row) =>
          row.id === noteId &&
          row.organizationId === ctx.organizationId &&
          row.projectId === projectId,
      );
      if (index >= 0) store.splice(index, 1);
    },
  } as unknown as ProjectRetroNotesRepository;
  const projects = {
    findById: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      knownProjectIds.includes(projectId) && ctx.organizationId === ORG
        ? ({ id: projectId } as unknown)
        : null,
  } as unknown as ProjectsRepository;
  const milestones = {
    findById: async (_r: unknown, ctx: TenantContext, milestoneId: string) =>
      milestoneProjectId !== null && milestoneId === MILESTONE && ctx.organizationId === ORG
        ? ({ id: milestoneId, projectId: milestoneProjectId } as unknown)
        : null,
  } as unknown as ProjectMilestonesRepository;

  const service = new ProjectRetroNotesService(database, repository, projects, milestones);
  return { controller: new ProjectRetroNotesController(service), store };
}

describe('ProjectRetroNotesController capture → list', () => {
  it('captures notes, then lists them grouped by category (organizationId never echoed)', async () => {
    const { controller } = build();
    const first = await controller.create(context, owner, PROJECT, {
      category: 'went_well',
      body: 'Shipping cadence held.',
      milestoneId: MILESTONE,
    });
    await controller.create(context, owner, PROJECT, {
      category: 'to_improve',
      body: 'Standups ran long.',
    });
    expect(first.milestoneId).toBe(MILESTONE);
    expect((first as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const board = await controller.list(context, owner, PROJECT);
    expect(board.wentWell.map((n) => n.body)).toEqual(['Shipping cadence held.']);
    expect(board.toImprove).toHaveLength(1);
    expect(board.action).toHaveLength(0);
  });

  it('deletes a note idempotently (204, a missing id removes nothing)', async () => {
    const { controller, store } = build();
    const note = await controller.create(context, owner, PROJECT, {
      category: 'action',
      body: 'Automate the release notes.',
    });
    await expect(controller.remove(context, owner, PROJECT, note.id)).resolves.toBeUndefined();
    expect(store).toHaveLength(0);
    // A repeat (now-missing id) still resolves without throwing.
    await expect(controller.remove(context, owner, PROJECT, note.id)).resolves.toBeUndefined();
  });
});

describe('validation and the Known-trap', () => {
  it('rejects an off-allowlist category with a 400 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, PROJECT, {
        category: 'blocker' as unknown as 'action',
        body: 'x',
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 400, code: 'validation_failed' }));
    expect(store).toHaveLength(0);
  });

  it('rejects an empty body with a 400', async () => {
    const { controller } = build();
    await expect(
      controller.create(context, owner, PROJECT, { category: 'went_well', body: '   ' }),
    ).rejects.toEqual(expect.objectContaining({ status: 400 }));
  });

  it('a note against an unknown/cross-tenant project is a 404, not a 500, and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, UNKNOWN_PROJECT, {
        category: 'action',
        body: 'orphan',
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });

  it('rejects an unknown or foreign milestone with a 400 and writes nothing', async () => {
    // Milestone belongs to a different project than the one named in the path.
    const { controller, store } = build([PROJECT], UNKNOWN_PROJECT);
    await expect(
      controller.create(context, owner, PROJECT, {
        category: 'action',
        body: 'wrong milestone',
        milestoneId: MILESTONE,
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 400, code: 'validation_failed' }));
    expect(store).toHaveLength(0);
  });
});

describe('the relation gate (real authorize)', () => {
  it('a manager not related to the project gets not-found on capture, never a 403', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, managerElsewhere, PROJECT, {
        category: 'went_well',
        body: 'nope',
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });
});

describe('F29: delete is bound to the authorised project', () => {
  it("a manager of project A cannot delete project B's note through A's path", async () => {
    const OTHER_PROJECT = 'project-0000-0000-0000-0000-000000000002';
    const { controller, store } = build([PROJECT, OTHER_PROJECT]);
    const foreign = await controller.create(context, owner, OTHER_PROJECT, {
      category: 'went_well',
      body: 'Project B only.',
    });
    const managerOfA: Principal = { ...principal('manager'), projectIds: [PROJECT] };

    await expect(
      controller.remove(context, managerOfA, PROJECT, foreign.id),
    ).resolves.toBeUndefined();
    expect(store.map((row) => row.id)).toEqual([foreign.id]);
    // The same manager has no route to B at all.
    await expect(controller.remove(context, managerOfA, OTHER_PROJECT, foreign.id)).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
    expect(store).toHaveLength(1);
  });
});

describe('the route ceiling the CapabilityGuard enforces', () => {
  it('requires project.manage to capture, list and delete', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(ProjectRetroNotesController.prototype.create)).toBe('project.manage');
    expect(cap(ProjectRetroNotesController.prototype.list)).toBe('project.manage');
    expect(cap(ProjectRetroNotesController.prototype.remove)).toBe('project.manage');
  });
});
