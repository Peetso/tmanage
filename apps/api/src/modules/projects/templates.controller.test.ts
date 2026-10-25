import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ProjectTemplatesController } from './templates.controller.js';
import { ProjectTemplatesService } from './templates.service.js';
import {
  DuplicateProjectTemplateNameError,
  type CreateProjectTemplateInput,
  type ProjectTemplatesRepository,
} from './templates.repository.js';
import { ProjectsService } from './projects.service.js';
import type { ProjectView } from './projects.service.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { ProjectMembershipsRepository } from './project-memberships.repository.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectTemplateRow } from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x234). The project-templates controller over the module's fakes with the **real**
 * `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are proven in the DB
 * suites (out of this build's scope); here the subject is the controller + service logic: define →
 * list; instantiate through the **shared** project-create path (never a divergent create); the
 * duplicate-name 409; the Known-trap (unknown/cross-tenant `:id` ⇒ 404); the bounded-seed 400; and the
 * org-level `project.manage` ceiling (a role without it ⇒ 403, no project to hide behind).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';
const WORKSPACE = 'workspace-0000-0000-0000-000000000001';

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
/** A member holds `work.read` but not `project.manage`, so it may neither define nor instantiate. */
const member = principal('member');
const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function build(seed: readonly ProjectTemplateRow[] = []): {
  controller: ProjectTemplatesController;
  store: ProjectTemplateRow[];
  createdProjects: { workspaceId: string; name: string }[];
} {
  const store: ProjectTemplateRow[] = [...seed];
  let seq = store.length;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    list: async (_r: unknown, ctx: TenantContext) =>
      store
        .filter((row) => row.organizationId === ctx.organizationId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      store.find((row) => row.id === id && row.organizationId === ctx.organizationId) ?? null,
    create: async (_r: unknown, ctx: TenantContext, input: CreateProjectTemplateInput) => {
      if (
        store.some((row) => row.organizationId === ctx.organizationId && row.name === input.name)
      ) {
        throw new DuplicateProjectTemplateNameError(input.name);
      }
      const row = {
        id: `template-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        name: input.name,
        description: input.description ?? null,
        defaultObjectivesJson: input.defaultObjectives ?? null,
        createdBy: input.createdBy,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as ProjectTemplateRow;
      store.push(row);
      return row;
    },
  } as unknown as ProjectTemplatesRepository;

  const createdProjects: { workspaceId: string; name: string }[] = [];
  const projects = {
    requireMayCreate: async () => undefined,
    create: async (
      _c: TenantContext,
      _p: Principal,
      input: { workspaceId: string; name: string },
    ) => {
      createdProjects.push(input);
      return {
        id: `project-from-${input.name}`,
        workspaceId: input.workspaceId,
        name: input.name,
        status: 'active',
        ownerUserId: USER,
        committedAt: null,
        forecastAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        archivedAt: null,
      } satisfies ProjectView;
    },
  } as unknown as ProjectsService;

  const service = new ProjectTemplatesService(database, repository, projects);
  return { controller: new ProjectTemplatesController(service), store, createdProjects };
}

describe('ProjectTemplatesController define → list', () => {
  it('defines a template and lists it, never echoing organizationId', async () => {
    const { controller } = build();
    const created = await controller.create(context, owner, {
      name: 'Kickoff',
      description: 'Standard kickoff',
      defaultObjectives: ['Charter signed', 'Team assembled'],
    });
    expect(created.name).toBe('Kickoff');
    expect(created.defaultObjectives).toEqual(['Charter signed', 'Team assembled']);
    expect((created as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const listed = await controller.list(context, owner);
    expect(listed.templates.map((t) => t.id)).toEqual([created.id]);
  });
});

describe('instantiate reuses the shared project-create path', () => {
  it('creates a project through ProjectsService.create, seeded from the template name', async () => {
    const { controller, createdProjects } = build();
    const template = await controller.create(context, owner, { name: 'Kickoff' });
    const project = await controller.instantiate(context, owner, template.id, {
      workspaceId: WORKSPACE,
    });
    expect(project.name).toBe('Kickoff');
    expect(createdProjects).toEqual([{ workspaceId: WORKSPACE, name: 'Kickoff' }]);
  });
});

describe('validation', () => {
  it('rejects a duplicate name with a 409 and writes nothing new', async () => {
    const { controller, store } = build();
    await controller.create(context, owner, { name: 'Kickoff' });
    await expect(controller.create(context, owner, { name: 'Kickoff' })).rejects.toEqual(
      expect.objectContaining({ status: 409, code: 'conflict' }),
    );
    expect(store).toHaveLength(1);
  });

  it('rejects a malformed seed (non-string default objective) with a 400 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, {
        name: 'Bad seed',
        defaultObjectives: [42 as unknown as string],
      } as never),
    ).rejects.toEqual(expect.objectContaining({ status: 400, code: 'validation_failed' }));
    expect(store).toHaveLength(0);
  });
});

