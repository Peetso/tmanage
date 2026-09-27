import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { MilestoneLinksController } from './milestone-links.controller.js';
import { MilestoneLinksService } from './milestone-links.service.js';
import type {
  CreateMilestoneLinkInput,
  MilestoneEdge,
  MilestoneLinkWithTarget,
  MilestoneLinksRepository,
} from './milestone-links.repository.js';
import type { ProjectMilestonesRepository } from '../clients/project-milestones.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MilestoneLinkRow, ProjectMilestoneRow } from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x236). The milestone-links controller over the module's fakes with the **real**
 * `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are the chain's DB
 * suite; here the subject is the controller + service logic:
 *
 * - the link → list → unlink round-trip, and the idempotent re-link;
 * - the invariants — a self-link is 400, a cycle is 400;
 * - the Known-trap — an unknown / cross-tenant milestone and a prerequisite in another project are
 *   each a 404 with no write, never a foreign-key 500;
 * - the relation gate (real authorize) — a manager not related to the project gets not-found;
 * - the route ceiling — every route requires `project.manage`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const OTHER_PROJECT = 'project-0000-0000-0000-0000-000000000002';
const M1 = 'milestone-0000-0000-0000-00000000000a';
const M2 = 'milestone-0000-0000-0000-00000000000b';
const M3 = 'milestone-0000-0000-0000-00000000000c';
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

function milestoneRow(id: string, organizationId = ORG, projectId = PROJECT): ProjectMilestoneRow {
  return {
    id,
    organizationId,
    projectId,
    title: `Milestone ${id}`,
    dueOn: null,
    status: 'planned',
    published: true,
    createdByUserId: USER,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, 1)),
  } as ProjectMilestoneRow;
}

function build(options: {
  milestones?: readonly ProjectMilestoneRow[];
  linksSeed?: readonly MilestoneLinkRow[];
}): { controller: MilestoneLinksController; store: MilestoneLinkRow[] } {
  const milestonesStore = [
    ...(options.milestones ?? [milestoneRow(M1), milestoneRow(M2), milestoneRow(M3)]),
  ];
  const store: MilestoneLinkRow[] = [...(options.linksSeed ?? [])];
  let seq = store.length;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const milestonesRepo = {
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      milestonesStore.find((row) => row.id === id && row.organizationId === ctx.organizationId) ??
      null,
  } as unknown as ProjectMilestonesRepository;

  const linksRepo = {
    listByMilestone: async (
      _runner: unknown,
      ctx: TenantContext,
      milestoneId: string,
    ): Promise<readonly MilestoneLinkWithTarget[]> =>
      store
        .filter(
          (row) => row.milestoneId === milestoneId && row.organizationId === ctx.organizationId,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((link) => {
          const target = milestonesStore.find((m) => m.id === link.dependsOnMilestoneId);
          return {
            link,
            dependsOnTitle: target?.title ?? '',
            dependsOnStatus: target?.status ?? 'planned',
          };
        }),
    listEdgesForProject: async (): Promise<readonly MilestoneEdge[]> =>
      store.map((row) => ({
        milestoneId: row.milestoneId,
        dependsOnMilestoneId: row.dependsOnMilestoneId,
      })),
    findByPair: async (
      _runner: unknown,
      ctx: TenantContext,
      milestoneId: string,
      dependsOnMilestoneId: string,
    ) =>
      store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.milestoneId === milestoneId &&
          row.dependsOnMilestoneId === dependsOnMilestoneId,
      ) ?? null,
    findById: async (_runner: unknown, ctx: TenantContext, linkId: string) =>
      store.find((row) => row.id === linkId && row.organizationId === ctx.organizationId) ?? null,
    create: async (_runner: unknown, ctx: TenantContext, input: CreateMilestoneLinkInput) => {
      const row = {
        id: `link-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        milestoneId: input.milestoneId,
        dependsOnMilestoneId: input.dependsOnMilestoneId,
        createdBy: input.createdBy,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as MilestoneLinkRow;
      store.push(row);
      return row;
    },
    deleteById: async (_runner: unknown, ctx: TenantContext, linkId: string) => {
      const index = store.findIndex(
        (row) => row.id === linkId && row.organizationId === ctx.organizationId,
      );
      if (index >= 0) store.splice(index, 1);
    },
  } as unknown as MilestoneLinksRepository;

  const service = new MilestoneLinksService(database, linksRepo, milestonesRepo);
  return { controller: new MilestoneLinksController(service), store };
}

