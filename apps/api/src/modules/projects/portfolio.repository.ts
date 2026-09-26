import { and, count, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectObjectives, workItems } from '../../common/database/schema.js';
import type { ProjectObjectiveStatus } from './project-objectives.repository.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project-portfolio repository — PROJ / module 8 (x137). Read-only roll-up aggregates for a
 * page of projects the caller can already see.
 *
 * It adds no table of its own: it reads `work_items` and `project_objectives` (x124), aggregated by
 * project, and returns per-project counts. `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is
 * honoured the same way the sibling repositories honour it:
 *
 * 1. **No unscoped read.** Every method's first two parameters are the `TenantQueryRunner` and the
 *    `TenantContext`; there is no overload without a context.
 * 2. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 * 3. **The project set is an explicit allowlist.** Both aggregates take the `projectIds` the service
 *    has already resolved as visible to the caller and filter to exactly those with `IN (...)`, so a
 *    project the caller may not see contributes nothing — the aggregate cannot widen the relation
 *    check the service made. An empty allowlist short-circuits to no rows rather than to every row.
 */

/** One project's work roll-up: how much is open, and when work last moved. */
export interface ProjectWorkSummaryRow {
  readonly projectId: string;
  /** Non-deleted items whose state is neither `done` nor `archived`. */
  readonly openWorkCount: number;
  /** The latest `updated_at` across the project's non-deleted work items, or `null` for none. */
  readonly latestActivityAt: Date | null;
}

/** One project/status pair's objective tally. */
export interface ProjectObjectiveCountRow {
  readonly projectId: string;
  readonly status: ProjectObjectiveStatus;
  readonly count: number;
}

/** States that mean a work item is no longer open. Mirrors `workItemStateMachine`'s terminal set. */
const CLOSED_STATES = ['done', 'archived'] as const;

export class ProjectPortfolioRepository {
  /**
   * Per-project work roll-up over the given projects, within the acting tenant.
   *
   * One grouped pass over non-deleted work items: the open count is a conditional sum (an item is
   * open unless it is `done` or `archived`), and the latest activity is `max(updated_at)`. Projects
   * with no work items are simply absent from the result — the service reads an absence as zero, so a
   * project with nothing in it still appears in the portfolio with a zero count.
   */
  async workSummaries(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly ProjectWorkSummaryRow[]> {
    if (projectIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({
        projectId: workItems.projectId,
        openWorkCount:
          sql<number>`sum(case when ${workItems.state} not in ('done', 'archived') then 1 else 0 end)`.mapWith(
            Number,
          ),
        latestActivityAt: max(workItems.updatedAt),
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          inArray(workItems.projectId, [...projectIds]),
          isNull(workItems.deletedAt),
        ),
      )
      .groupBy(workItems.projectId);

    return rows.map((row) => ({
      projectId: row.projectId,
      openWorkCount: Number(row.openWorkCount ?? 0),
      latestActivityAt: row.latestActivityAt ?? null,
    }));
  }

  /**
   * Per-project objective tallies by status over the given projects, within the acting tenant.
   *
   * Grouped by `(project_id, status)`; a project/status pair with no objectives is absent, which the
   * service reads as zero. The `CLOSED_STATES` set is referenced by {@link workSummaries}; kept in
   * this file so the two aggregates read the same definition of "open".
   */
  async objectiveCounts(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly ProjectObjectiveCountRow[]> {
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

/** Exported only so a reader can see the "open" definition without opening the query. */
export { CLOSED_STATES };