describe('the Known-trap: an unknown or cross-tenant :id is a 404, never a 500', () => {
  it('instantiate against a cross-tenant template is a 404 and creates no project', async () => {
    const foreign = {
      id: 'template-0000-0000-0000-0000000000aa',
      organizationId: OTHER_ORG,
      name: 'Someone else’s',
      description: null,
      defaultObjectivesJson: null,
      createdBy: USER,
      createdAt: new Date(),
    } as ProjectTemplateRow;
    const { controller, createdProjects } = build([foreign]);
    await expect(
      controller.instantiate(context, owner, foreign.id, { workspaceId: WORKSPACE }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(createdProjects).toHaveLength(0);
  });
});

describe('org-level authorization (real authorize)', () => {
  it('a role without project.manage gets a 403 on define, and nothing is written', async () => {
    const { controller, store } = build();
    await expect(controller.create(context, member, { name: 'Not mine' })).rejects.toEqual(
      expect.objectContaining({ status: 403, code: 'forbidden' }),
    );
    expect(store).toHaveLength(0);
  });

  it('requires project.manage on define, list, and instantiate', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(ProjectTemplatesController.prototype.create)).toBe('project.manage');
    expect(cap(ProjectTemplatesController.prototype.list)).toBe('project.manage');
    expect(cap(ProjectTemplatesController.prototype.instantiate)).toBe('project.manage');
  });
});

/** A9 — "New project from a template": the plan is copied with dates moved to the start date. */
describe('A9 instantiate copies the template plan', () => {
  function buildA9(template: Partial<ProjectTemplateRow>) {
    const row = {
      id: 'template-a9',
      organizationId: ORG,
      name: 'Website build',
      description: null,
      defaultObjectivesJson: null,
      milestonesJson: [
        { title: 'Discovery', offsetDays: 0, clientVisible: true },
        { title: 'Launch', offsetDays: 37, clientVisible: false },
      ],
      workItemsJson: [{ title: 'Kickoff call', offsetDays: 2 }, { title: 'Sitemap' }],
      clientPortalOn: true,
      repeatInterval: null,
      createdBy: USER,
      createdAt: new Date(),
      ...template,
    } as ProjectTemplateRow;
    const database = {
      read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
      transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
    } as unknown as TenantDatabase;
    const repository = {
      findById: async (_r: unknown, _c: TenantContext, id: string) => (id === row.id ? row : null),
      list: async () => [row],
    } as unknown as ProjectTemplatesRepository;
    const created: Record<string, unknown>[] = [];
    const projects = {
      requireMayCreate: async () => undefined,
      create: async (_c: TenantContext, _p: Principal, input: Record<string, unknown>) => {
        created.push(input);
        return { id: 'project-new', name: input['name'] } as unknown as ProjectView;
      },
    } as unknown as ProjectsService;
    const writes = {
      milestones: [] as Record<string, unknown>[],
      workItems: [] as Record<string, unknown>[],
      shares: [] as Record<string, unknown>[],
      leads: [] as Record<string, unknown>[],
    };
    const members = {
      findByUserId: async (_r: unknown, _c: TenantContext, userId: string) =>
        userId === 'user-lead' ? { userId, status: 'active', role: 'manager' } : null,
    };
    const projectMembers = {
      add: async (_r: unknown, _c: TenantContext, input: Record<string, unknown>) => {
        writes.leads.push(input);
        return { id: 'pm-1', ...input };
      },
    };
    const clientOrganizations = {
      findById: async (_r: unknown, _c: TenantContext, id: string) =>
        id === 'client-atlas' ? { id, name: 'Atlas Hospitality', archivedAt: null } : null,
    };
    const shares = {
      share: async (_r: unknown, _c: TenantContext, input: Record<string, unknown>) => {
        writes.shares.push(input);
        return { id: 'share-1', ...input };
      },
    };
    const milestones = {
      create: async (_r: unknown, _c: TenantContext, input: Record<string, unknown>) => {
        writes.milestones.push(input);
        return input;
      },
    };
    const workItems = {
      create: async (_r: unknown, _c: TenantContext, input: Record<string, unknown>) => {
        writes.workItems.push(input);
        return input;
      },
    };
    const service = new ProjectTemplatesService(
      database,
      repository,
      projects,
      undefined,
      members as never,
      projectMembers as never,
      clientOrganizations as never,
      shares as never,
      milestones as never,
      workItems as never,
    );
    return { controller: new ProjectTemplatesController(service), created, writes };
  }

  it('lists milestone and work-item counts and whether the client portal is on', async () => {
    const { controller } = buildA9({});
    const [view] = (await controller.list(context, owner)).templates;
    expect(view).toMatchObject({ milestoneCount: 2, workItemCount: 2, clientPortalOn: true });
  });

  it('shifts every date to the start date, shares the project and adds the lead', async () => {
    const { controller, created, writes } = buildA9({});
    await controller.instantiate(context, owner, 'template-a9', {
      workspaceId: WORKSPACE,
      name: 'Atlas spa microsite',
      startDate: '2026-11-03',
      clientOrganizationId: 'client-atlas',
      leadUserId: 'user-lead',
    });

    expect(created).toEqual([
      { workspaceId: WORKSPACE, name: 'Atlas spa microsite', ownerUserId: 'user-lead' },
    ]);
    expect(writes.milestones.map((m) => [m['title'], m['dueOn'], m['published']])).toEqual([
      ['Discovery', '2026-11-03', true],
      ['Launch', '2026-12-10', false],
    ]);
    expect(writes.workItems.map((w) => w['dueAt'])).toEqual([
      new Date('2026-11-05T00:00:00.000Z'),
      undefined,
    ]);
    expect(writes.shares).toEqual([
      { projectId: 'project-new', clientOrganizationId: 'client-atlas' },
    ]);
    expect(writes.leads).toEqual([
      { projectId: 'project-new', userId: 'user-lead', role: 'manager' },
    ]);
  });

  it('refuses an unknown lead with a 400 before any project is created', async () => {
    const { controller, created } = buildA9({});
    await expect(
      controller.instantiate(context, owner, 'template-a9', {
        workspaceId: WORKSPACE,
        leadUserId: 'user-stranger',
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 400, code: 'validation_failed' }));
    expect(created).toHaveLength(0);
  });

  it('rejects a malformed start date with a 400', async () => {
    const { controller } = buildA9({});
    await expect(
      controller.instantiate(context, owner, 'template-a9', {
        workspaceId: WORKSPACE,
        startDate: '3 Nov',
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 400 }));
  });
});

