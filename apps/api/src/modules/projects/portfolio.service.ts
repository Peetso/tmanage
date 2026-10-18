import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from './projects.repository.js';
import {
  ProjectPortfolioPlanningRepository,
  ProjectPortfolioRepository,
} from './portfolio.repository.js';
import type { PortfolioMilestoneRow } from './portfolio.repository.js';
import type { ProjectRow } from '../../common/database/schema.js';

/**
 * The application service for PROJ / module 8 (x137) — the project-portfolio roll-up.
 *
 * ## What it is (and is not)
 *
 * A **read** across the caller's visible projects: per project, how much work is open, how its
 * objectives (x124) stand by status, and when work last moved. It is deliberately not a health
 * score — no letter grade, RAG model, or percentage — the same stance `ProjectOverviewScreen` takes:
 * a scored indicator needs a stated formula, and once a colour sits next to a project name people
 * manage the colour. Those are deferred to NS-13. This service returns arithmetic anyone can repeat.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question `work.read`: does this role's ceiling
 * include the capability at all. This service adds the **relation** filter the guard cannot: it lists
 * the tenant's projects, then keeps only the ones `authorize()` allows this principal to read — a
 * member without organization-wide scope sees the projects they belong to, a client principal the
 * projects shared with their client organization. This is the same filter `ProjectsService.list`
 * applies, written once against `authorize()` rather than duplicated as a `WHERE ... IN (...)`.
 *
 * ## The Known-trap (FAST 19:55)
 *
 * Tenant and project-visibility relation are applied **before** the aggregates read anything: the
 * roll-up covers only the projects the caller may see, and the aggregate queries are handed exactly
 * that id allowlist, so a cross-tenant project never appears and a project the caller may not see
 * contributes nothing. There is no id route and no write, so the not-found/500 mapping the write
 * slices need does not arise here.
 */

/** One project's roll-up. `organizationId` is deliberately absent. */
export interface ProjectPortfolioView {
  readonly projectId: string;
  readonly name: string;
  readonly status: string;
  /** Non-deleted work items that are neither `done` nor `archived`. */
  readonly openWorkCount: number;
  /** The x124 objective tallies by lifecycle status; a status with none is `0`, never absent. */
  readonly objectiveCounts: {
    readonly open: number;
    readonly met: number;
    readonly missed: number;
  };
  /**
   * The latest activity in the project as an ISO-8601 instant, or `null` for a project with no work
   * yet. The later of the project's own `updated_at` and its newest work item's `updated_at`.
   */
  readonly latestActivityAt: string | null;
  /**
   * POR-01's COMMITTED column: the project's recorded commitment date, else the earliest dated
   * milestone still `planned` (a milestone is a dated promise). `'YYYY-MM-DD'` or `null`.
   */
  readonly committedOn: string | null;
  /** POR-01's FORECAST column: the project's recorded forecast date, or `null` when none is set. */
  readonly forecastOn: string | null;
  /** The client organization the project is shared with, or `null` for an internal project. */
  readonly clientName: string | null;
  /** The project owner's display name, or `null` when the project has no owner. */
  readonly ownerName: string | null;
  /**
   * POR-01's CLIENT WAIT: when the project's oldest still-pending approval was requested (ISO
   * instant), or `null` when nothing is waiting on a reviewer.
   */
  readonly clientWaitSince: string | null;
  /** The project's creation day `'YYYY-MM-DD'` — where its POR-02 timeline bar starts. */
  readonly startedOn: string;
  /** When the project was archived (ISO instant), or `null`. */
  readonly archivedAt: string | null;
  /** The project's milestones in due order, for the POR-02 timeline. */
  readonly milestones: readonly PortfolioMilestoneView[];
}

