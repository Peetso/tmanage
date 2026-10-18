import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ProjectPortfolioController } from './portfolio.controller.js';
import { ProjectPortfolioService } from './portfolio.service.js';
import {
  ProjectPortfolioCapacityService,
  findConstraint,
  foldDisciplines,
  parseWeek,
} from './portfolio-capacity.service.js';
import type { PortfolioCapacityRepository } from './portfolio-capacity.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import type {
  PortfolioMilestoneRow,
  ProjectObjectiveCountRow,
  ProjectPortfolioPlanningRepository,
  ProjectPortfolioRepository,
  ProjectWorkSummaryRow,
} from './portfolio.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRow } from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x137). The portfolio controller over the module's fakes with the **real**
 * `authorize()` evaluator. The tenant-scoped SQL round-trip and the aggregates are proven separately
 * in the chain's DB suite; here the subject is the controller + service logic:
 *
 * - the roll-up covers only the projects the caller may see (the relation filter), and each row folds
 *   the project's open-work count, its x124 objective tallies by status, and its latest activity;
 * - the Known-trap — a cross-tenant project never appears, and the aggregates are handed only the
 *   visible ids, so a foreign project's counts cannot leak into the page;
 * - the route ceiling — the list requires `work.read` (the coarse check `CapabilityGuard` makes, so a
 *   role without the ceiling is a 403 before the handler runs).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT_A = 'project-0000-0000-0000-0000-00000000000a';
const PROJECT_B = 'project-0000-0000-0000-0000-00000000000b';
const FOREIGN = 'project-0000-0000-0000-0000-0000000000ff';
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
const managerOnA = principal('manager', [PROJECT_A]);
const managerElsewhere = principal('manager', []);

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function project(id: string, organizationId: string, over: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id,
    organizationId,
    workspaceId: 'workspace-0000-0000-0000-000000000001',
    name: `Project ${id.slice(-1)}`,
    status: 'active',
    ownerUserId: USER,
    committedAt: null,
    forecastAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, 2)),
    archivedAt: null,
    ...over,
  } as ProjectRow;
}

function member(
  membershipId: string,
  userId: string,
  weeklyHours: number,
  department: string | null,
  effectiveFrom = '2026-01-01',
) {
  return { membershipId, userId, weeklyHours, effectiveFrom, department };
}

function build(
  projectSeed: readonly ProjectRow[],
  workSeed: readonly ProjectWorkSummaryRow[] = [],
  objectiveSeed: readonly ProjectObjectiveCountRow[] = [],
  milestoneSeed: readonly PortfolioMilestoneRow[] = [],
): { controller: ProjectPortfolioController; askedFor: string[][]; unstaffedFor: string[][] } {
  const askedFor: string[][] = [];
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const projects = {
    // The real repository is tenant-scoped; the fake mirrors that by returning only ORG rows in id
    // order, so a cross-tenant row cannot reach the service at all.
    list: async (_runner: unknown, ctx: TenantContext) =>
      projectSeed
        .filter((row) => row.organizationId === ctx.organizationId)
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
  } as unknown as ProjectsRepository;

  const portfolio = {
    workSummaries: async (_runner: unknown, _ctx: TenantContext, ids: readonly string[]) => {
      askedFor.push([...ids]);
      return workSeed.filter((row) => ids.includes(row.projectId));
    },
    objectiveCounts: async (_runner: unknown, _ctx: TenantContext, ids: readonly string[]) =>
      objectiveSeed.filter((row) => ids.includes(row.projectId)),
  } as unknown as ProjectPortfolioRepository;

  const planning = {
    milestones: async (_runner: unknown, _ctx: TenantContext, ids: readonly string[]) =>
      milestoneSeed.filter((row) => ids.includes(row.projectId)),
    clients: async (_runner: unknown, _ctx: TenantContext, ids: readonly string[]) =>
      ids.includes(PROJECT_A) ? [{ projectId: PROJECT_A, clientName: 'Atlas Hospitality' }] : [],
    clientWaits: async (_runner: unknown, _ctx: TenantContext, ids: readonly string[]) =>
      ids.includes(PROJECT_A)
        ? [{ projectId: PROJECT_A, waitingSince: new Date(Date.UTC(2026, 2, 3)) }]
        : [],
    people: async (_runner: unknown, _ctx: TenantContext, ids: readonly string[]) =>
      ids.includes(USER) ? [{ userId: USER, displayName: 'Omar Adel' }] : [],
  } as unknown as ProjectPortfolioPlanningRepository;

  const unstaffedFor: string[][] = [];
  const capacityRepository = {
    members: async () => [member('m1', 'u1', 40, 'Design'), member('m2', 'u2', 40, 'Design')],
    allocations: async () => [
      { membershipId: 'm1', percent: 100 },
      { membershipId: 'm1', percent: 20 },
      { membershipId: 'm2', percent: 100 },
    ],
    unstaffed: async (_runner: unknown, _ctx: TenantContext, ids: readonly string[]) => {
      unstaffedFor.push([...ids]);
      return { total: 0, items: [] };
    },
    weekWork: async () => [],
  } as unknown as PortfolioCapacityRepository;

  const service = new ProjectPortfolioService(database, projects, portfolio, planning);
  const capacity = new ProjectPortfolioCapacityService(
    database,
    projects,
    capacityRepository,
    planning,
    () => new Date(Date.UTC(2026, 7, 19)),
  );
  return {
    controller: new ProjectPortfolioController(service, capacity),
    askedFor,
    unstaffedFor,
  };
}

