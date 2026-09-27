import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ProjectRiskRegisterController } from './risk-register.controller.js';
import { ProjectRiskRegisterService, computeSeverity } from './risk-register.service.js';
import type { ProjectRiskRegisterRepository } from './risk-register.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectInternalRiskRow } from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x209). The internal risk-register controller over the module's fakes with the
 * **real** `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are proven in
 * the DB suites (out of this build's scope); here the subject is the controller + service logic:
 * the log → list → update round-trip and the computed severity; the Known-trap (unknown/cross-tenant
 * id ⇒ 404, never a foreign-key 500); the enum validation (unknown ⇒ 400); the relation gate; and the
 * route ceilings the `CapabilityGuard` enforces.
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
const managerOnProject = principal('manager', [PROJECT]);
const managerElsewhere = principal('manager', []);
const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function build(
  seed: readonly ProjectInternalRiskRow[] = [],
  knownProjectIds: readonly string[] = [PROJECT],
): { controller: ProjectRiskRegisterController; store: ProjectInternalRiskRow[] } {
  const store: ProjectInternalRiskRow[] = [...seed];
  let seq = store.length;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    list: async (_r: unknown, ctx: TenantContext, options: { readonly projectId: string }) =>
      store
        .filter(
          (row) => row.projectId === options.projectId && row.organizationId === ctx.organizationId,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    findById: async (_r: unknown, ctx: TenantContext, riskId: string) =>
      store.find((row) => row.id === riskId && row.organizationId === ctx.organizationId) ?? null,
    update: async (
      _r: unknown,
      ctx: TenantContext,
      riskId: string,
      input: Partial<ProjectInternalRiskRow>,
    ) => {
      const row = store.find((c) => c.id === riskId && c.organizationId === ctx.organizationId);
      if (!row) throw new Error(`risk ${riskId} not found`);
      Object.assign(row, input);
      return row;
    },
    create: async (
      _r: unknown,
      ctx: TenantContext,
      input: {
        readonly projectId: string;
        readonly title: string;
        readonly likelihood: ProjectInternalRiskRow['likelihood'];
        readonly impact: ProjectInternalRiskRow['impact'];
        readonly mitigation?: string | null;
        readonly status: ProjectInternalRiskRow['status'];
        readonly createdBy: string;
      },
    ) => {
      const row = {
        id: `risk-0000-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        title: input.title,
        likelihood: input.likelihood,
        impact: input.impact,
        mitigation: input.mitigation ?? null,
        status: input.status,
        createdBy: input.createdBy,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as ProjectInternalRiskRow;
      store.push(row);
      return row;
    },
  } as unknown as ProjectRiskRegisterRepository;
  const projects = {
    findById: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      knownProjectIds.includes(projectId) && ctx.organizationId === ORG
        ? ({ id: projectId } as unknown)
        : null,
  } as unknown as ProjectsRepository;

  const service = new ProjectRiskRegisterService(database, repository, projects);
  return { controller: new ProjectRiskRegisterController(service), store };
}

describe('computeSeverity (the likelihood × impact matrix)', () => {
  it('is the product band: low·low low, low·high medium, high·high high', () => {
    expect(computeSeverity('low', 'low')).toBe('low');
    expect(computeSeverity('low', 'high')).toBe('medium');
    expect(computeSeverity('medium', 'medium')).toBe('medium');
    expect(computeSeverity('medium', 'high')).toBe('high');
    expect(computeSeverity('high', 'high')).toBe('high');
  });
});

describe('ProjectRiskRegisterController log → list → update', () => {
  it('logs a risk, computes its severity, lists it, and updates its status', async () => {
    const { controller } = build();
    const created = await controller.create(context, owner, PROJECT, {
      title: 'Vendor may slip',
      likelihood: 'high',
      impact: 'high',
      mitigation: 'Weekly check-in',
    });
    expect(created.severity).toBe('high');
    expect(created.status).toBe('open');
    expect((created as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const listed = await controller.list(context, owner, PROJECT);
    expect(listed.risks.map((r) => r.id)).toEqual([created.id]);

    const updated = await controller.patch(context, owner, created.id, { status: 'mitigated' });
    expect(updated.status).toBe('mitigated');
  });
});

describe('validation', () => {
  it('rejects an unknown likelihood/impact enum with a 400 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, PROJECT, {
        title: 'Bad enum',
        likelihood: 'catastrophic' as unknown as 'high',
        impact: 'high',
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 400, code: 'validation_failed' }));
    expect(store).toHaveLength(0);
  });

  it('rejects an empty PATCH body with a 400', async () => {
    const { controller } = build();
    const created = await controller.create(context, owner, PROJECT, {
      title: 'X',
      likelihood: 'low',
      impact: 'low',
    });
    await expect(controller.patch(context, owner, created.id, {})).rejects.toEqual(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe('the Known-trap: an unknown or cross-tenant id is a 404, no write, never a 500', () => {
  it('create against an unknown project is a 404 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, UNKNOWN_PROJECT, {
        title: 'Orphan',
        likelihood: 'low',
        impact: 'low',
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });

  it('a cross-tenant risk is invisible to a patch (resolved tenant-scoped first)', async () => {
    const foreign = {
      id: 'risk-0000-0000-0000-0000-0000000000aa',
      organizationId: OTHER_ORG,
      projectId: PROJECT,
      title: 'Someone else’s',
      likelihood: 'low',
      impact: 'low',
      mitigation: null,
      status: 'open',
      createdBy: USER,
      createdAt: new Date(),
    } as ProjectInternalRiskRow;
    const { controller } = build([foreign]);
    await expect(
      controller.patch(context, owner, foreign.id, { status: 'closed' }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
  });
});

describe('the relation gate (real authorize)', () => {
  it('a manager related to the project may log and update', async () => {
    const { controller } = build();
    const created = await controller.create(context, managerOnProject, PROJECT, {
      title: 'Owned',
      likelihood: 'medium',
      impact: 'medium',
    });
    const updated = await controller.patch(context, managerOnProject, created.id, {
      status: 'mitigating',
    });
    expect(updated.status).toBe('mitigating');
  });

  it('a manager not related to the project gets not-found, never a 403 that confirms it exists', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, managerElsewhere, PROJECT, {
        title: 'Not mine',
        likelihood: 'low',
        impact: 'low',
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });
});

describe('the route ceilings the CapabilityGuard enforces', () => {
  it('requires project.manage to write and work.read to list', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(ProjectRiskRegisterController.prototype.create)).toBe('project.manage');
    expect(cap(ProjectRiskRegisterController.prototype.patch)).toBe('project.manage');
    expect(cap(ProjectRiskRegisterController.prototype.list)).toBe('work.read');
  });
});
