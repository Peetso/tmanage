import { describe, expect, it } from 'vitest';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ProjectBaselineController } from './baseline.controller.js';
import {
  MAX_BASELINES_PER_PROJECT,
  ProjectBaselineService,
  computeDeltaDays,
} from './baseline.service.js';
import type { WorkingCalendarRepository } from '../working-calendar/working-calendar.repository.js';
import type { ProjectBaselineRepository } from './baseline.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectBaselineRow, ProjectMilestoneRow } from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x295). The milestone-plan baseline controller over the module's fakes with the
 * **real** `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are proven in
 * the DB suites (out of this build's scope); here the subject is the controller + service logic:
 * the snapshot → list → variance round-trip and the recomputed slippage; the Known-trap
 * (unknown/cross-tenant id ⇒ 404, no write, never a foreign-key 500); label validation; and the
 * `project.manage` ceiling the `CapabilityGuard` enforces on every route.
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
const member = principal('member', [PROJECT]);
const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function milestone(id: string, title: string, dueOn: string | null): ProjectMilestoneRow {
  return {
    id,
    organizationId: ORG,
    projectId: PROJECT,
    title,
    dueOn,
    status: 'planned',
    published: false,
    createdByUserId: USER,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, 1)),
  } as ProjectMilestoneRow;
}

function build(
  milestones: readonly ProjectMilestoneRow[] = [],
  knownProjectIds: readonly string[] = [PROJECT],
  seed: readonly ProjectBaselineRow[] = [],
): {
  controller: ProjectBaselineController;
  store: ProjectBaselineRow[];
  live: ProjectMilestoneRow[];
} {
  const store: ProjectBaselineRow[] = [...seed];
  const live: ProjectMilestoneRow[] = [...milestones];
  let seq = store.length;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    listMilestones: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      live.filter((m) => m.projectId === projectId && m.organizationId === ctx.organizationId),
    list: async (_r: unknown, ctx: TenantContext, options: { readonly projectId: string }) =>
      store
        .filter((b) => b.projectId === options.projectId && b.organizationId === ctx.organizationId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      store.find((b) => b.id === id && b.organizationId === ctx.organizationId) ?? null,
    create: async (
      _r: unknown,
      ctx: TenantContext,
      input: {
        readonly projectId: string;
        readonly label: string;
        readonly snapshot: unknown;
        readonly createdBy: string;
      },
    ) => {
      const row = {
        id: `baseline-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        label: input.label,
        snapshot: input.snapshot,
        kind: 'full',
        isCurrent: false,
        note: null,
        createdBy: input.createdBy,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as ProjectBaselineRow;
      store.push(row);
      return row;
    },
    countForProject: async () => store.length,
    listLiveItems: async () => [],
    insertItems: async () => undefined,
    listItems: async () => [],
    itemCounts: async () => new Map(),
    findCurrent: async () => store.find((b) => b.isCurrent) ?? null,
    requireById: async (_r: unknown, _c: unknown, id: string) => store.find((b) => b.id === id),
    setCurrent: async (_r: unknown, _c: unknown, _p: string, id: string) => {
      for (const b of store) (b as { isCurrent: boolean }).isCurrent = b.id === id;
    },
    delete: async (_r: unknown, ctx: TenantContext, id: string) => {
      const i = store.findIndex((b) => b.id === id && b.organizationId === ctx.organizationId);
      if (i >= 0) store.splice(i, 1);
    },
  } as unknown as ProjectBaselineRepository;
  const projects = {
    findById: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      knownProjectIds.includes(projectId) && ctx.organizationId === ORG
        ? ({ id: projectId } as unknown)
        : null,
  } as unknown as ProjectsRepository;

  const calendars = {
    findCalendar: async () => null,
    organizationTimeZone: async () => 'UTC',
  } as unknown as WorkingCalendarRepository;
  const service = new ProjectBaselineService(database, repository, projects, { calendars });
  return { controller: new ProjectBaselineController(service), store, live };
}

describe('computeDeltaDays', () => {
  it('is currentDate - baselineDate in whole days, and null when either date is absent', () => {
    expect(computeDeltaDays('2026-03-01', '2026-03-08')).toBe(7);
    expect(computeDeltaDays('2026-03-10', '2026-03-01')).toBe(-9);
    expect(computeDeltaDays(null, '2026-03-01')).toBeNull();
    expect(computeDeltaDays('2026-03-01', null)).toBeNull();
  });
});