/** One milestone on the POR-02 timeline. */
export interface PortfolioMilestoneView {
  readonly title: string;
  readonly dueOn: string | null;
  readonly status: 'planned' | 'met' | 'missed';
  /** Published to the client portal — a client-facing date. */
  readonly published: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface ListPortfolioOptions {
  readonly limit?: number;
}

export class ProjectPortfolioService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly portfolio: ProjectPortfolioRepository = new ProjectPortfolioRepository(),
    private readonly planning: ProjectPortfolioPlanningRepository = new ProjectPortfolioPlanningRepository(),
  ) {}

  /**
   * The portfolio roll-up across the projects this principal may read, in a deterministic, bounded
   * page.
   *
   * The order is the repository's `id` ascending — the same stable keyset order `ProjectsService`
   * pages by — so the same request returns the same page. The page is bounded to `MAX_LIMIT`. The
   * relation filter runs first; the two aggregates are then handed only the surviving ids.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListPortfolioOptions = {},
  ): Promise<readonly ProjectPortfolioView[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const rows = await this.database.read(context, (runner) =>
      this.projects.list(runner, context, { limit, includeArchived: true }),
    );

    const visible = rows.filter((row) => mayReadProject(principal, row));
    const projectIds = visible.map((row) => row.id);

    const ownerIds = [
      ...new Set(visible.flatMap((row) => (row.ownerUserId ? [row.ownerUserId] : []))),
    ];
    const [workSummaries, objectiveCounts, milestones, clients, waits, people] =
      await this.database.read(context, async (runner) => {
        const work = await this.portfolio.workSummaries(runner, context, projectIds);
        const objectives = await this.portfolio.objectiveCounts(runner, context, projectIds);
        const dated = await this.planning.milestones(runner, context, projectIds);
        const clientRows = await this.planning.clients(runner, context, projectIds);
        const waitRows = await this.planning.clientWaits(runner, context, projectIds);
        const personRows = await this.planning.people(runner, context, ownerIds);
        return [work, objectives, dated, clientRows, waitRows, personRows] as const;
      });

    const milestonesByProject = new Map<string, PortfolioMilestoneRow[]>();
    for (const row of milestones) {
      const list = milestonesByProject.get(row.projectId) ?? [];
      list.push(row);
      milestonesByProject.set(row.projectId, list);
    }
    const clientByProject = new Map(clients.map((row) => [row.projectId, row.clientName]));
    const waitByProject = new Map(waits.map((row) => [row.projectId, row.waitingSince]));
    const nameByUser = new Map(people.map((row) => [row.userId, row.displayName]));

    const workByProject = new Map(workSummaries.map((row) => [row.projectId, row]));
    const objectivesByProject = new Map<string, { open: number; met: number; missed: number }>();
    for (const row of objectiveCounts) {
      const tally = objectivesByProject.get(row.projectId) ?? { open: 0, met: 0, missed: 0 };
      tally[row.status] = row.count;
      objectivesByProject.set(row.projectId, tally);
    }

    return visible.map((project) => {
      const work = workByProject.get(project.id);
      const objectives = objectivesByProject.get(project.id) ?? { open: 0, met: 0, missed: 0 };
      return {
        projectId: project.id,
        name: project.name,
        status: project.status,
        openWorkCount: work?.openWorkCount ?? 0,
        objectiveCounts: {
          open: objectives.open,
          met: objectives.met,
          missed: objectives.missed,
        },
        latestActivityAt: latestActivity(project, work?.latestActivityAt ?? null),
        committedOn: project.committedAt ?? firstPlannedDate(milestonesByProject.get(project.id)),
        forecastOn: project.forecastAt ?? null,
        clientName: clientByProject.get(project.id) ?? null,
        ownerName: project.ownerUserId ? (nameByUser.get(project.ownerUserId) ?? null) : null,
        clientWaitSince: waitByProject.get(project.id)?.toISOString() ?? null,
        startedOn: project.createdAt.toISOString().slice(0, 10),
        archivedAt: project.archivedAt?.toISOString() ?? null,
        milestones: (milestonesByProject.get(project.id) ?? []).map((row) => ({
          title: row.title,
          dueOn: row.dueOn,
          status: row.status,
          published: row.published,
        })),
      };
    });
  }
}

/** The relation gate: `work.read` against the project row, exactly as `ProjectsService.list`. */
export function mayReadProject(principal: Principal, row: ProjectRow): boolean {
  return authorize({
    principal,
    capability: 'work.read',
    resource: {
      organizationId: row.organizationId,
      projectId: row.id,
      audience: 'internal',
      lifecycle: row.archivedAt ? 'archived' : 'active',
    },
  }).allowed;
}

/** The earliest dated milestone still `planned` — rows arrive in due order, undated last. */
export function firstPlannedDate(
  rows: readonly PortfolioMilestoneRow[] | undefined,
): string | null {
  return rows?.find((row) => row.status === 'planned' && row.dueOn !== null)?.dueOn ?? null;
}

/**
 * The later of the project's own `updated_at` and its newest work item's `updated_at`, as an ISO
 * instant. A project always has an `updated_at`, so the result is `null` only when neither exists —
 * which cannot happen — kept as a total function so a future caller need not special-case it.
 */
function latestActivity(project: ProjectRow, workActivity: Date | null): string | null {
  const candidates = [project.updatedAt, workActivity].filter(
    (value): value is Date => value !== null,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b)).toISOString();
}