describe('MilestoneLinksController link → list → unlink', () => {
  it('links a dependency, lists it, and unlinks it', async () => {
    const { controller, store } = build({});

    const created = await controller.link(context, owner, M1, { dependsOnMilestoneId: M2 });
    expect(created.milestoneId).toBe(M1);
    expect(created.dependsOnMilestoneId).toBe(M2);
    expect(created.dependsOnTitle).toBe(`Milestone ${M2}`);
    expect((created as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const listed = await controller.list(context, owner, M1);
    expect(listed.dependencies.map((d) => d.dependsOnMilestoneId)).toEqual([M2]);

    await controller.unlink(context, owner, M1, M2);
    expect(store).toHaveLength(0);
  });

  it('re-linking the same pair is idempotent (no second row)', async () => {
    const { controller, store } = build({});
    const first = await controller.link(context, owner, M1, { dependsOnMilestoneId: M2 });
    const second = await controller.link(context, owner, M1, { dependsOnMilestoneId: M2 });
    expect(second.linkId).toBe(first.linkId);
    expect(store).toHaveLength(1);
  });
});

describe('the invariants', () => {
  it('a self-link is a 400 and writes nothing', async () => {
    const { controller, store } = build({});
    await expect(
      controller.link(context, owner, M1, { dependsOnMilestoneId: M1 }),
    ).rejects.toEqual(expect.objectContaining({ status: 400, code: 'validation_failed' }));
    expect(store).toHaveLength(0);
  });

  it('a cycle is a 400 and writes nothing', async () => {
    // Seed M2 → M1. Adding M1 → M2 would close the cycle.
    const seed = {
      id: 'link-0000-0000-0000-0000000000aa',
      organizationId: ORG,
      milestoneId: M2,
      dependsOnMilestoneId: M1,
      createdBy: USER,
      createdAt: new Date(Date.UTC(2026, 0, 1)),
    } as MilestoneLinkRow;
    const { controller, store } = build({ linksSeed: [seed] });
    await expect(
      controller.link(context, owner, M1, { dependsOnMilestoneId: M2 }),
    ).rejects.toEqual(expect.objectContaining({ status: 400, code: 'validation_failed' }));
    expect(store).toHaveLength(1);
  });

  it('rejects a transitive cycle (M3→M1 with M2→M3 seeded, linking M1→M2)', async () => {
    const seeds = [
      {
        id: 'link-0000-0000-0000-0000000000ab',
        organizationId: ORG,
        milestoneId: M2,
        dependsOnMilestoneId: M3,
        createdBy: USER,
        createdAt: new Date(Date.UTC(2026, 0, 1)),
      },
      {
        id: 'link-0000-0000-0000-0000000000ac',
        organizationId: ORG,
        milestoneId: M3,
        dependsOnMilestoneId: M1,
        createdBy: USER,
        createdAt: new Date(Date.UTC(2026, 0, 2)),
      },
    ] as MilestoneLinkRow[];
    const { controller, store } = build({ linksSeed: seeds });
    await expect(
      controller.link(context, owner, M1, { dependsOnMilestoneId: M2 }),
    ).rejects.toEqual(expect.objectContaining({ status: 400 }));
    expect(store).toHaveLength(2);
  });
});

describe('the Known-trap: an unknown or cross-tenant id is a 404, no write, never a 500', () => {
  it('link against an unknown milestone is a 404 and writes nothing', async () => {
    const { controller, store } = build({ milestones: [] });
    await expect(
      controller.link(context, owner, M1, { dependsOnMilestoneId: M2 }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });

  it('a prerequisite in another project is a 404 and writes nothing', async () => {
    const { controller, store } = build({
      milestones: [milestoneRow(M1), milestoneRow(M2, ORG, OTHER_PROJECT)],
    });
    await expect(
      controller.link(context, owner, M1, { dependsOnMilestoneId: M2 }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });

  it('a cross-tenant milestone is invisible to link (resolved tenant-scoped first)', async () => {
    const { controller, store } = build({
      milestones: [milestoneRow(M1, OTHER_ORG, PROJECT), milestoneRow(M2, OTHER_ORG, PROJECT)],
    });
    await expect(
      controller.link(context, owner, M1, { dependsOnMilestoneId: M2 }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });
});

describe('the relation gate (real authorize)', () => {
  it('a manager not related to the project gets not-found, never a 403 that confirms it exists', async () => {
    const { controller, store } = build({});
    await expect(
      controller.link(context, managerElsewhere, M1, { dependsOnMilestoneId: M2 }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });
});

describe('the route ceilings the CapabilityGuard enforces', () => {
  it('requires project.manage to link, unlink and list', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(MilestoneLinksController.prototype.link)).toBe('project.manage');
    expect(cap(MilestoneLinksController.prototype.unlink)).toBe('project.manage');
    expect(cap(MilestoneLinksController.prototype.list)).toBe('project.manage');
  });
});