describe('F47: instantiate answers to the creation policy (real ProjectsService)', () => {
  const TEMPLATE = {
    id: 'template-f47',
    organizationId: ORG,
    name: 'Bypass',
    description: null,
    defaultObjectivesJson: null,
    createdBy: USER,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
  } as ProjectTemplateRow;

  function buildReal(switchValue: 'true' | 'false'): {
    controller: ProjectTemplatesController;
    projectRows: unknown[];
  } {
    const projectRows: unknown[] = [];
    const database = {
      read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
      transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
    } as unknown as TenantDatabase;
    const repository = {
      findById: async (_r: unknown, ctx: TenantContext, id: string) =>
        id === TEMPLATE.id && ctx.organizationId === ORG ? TEMPLATE : null,
    } as unknown as ProjectTemplatesRepository;
    const projectsRepo = {
      create: async (_r: unknown, _c: unknown, input: { workspaceId: string; name: string }) => {
        const row = {
          id: 'project-f47',
          organizationId: ORG,
          workspaceId: input.workspaceId,
          name: input.name,
          status: 'active',
          ownerUserId: USER,
          committedAt: null,
          forecastAt: null,
          createdAt: new Date(Date.UTC(2026, 0, 1)),
          updatedAt: new Date(Date.UTC(2026, 0, 1)),
          archivedAt: null,
        };
        projectRows.push(row);
        return row;
      },
    } as unknown as ProjectsRepository;
    const memberships = {
      add: async (_r: unknown, _c: unknown, input: Record<string, string>) => ({
        id: 'pm-f47',
        ...input,
      }),
    } as unknown as ProjectMembershipsRepository;
    const orgSettings = {
      findByKey: async () => ({ settingValue: switchValue }),
    } as unknown as OrgSettingsRepository;
    const projects = new ProjectsService(
      database,
      projectsRepo,
      undefined,
      memberships,
      orgSettings,
    );
    const service = new ProjectTemplatesService(database, repository, projects);
    return { controller: new ProjectTemplatesController(service), projectRows };
  }

  it('switch off: a manager instantiating a template is refused and no project is created', async () => {
    const { controller, projectRows } = buildReal('false');
    await expect(
      controller.instantiate(context, principal('manager'), TEMPLATE.id, {
        workspaceId: WORKSPACE,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ status: 403, auditCode: 'org_policy:members_can_create_projects' }),
    );
    expect(projectRows).toHaveLength(0);
  });

  it('switch off: the owner still instantiates (201)', async () => {
    const { controller, projectRows } = buildReal('false');
    const project = await controller.instantiate(context, owner, TEMPLATE.id, {
      workspaceId: WORKSPACE,
    });
    expect(project.name).toBe('Bypass');
    expect(projectRows).toHaveLength(1);
  });

  it('switch on: a manager instantiates as before', async () => {
    const { controller, projectRows } = buildReal('true');
    await controller.instantiate(context, principal('manager'), TEMPLATE.id, {
      workspaceId: WORKSPACE,
    });
    expect(projectRows).toHaveLength(1);
  });
});
