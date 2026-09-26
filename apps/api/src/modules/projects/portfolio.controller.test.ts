import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ProjectPortfolioController } from './portfolio.controller.js';
import { ProjectPortfolioService } from './portfolio.service.js';
import type { ProjectsRepository } from './projects.repository.js';
import type {
  ProjectObjectiveCountRow,
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

function build(
  projectSeed: readonly ProjectRow[],
  workSeed: readonly ProjectWorkSummaryRow[] = [],
  objectiveSeed: readonly ProjectObjectiveCountRow[] = [],
): { controller: ProjectPortfolioController; askedFor: string[][] } {
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

  const service = new ProjectPortfolioService(database, projects, portfolio);
  return { controller: new ProjectPortfolioController(service), askedFor };
}

describe('ProjectPortfolioController roll-up', () => {
  it('summarises each visible project with open work, objective tallies, and latest activity', async () => {
    const { controller } = build(
      [project(PROJECT_A, ORG), project(PROJECT_B, ORG)],
      [
        { projectId: PROJECT_A, openWorkCount: 3, latestActivityAt: new Date(Date.UTC(2026, 2, 1)) },
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

describe('the route ceiling the CapabilityGuard enforces', () => {
  it('requires work.read to list the portfolio', () => {
    const cap = Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      ProjectPortfolioController.prototype.list as object,
    );
    expect(cap).toBe('work.read');
  });
});
