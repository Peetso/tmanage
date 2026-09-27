import { and, count, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  projectMilestones,
  projectObjectives,
  projectRisks,
} from '../../common/database/schema.js';
import type { ProjectObjectiveStatus } from './project-objectives.repository.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project-health repository — PROJ / module 8 (x208). Read-only signal aggregates for a set of
 * projects the caller has already been resolved as able to see.
 *
 * It adds no table of its own: it reads `project_milestones` (x139, 0048), `project_risks` (x140,
 * 0049) and `project_objectives` (x124), aggregated by project, and returns per-project signal
 * counts. `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured the same way the sibling
 * `portfolio.repository.ts` honours it:
 *
 * 1. **No unscoped read.** Every method takes the `TenantQueryRunner` and the `TenantContext` first;
 *    there is no overload without a context.
 * 2. **The tenant predicate is on every statement** (`organization_id = context.organizationId`).
 * 3. **The project set is an explicit allowlist.** Every aggregate takes the `projectIds` the service
 *    resolved as visible and filters to exactly those with `IN (...)`, so a project the caller may not
 *    see contributes nothing and the aggregate cannot widen the relation check the service made. An
 *    empty allowlist short-circuits to no rows rather than to every row.
 */

/** One project's milestone signal: how many planned milestones are past their day. */
export interface ProjectMilestoneSignalRow {
  readonly projectId: string;
  /** Milestones whose status is still `planned` and whose `due_on` is strictly before `today`. */
  readonly overdueMilestones: number;
}

/** One project's risk signal: how many risks are open, and how many of those are high-severity. */
export interface ProjectRiskSignalRow {
  readonly projectId: string;
  /** Risks whose status is `open` (neither `mitigated` nor `closed`). */
  readonly openRisks: number;
  /** The subset of open risks whose severity is `high`. Never exceeds {@link openRisks}. */
  readonly highRisks: number;
}

/** One project/status pair's objective tally, reused from the x124 lifecycle statuses. */
export interface ProjectObjectiveSignalRow {
  readonly projectId: string;
  readonly status: ProjectObjectiveStatus;
  readonly count: number;
}

export class ProjectHealthRepository {
  /**
   * Per-project overdue-milestone counts over the given projects, within the acting tenant.
   *
   * `today` is a `YYYY-MM-DD` calendar day supplied by the service (never the database clock — the
   * admin pool's `current_timestamp` is `SYSTEM`, not the tenant's intent). `due_on` is a `DATE`
   * stored as a `YYYY-MM-DD` string, so a lexicographic `<` is the calendar order. A milestone with
   * no `due_on` has no deadline and is never overdue. Projects with no overdue milestones are absent;
   * the service reads an absence as zero.
   */
  async milestoneSignals(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
    today: string,
  ): Promise<readonly ProjectMilestoneSignalRow[]> {
    if (projectIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({
        projectId: projectMilestones.projectId,
        overdueMilestones: count(),
      })
      .from(projectMilestones)
      .where(
        and(
          eq(projectMilestones.organizationId, context.organizationId),
          inArray(projectMilestones.projectId, [...projectIds]),
          eq(projectMilestones.status, 'planned'),
          isNotNull(projectMilestones.dueOn),
          lt(projectMilestones.dueOn, today),
        ),
      )
      .groupBy(projectMilestones.projectId);

    return rows.map((row) => ({
      projectId: row.projectId,
      overdueMilestones: Number(row.overdueMilestones),
    }));
  }

  /**
   * Per-project open-risk counts over the given projects, within the acting tenant.
   *
   * One grouped pass over `project_risks`: the open count is a conditional sum over `status = 'open'`,
   * and the high count is the same restricted to `severity = 'high'`, so `highRisks <= openRisks`
   * always. Projects with no open risks are absent; the service reads an absence as zero.
   */
  async riskSignals(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly ProjectRiskSignalRow[]> {
    if (projectIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({
        projectId: projectRisks.projectId,
        openRisks:
          sql<number>`sum(case when ${projectRisks.status} = 'open' then 1 else 0 end)`.mapWith(
            Number,
          ),
        highRisks:
          sql<number>`sum(case when ${projectRisks.status} = 'open' and ${projectRisks.severity} = 'high' then 1 else 0 end)`.mapWith(
            Number,
          ),
      })
      .from(projectRisks)
      .where(
        and(
          eq(projectRisks.organizationId, context.organizationId),
          inArray(projectRisks.projectId, [...projectIds]),
        ),
      )
      .groupBy(projectRisks.projectId);

    return rows.map((row) => ({
      projectId: row.projectId,
      openRisks: Number(row.openRisks ?? 0),
      highRisks: Number(row.highRisks ?? 0),
    }));
  }

  /**
   * Per-project objective tallies by status over the given projects, within the acting tenant.
   *
   * Grouped by `(project_id, status)`; a pair with no objectives is absent, which the service reads
   * as zero. Mirrors `portfolio.repository.ts`'s tally so the two roll-ups count objectives the same
   * way.
   */
  async objectiveSignals(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly ProjectObjectiveSignalRow[]> {
    if (projectIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({
        projectId: projectObjectives.projectId,
        status: projectObjectives.status,
        count: count(),
      })
      .from(projectObjectives)
      .where(
        and(
          eq(projectObjectives.organizationId, context.organizationId),
          inArray(projectObjectives.projectId, [...projectIds]),
        ),
      )
      .groupBy(projectObjectives.projectId, projectObjectives.status);

    return rows.map((row) => ({
      projectId: row.projectId,
      status: row.status as ProjectObjectiveStatus,
      count: Number(row.count),
    }));
  }
}
