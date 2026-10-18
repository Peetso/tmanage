import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectPortfolioPlanningRepository } from './portfolio.repository.js';
import { PortfolioCapacityRepository } from './portfolio-capacity.repository.js';
import type {
  CapacityAllocationRow,
  CapacityMemberRow,
  WeekWorkRow,
} from './portfolio-capacity.repository.js';
import { mayReadProject } from './portfolio.service.js';

/**
 * POR-03 — portfolio capacity: "where the team is the constraint".
 *
 * Arithmetic, not a model, and the same arithmetic the people heatmap (x193) uses: a member's
 * allocated hours in the week are `weekly_hours × Σ overlapping allocation percent / 100`, counted
 * once their capacity has taken effect. Members are grouped by discipline (`member_profiles.department`;
 * no department is its own group), and a discipline's load is its allocated hours over its capacity.
 * A discipline over 100 % is the constraint. Unstaffed commitments are open work with no owner in the
 * projects this caller may see; the lever counts the constraint discipline's internal-only work
 * (internal audience, in a project shared with no client) due that week — dates that can move
 * without asking a client.
 *
 * Behind `work.read` on the route; this adds the org-scoped deny-by-default `authorize()` and the
 * per-project relation filter, so a caller's unstaffed list never names a project they cannot read.
 */

export interface PortfolioDisciplineLoad {
  /** The discipline, or `null` for members with no department set. */
  readonly discipline: string | null;
  readonly members: number;
  readonly capacityHours: number;
  readonly allocatedHours: number;
  /** `allocatedHours / capacityHours`, as a whole percent. */
  readonly loadPercent: number;
}

export interface PortfolioUnstaffedItem {
  readonly workItemId: string;
  readonly title: string;
  readonly projectId: string;
  readonly projectName: string;
  /** `'YYYY-MM-DD'` (UTC) or `null` for undated work. */
  readonly dueOn: string | null;
}

export interface PortfolioCapacityView {
  /** The Monday the week starts, `'YYYY-MM-DD'`. */
  readonly weekStart: string;
  readonly disciplines: readonly PortfolioDisciplineLoad[];
  readonly unstaffed: { readonly total: number; readonly items: readonly PortfolioUnstaffedItem[] };
  /** The most-loaded discipline over 100 %, or `null` when no discipline is over. */
  readonly constraint: {
    readonly discipline: string | null;
    readonly loadPercent: number;
    /** Its internal-only open work due this week — the dates that can move. */
    readonly internalDatesThisWeek: number;
  } | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Monday on or before `day` (UTC), as `'YYYY-MM-DD'`. */
export function mondayOf(day: Date): string {
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - offset * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
}

/** Parse the optional `week` query: any valid ISO day, normalised to its Monday. */
export function parseWeek(week: string | undefined, now: Date): string {
  if (week === undefined) return mondayOf(now);
  const parsed = ISO_DATE.test(week) ? new Date(`${week}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== week) {
    throw new ApiError(400, 'validation_failed', 'week must be a date YYYY-MM-DD', [
      { field: 'week', message: 'must be a date YYYY-MM-DD' },
    ]);
  }
  return mondayOf(parsed);
}

/** The pure fold: members + overlapping allocations → per-discipline load. */
export function foldDisciplines(
  members: readonly CapacityMemberRow[],
  allocations: readonly CapacityAllocationRow[],
  weekEnd: string,
): PortfolioDisciplineLoad[] {
  const percentByMember = new Map<string, number>();
  for (const row of allocations) {
    percentByMember.set(
      row.membershipId,
      (percentByMember.get(row.membershipId) ?? 0) + row.percent,
    );
  }
  const groups = new Map<string | null, { members: number; capacity: number; allocated: number }>();
  for (const member of members) {
    if (member.effectiveFrom > weekEnd || member.weeklyHours <= 0) continue;
    const group = groups.get(member.department) ?? { members: 0, capacity: 0, allocated: 0 };
    group.members += 1;
    group.capacity += member.weeklyHours;
    group.allocated += (member.weeklyHours * (percentByMember.get(member.membershipId) ?? 0)) / 100;
    groups.set(member.department, group);
  }
  return [...groups]
    .map(([discipline, group]) => ({
      discipline,
      members: group.members,
      capacityHours: group.capacity,
      allocatedHours: Math.round(group.allocated * 100) / 100,
      loadPercent: Math.round((group.allocated / group.capacity) * 100),
    }))
    .sort((a, b) =>
      a.discipline === null
        ? 1
        : b.discipline === null
          ? -1
          : a.discipline.localeCompare(b.discipline),
    );
}

/** The most-loaded discipline over 100 % and its internal-only work due this week. */
export function findConstraint(
  disciplines: readonly PortfolioDisciplineLoad[],
  members: readonly CapacityMemberRow[],
  weekWork: readonly WeekWorkRow[],
  clientProjectIds: ReadonlySet<string>,
): PortfolioCapacityView['constraint'] {
  const over = disciplines
    .filter((row) => row.loadPercent > 100)
    .sort((a, b) => b.loadPercent - a.loadPercent)[0];
  if (!over) return null;
  const people = new Set(
    members.filter((m) => m.department === over.discipline).map((m) => m.userId),
  );
  const internalDatesThisWeek = weekWork.filter(
    (row) =>
      people.has(row.ownerUserId) &&
      row.audience === 'internal' &&
      !clientProjectIds.has(row.projectId),
  ).length;
  return { discipline: over.discipline, loadPercent: over.loadPercent, internalDatesThisWeek };
}

export class ProjectPortfolioCapacityService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly capacity: PortfolioCapacityRepository = new PortfolioCapacityRepository(),
    private readonly planning: ProjectPortfolioPlanningRepository = new ProjectPortfolioPlanningRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async view(
    context: TenantContext,
    principal: Principal,
    query: { readonly week?: string } = {},
  ): Promise<PortfolioCapacityView> {
    const weekStart = parseWeek(query.week, this.now());
    if (!this.mayReadOrg(principal, context)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
    const startAt = new Date(`${weekStart}T00:00:00.000Z`);
    const endAt = new Date(startAt.getTime() + 7 * DAY_MS);
    const weekEnd = new Date(endAt.getTime() - DAY_MS).toISOString().slice(0, 10);

    return this.database.read(context, async (runner) => {
      const rows = await this.projects.list(runner, context, { limit: 200 });
      const projectIds = rows.filter((row) => mayReadProject(principal, row)).map((row) => row.id);
      const members = await this.capacity.members(runner, context);
      const allocations = await this.capacity.allocations(runner, context, weekStart, weekEnd);
      const unstaffed = await this.capacity.unstaffed(runner, context, projectIds);
      const weekWork = await this.capacity.weekWork(runner, context, projectIds, startAt, endAt);
      const clients = await this.planning.clients(runner, context, projectIds);

      const disciplines = foldDisciplines(members, allocations, weekEnd);
      return {
        weekStart,
        disciplines,
        unstaffed: {
          total: unstaffed.total,
          items: unstaffed.items.map((row) => ({
            workItemId: row.workItemId,
            title: row.title,
            projectId: row.projectId,
            projectName: row.projectName,
            dueOn: row.dueAt ? row.dueAt.toISOString().slice(0, 10) : null,
          })),
        },
        constraint: findConstraint(
          disciplines,
          members,
          weekWork,
          new Set(clients.map((row) => row.projectId)),
        ),
      };
    });
  }

  private mayReadOrg(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}
