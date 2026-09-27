import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ProjectHealthController, ProjectHealthListController } from './health.controller.js';
import { ProjectHealthService } from './health.service.js';
import type { ProjectsRepository } from './projects.repository.js';
import type {
  ProjectHealthRepository,
  ProjectMilestoneSignalRow,
  ProjectObjectiveSignalRow,
  ProjectRiskSignalRow,
} from './health.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRow } from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x208). The health controllers over the module's fakes with the **real**
 * `authorize()` evaluator and the **real** scoring/banding. The tenant-scoped SQL round-trip is
 * proven in the chain's DB suite; here the subject is the controller + service logic:
 *
 * - the fixed-weight score and its band (green/amber/red), and the neutral band for a project with no
 *   signals at all (the empty-project guard — no false green, no divide);
 * - the relation filter: the list covers only projects the caller may see, and the aggregates are
 *   handed only the visible ids, so a cross-tenant project never contributes;
 * - the single read maps an invisible or cross-tenant project to 404, never 403;
 * - the route ceiling: both reads require `work.read`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const GREEN = 'project-0000-0000-0000-0000-0000000000g1';
const AMBER = 'project-0000-0000-0000-0000-0000000000a1';
const RED = 'project-0000-0000-0000-0000-0000000000r1';
const EMPTY = 'project-0000-0000-0000-0000-0000000000e1';
const FOREIGN = 'project-0000-0000-0000-0000-0000000000ff';
const USER = 'user-0000-0000-0000-0000-000000000001';

const NOW = () => new Date(Date.UTC(2026, 5, 1));

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
const managerOnGreen = principal('manager', [GREEN]);

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function project(id: string, organizationId: string): ProjectRow {
  return {
    id,
    organizationId,
    workspaceId: 'workspace-0000-0000-0000-000000000001',
    name: `Project ${id.slice(-2)}`,
    status: 'active',
    ownerUserId: USER,
    committedAt: null,
    forecastAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, 2)),
    archivedAt: null,
  } as ProjectRow;
}

function build(
  projectSeed: readonly ProjectRow[],
  milestoneSeed: readonly ProjectMilestoneSignalRow[] = [],
  riskSeed: readonly ProjectRiskSignalRow[] = [],
  objectiveSeed: readonly ProjectObjectiveSignalRow[] = [],
): {
  list: ProjectHealthListController;
  single: ProjectHealthController;
  askedFor: string[][];
} {
  const askedFor: string[][] = [];
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const inOrg = (ctx: TenantContext) =>
    projectSeed
      .filter((row) => row.organizationId === ctx.organizationId)
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1));

  const projects = {
    list: async (_runner: unknown, ctx: TenantContext) => inOrg(ctx),
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      inOrg(ctx).find((row) => row.id === id) ?? null,
  } as unknown as ProjectsRepository;

  const health = {
    milestoneSignals: async (_r: unknown, _c: TenantContext, ids: readonly string[]) => {
      askedFor.push([...ids]);
      return milestoneSeed.filter((row) => ids.includes(row.projectId));
    },
    riskSignals: async (_r: unknown, _c: TenantContext, ids: readonly string[]) =>
      riskSeed.filter((row) => ids.includes(row.projectId)),
    objectiveSignals: async (_r: unknown, _c: TenantContext, ids: readonly string[]) =>
      objectiveSeed.filter((row) => ids.includes(row.projectId)),
  } as unknown as ProjectHealthRepository;

  const service = new ProjectHealthService(database, projects, health, NOW);
  return {
    list: new ProjectHealthListController(service),
    single: new ProjectHealthController(service),
    askedFor,
  };
}

describe('ProjectHealth scoring and banding', () => {
  it('bands each project from its fixed-weight score, and reports an empty project as neutral', async () => {
    const { list } = build(
      [project(GREEN, ORG), project(AMBER, ORG), project(RED, ORG), project(EMPTY, ORG)],
      [
        { projectId: GREEN, overdueMilestones: 1 }, // -15 -> 85 green
        { projectId: AMBER, overdueMilestones: 3 }, // -45 -> 55 amber
      ],
      [
        { projectId: RED, openRisks: 3, highRisks: 3 }, // -60 -> 40 red
      ],
      [{ projectId: GREEN, status: 'met', count: 2 }],
    );

    const { projects } = await list.list(context, owner);
    const byId = new Map(projects.map((p) => [p.projectId, p]));

    const green = byId.get(GREEN)!;
    expect(green.score).toBe(85);
    expect(green.band).toBe('green');
    expect(green.signals.overdueMilestones).toBe(1);
    expect(green.signals.objectivesMet).toBe(2);
    expect(green.signals.objectivesTotal).toBe(2);
    expect((green as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    expect(byId.get(AMBER)!.score).toBe(55);
    expect(byId.get(AMBER)!.band).toBe('amber');

    const red = byId.get(RED)!;
    expect(red.score).toBe(40);
    expect(red.band).toBe('red');
    expect(red.signals.highRisks).toBe(3);

    // No milestones, risks, or objectives at all -> neutral, never a false green.
    const empty = byId.get(EMPTY)!;
    expect(empty.band).toBe('neutral');
    expect(empty.score).toBe(100);
    expect(empty.signals.objectivesTotal).toBe(0);
  });

  it('lists only projects the caller may see, and never hands a cross-tenant id to the aggregates', async () => {
    const { list, askedFor } = build(
      [project(GREEN, ORG), project(RED, ORG), project(FOREIGN, OTHER_ORG)],
      [{ projectId: FOREIGN, overdueMilestones: 9 }],
    );

    const { projects } = await list.list(context, managerOnGreen);
    expect(projects.map((p) => p.projectId)).toEqual([GREEN]);
    // The aggregate was handed only the visible ids, so a foreign project can never contribute.
    expect(askedFor[0]).toEqual([GREEN]);
  });
});

describe('ProjectHealth single read', () => {
  it('returns the health of a visible project', async () => {
    const { single } = build([project(GREEN, ORG)], [{ projectId: GREEN, overdueMilestones: 1 }]);
    const view = await single.get(context, owner, GREEN);
    expect(view.projectId).toBe(GREEN);
    expect(view.band).toBe('green');
  });

  it('maps an unrelated same-tenant project to 404, not 403', async () => {
    const { single } = build([project(GREEN, ORG), project(RED, ORG)]);
    await expect(single.get(context, managerOnGreen, RED)).rejects.toMatchObject({
      status: 404,
    } satisfies Partial<ApiError>);
  });

  it('maps a cross-tenant project to 404 (never confirming it exists)', async () => {
    const { single } = build([project(GREEN, ORG), project(FOREIGN, OTHER_ORG)]);
    await expect(single.get(context, owner, FOREIGN)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the route ceiling the CapabilityGuard enforces', () => {
  it('requires work.read for both the list and the single read', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        ProjectHealthListController.prototype.list as object,
      ),
    ).toBe('work.read');
    expect(
      Reflect.getMetadata(REQUIRED_CAPABILITY, ProjectHealthController.prototype.get as object),
    ).toBe('work.read');
  });
});