describe('ProjectBaselineController snapshot → list → variance', () => {
  it('freezes the plan, lists it, and recomputes slippage against the live milestones', async () => {
    const built = build([milestone('m1', 'Design', '2026-03-01'), milestone('m2', 'Launch', null)]);
    const created = await built.controller.create(context, owner, PROJECT, { label: 'Kickoff' });
    expect(created.milestoneCount).toBe(2);
    expect((created as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const listed = await built.controller.list(context, owner, PROJECT);
    expect(listed.baselines.map((b) => b.id)).toEqual([created.id]);

    // The live milestone slips a week; variance must show +7 recomputed at read time.
    built.live[0] = milestone('m1', 'Design', '2026-03-08');
    const variance = await built.controller.variance(context, owner, PROJECT, created.id);
    const design = variance.rows.find((r) => r.milestoneId === 'm1');
    expect(design).toMatchObject({
      baselineDate: '2026-03-01',
      currentDate: '2026-03-08',
      deltaDays: 7,
    });
  });
});

describe('validation', () => {
  it('rejects an empty label with a 400 and writes nothing', async () => {
    const { controller, store } = build([milestone('m1', 'Design', '2026-03-01')]);
    await expect(controller.create(context, owner, PROJECT, { label: '   ' })).rejects.toEqual(
      expect.objectContaining({ status: 400, code: 'validation_failed' }),
    );
    expect(store).toHaveLength(0);
  });
});

describe('the Known-trap: an unknown or cross-tenant id is a 404, no write, never a 500', () => {
  it('a snapshot against an unknown project is a 404 and writes nothing', async () => {
    const { controller, store } = build([], []);
    await expect(
      controller.create(context, owner, UNKNOWN_PROJECT, { label: 'Orphan' }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });

  it('a snapshot of a project in another tenant is a 404 and writes nothing (refusal proof)', async () => {
    // The project id exists, but only in another organization: the tenant-scoped resolve returns
    // nothing here, so the snapshot is refused before any insert.
    const crossTenant = { organizationId: OTHER_ORG, userId: USER } as unknown as TenantContext;
    const { controller, store } = build([milestone('m1', 'Design', '2026-03-01')]);
    await expect(
      controller.create(crossTenant, owner, PROJECT, { label: 'Not mine' }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });

  it('a manager not related to the project gets not-found, never a 403 that confirms it exists', async () => {
    const { controller, store } = build([milestone('m1', 'Design', '2026-03-01')]);
    await expect(
      controller.create(context, managerElsewhere, PROJECT, { label: 'Not mine' }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });

  it('variance for a baseline of another project is a 404', async () => {
    const foreign = {
      id: 'baseline-0000-0000-0000-0000000000aa',
      organizationId: ORG,
      projectId: 'project-0000-0000-0000-0000-0000000000ee',
      label: 'Other project',
      snapshot: [],
      kind: 'milestones',
      isCurrent: false,
      note: null,
      createdBy: USER,
      createdAt: new Date(),
    } as ProjectBaselineRow;
    const { controller } = build([], [PROJECT], [foreign]);
    await expect(controller.variance(context, owner, PROJECT, foreign.id)).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe('53-05 — cap, current baseline, delete-current', () => {
  it('refuses the 51st baseline of a project with 422', async () => {
    const seed = Array.from({ length: MAX_BASELINES_PER_PROJECT }, (_, i) => ({
      id: `b-${i}`,
      organizationId: ORG,
      projectId: PROJECT,
      snapshot: [],
      createdAt: new Date(),
    })) as unknown as ProjectBaselineRow[];
    const { controller } = build([], [PROJECT], seed);
    await expect(controller.create(context, owner, PROJECT, { label: 'One more' })).rejects.toEqual(
      expect.objectContaining({ status: 422, auditCode: 'baseline_limit' }),
    );
  });

  it('keeps exactly one current baseline and refuses deleting it (409)', async () => {
    const { controller, store } = build();
    const a = await controller.create(context, owner, PROJECT, { label: 'A' });
    const b = await controller.create(context, owner, PROJECT, { label: 'B' });
    await controller.patch(context, owner, PROJECT, a.id, { isCurrent: true });
    await controller.patch(context, owner, PROJECT, b.id, { isCurrent: true });
    expect(store.filter((row) => row.isCurrent).map((row) => row.id)).toEqual([b.id]);
    await expect(controller.discard(context, owner, PROJECT, b.id)).rejects.toEqual(
      expect.objectContaining({ status: 409, auditCode: 'baseline_is_current' }),
    );
  });
});

describe('the route ceiling the CapabilityGuard enforces', () => {
  it('writes need project.manage, reads need work.read; a member reads but cannot PATCH', async () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    const proto = ProjectBaselineController.prototype;
    for (const write of [proto.create, proto.patch, proto.discard]) {
      expect(cap(write)).toBe('project.manage');
    }
    for (const read of [proto.list, proto.variance, proto.overlay])
      expect(cap(read)).toBe('work.read');

    const { controller } = build([milestone('m1', 'Design', '2026-03-01')]);
    const created = await controller.create(context, owner, PROJECT, { label: 'Kickoff' });
    const seen = await controller.variance(context, member, PROJECT, created.id);
    expect(seen.baselineId).toBe(created.id);
    // The guard's 403: a member lacks project.manage on the PATCH route's capability.
    const resource = {
      organizationId: ORG,
      projectId: PROJECT,
      audience: 'internal' as const,
      lifecycle: 'active' as const,
    };
    expect(authorize({ principal: member, capability: 'project.manage', resource }).allowed).toBe(
      false,
    );
  });
});