describe('ProjectPortfolioController roll-up', () => {
  it('summarises each visible project with open work, objective tallies, and latest activity', async () => {
    const { controller } = build(
      [project(PROJECT_A, ORG), project(PROJECT_B, ORG)],
      [
        {
          projectId: PROJECT_A,
          openWorkCount: 3,
          latestActivityAt: new Date(Date.UTC(2026, 2, 1)),
        },
        { projectId: PROJECT_B, openWorkCount: 0, latestActivityAt: null },
      ],
      [
        { projectId: PROJECT_A, status: 'open', count: 2 },
        { projectId: PROJECT_A, status: 'met', count: 1 },
      ],
    );

    const { projects } = await controller.list(context, owner);

    expect(projects.map((p) => p.projectId)).toEqual([PROJECT_A, PROJECT_B]);
    const a = projects[0]!;
    expect(a.openWorkCount).toBe(3);
    expect(a.objectiveCounts).toEqual({ open: 2, met: 1, missed: 0 });
    // Latest activity is the later of the work activity and the project's own updated_at.
    expect(a.latestActivityAt).toBe(new Date(Date.UTC(2026, 2, 1)).toISOString());
    // A project with no work still appears, with zeroed counts and its own updated_at as activity.
    const b = projects[1]!;
    expect(b.openWorkCount).toBe(0);
    expect(b.objectiveCounts).toEqual({ open: 0, met: 0, missed: 0 });
    expect(b.latestActivityAt).toBe(new Date(Date.UTC(2026, 0, 2)).toISOString());
    // No organization id leaks into the projection.
    expect((a as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();
  });

  it('rolls up only projects the caller may see, and never a cross-tenant project', async () => {
    const { controller, askedFor } = build(
      [project(PROJECT_A, ORG), project(PROJECT_B, ORG), project(FOREIGN, OTHER_ORG)],
      [
        { projectId: PROJECT_A, openWorkCount: 1, latestActivityAt: null },
        // A foreign project's summary must never be selected; if it were, this would surface it.
        { projectId: FOREIGN, openWorkCount: 99, latestActivityAt: null },
      ],
    );

    // A manager related to A only sees exactly A — not B (unrelated, same tenant), not FOREIGN.
    const { projects } = await controller.list(context, managerOnA);
    expect(projects.map((p) => p.projectId)).toEqual([PROJECT_A]);
    // The aggregate was handed only the visible ids, so a foreign project can never contribute.
    expect(askedFor[0]).toEqual([PROJECT_A]);
  });

  it('returns an empty portfolio for a caller related to no project', async () => {
    const { controller, askedFor } = build([project(PROJECT_A, ORG), project(PROJECT_B, ORG)]);
    const { projects } = await controller.list(context, managerElsewhere);
    expect(projects).toEqual([]);
    // An empty allowlist reaches the aggregate, which short-circuits to no rows.
    expect(askedFor[0]).toEqual([]);
  });
});

describe('POR-01 commitment columns', () => {
  it('folds commitment, forecast, client, owner and client wait into each row', async () => {
    const { controller } = build(
      [
        project(PROJECT_A, ORG, { forecastAt: '2026-09-04' }),
        project(PROJECT_B, ORG, { committedAt: '2026-11-03', ownerUserId: null }),
      ],
      [],
      [],
      [
        {
          projectId: PROJECT_A,
          title: 'Sign-off',
          dueOn: '2026-08-10',
          status: 'met',
          published: true,
        },
        {
          projectId: PROJECT_A,
          title: 'Launch',
          dueOn: '2026-08-26',
          status: 'planned',
          published: true,
        },
      ],
    );
    const { projects } = await controller.list(context, owner);
    const [a, b] = projects;
    // No recorded commitment: the earliest still-planned dated milestone is the commitment.
    expect(a).toMatchObject({
      committedOn: '2026-08-26',
      forecastOn: '2026-09-04',
      clientName: 'Atlas Hospitality',
      ownerName: 'Omar Adel',
      clientWaitSince: new Date(Date.UTC(2026, 2, 3)).toISOString(),
      startedOn: '2026-01-01',
    });
    expect(a!.milestones.map((m) => m.title)).toEqual(['Sign-off', 'Launch']);
    // A recorded commitment wins; no owner, client or pending approval reads as null.
    expect(b).toMatchObject({
      committedOn: '2026-11-03',
      forecastOn: null,
      clientName: null,
      ownerName: null,
      clientWaitSince: null,
    });
  });
});

describe('POR-03 capacity', () => {
  it('loads each discipline as allocated hours over capacity and names the constraint', () => {
    const members = [
      member('m1', 'u1', 40, 'Design'),
      member('m2', 'u2', 20, null),
      // Capacity not yet in effect this week: not counted.
      member('m3', 'u3', 40, 'Design', '2026-09-01'),
    ];
    const loads = foldDisciplines(
      members,
      [
        { membershipId: 'm1', percent: 80 },
        { membershipId: 'm1', percent: 38 },
        { membershipId: 'm2', percent: 50 },
      ],
      '2026-08-23',
    );
    expect(loads).toEqual([
      {
        discipline: 'Design',
        members: 1,
        capacityHours: 40,
        allocatedHours: 47.2,
        loadPercent: 118,
      },
      { discipline: null, members: 1, capacityHours: 20, allocatedHours: 10, loadPercent: 50 },
    ]);
    const constraint = findConstraint(
      loads,
      members,
      [
        { ownerUserId: 'u1', projectId: PROJECT_A, audience: 'internal' },
        { ownerUserId: 'u1', projectId: PROJECT_B, audience: 'internal' },
        { ownerUserId: 'u1', projectId: PROJECT_B, audience: 'client_visible' },
      ],
      new Set([PROJECT_A]),
    );
    // Only internal-audience work in a project with no client counts as a movable date.
    expect(constraint).toEqual({
      discipline: 'Design',
      loadPercent: 118,
      internalDatesThisWeek: 1,
    });
  });

  it('reads the week from its Monday and refuses a malformed week', async () => {
    const { controller } = build([project(PROJECT_A, ORG)]);
    const view = await controller.capacity(context, owner, '2026-08-20');
    expect(view.weekStart).toBe('2026-08-17');
    expect(view.constraint).toMatchObject({ discipline: 'Design', loadPercent: 110 });
    expect(parseWeek(undefined, new Date(Date.UTC(2026, 7, 19)))).toBe('2026-08-17');
    expect(() => parseWeek('2026-02-30', new Date())).toThrow(/week must be a date/);
  });

  it('lists unstaffed work only from visible projects and refuses a client principal', async () => {
    const { controller, unstaffedFor } = build([project(PROJECT_A, ORG), project(PROJECT_B, ORG)]);
    await controller.capacity(context, managerOnA);
    expect(unstaffedFor[0]).toEqual([PROJECT_A]);

    const client: Principal = {
      ...principal('client_member', [PROJECT_A]),
      kind: 'client',
      clientOrganizationId: 'client-org-0000-0000-000000000001',
    };
    await expect(controller.capacity(context, client)).rejects.toMatchObject({ status: 403 });
  });
});

describe('the route ceiling the CapabilityGuard enforces', () => {
  it('requires work.read to read portfolio capacity', () => {
    const cap = Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      ProjectPortfolioController.prototype.capacity as object,
    );
    expect(cap).toBe('work.read');
  });

  it('requires work.read to list the portfolio', () => {
    const cap = Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      ProjectPortfolioController.prototype.list as object,
    );
    expect(cap).toBe('work.read');
  });
});
