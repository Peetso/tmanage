import { and, asc, count, eq, inArray, isNull, max, min, sql } from 'drizzle-orm';
import { PENDING_APPROVAL_STATES } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  approvals,
  clientOrganizations,
  memberships,
  projectClients,
  projectMilestones,
  projectObjectives,
  users,
  workItems,
} from '../../common/database/schema.js';
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

/** One milestone of a visible project, for the commitment and the timeline (POR-01 / POR-02). */
export interface PortfolioMilestoneRow {
  readonly projectId: string;
  readonly title: string;
  /** `'YYYY-MM-DD'`, or `null` for an undated milestone. */
  readonly dueOn: string | null;
  readonly status: 'planned' | 'met' | 'missed';
  /** Published to the client portal — a client-facing date. */
  readonly published: boolean;
}

/** The client organization a project is shared with (the first by name when several). */
export interface PortfolioClientRow {
  readonly projectId: string;
  readonly clientName: string;
}

/** The oldest approval still waiting on a reviewer, per project. */
export interface PortfolioClientWaitRow {
  readonly projectId: string;
  readonly waitingSince: Date;
}

/** A member's display name, resolved through a membership of the acting tenant. */
export interface PortfolioPersonRow {
  readonly userId: string;
  readonly displayName: string;
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

/**
 * POR-01 / POR-02 aggregates. Each takes the same visible-project allowlist as the two above and
 * short-circuits on an empty list; every join carries the `organization_id` equality, so the guard
 * sees the tenant predicate reach every tenant table in the statement.
 */
export class ProjectPortfolioPlanningRepository {
  /** Every milestone of the given projects, in due order (undated last). */
  async milestones(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly PortfolioMilestoneRow[]> {
    if (projectIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({
        projectId: projectMilestones.projectId,
        title: projectMilestones.title,
        dueOn: projectMilestones.dueOn,
        status: projectMilestones.status,
        published: projectMilestones.published,
      })
      .from(projectMilestones)
      .where(
        and(
          eq(projectMilestones.organizationId, context.organizationId),
          inArray(projectMilestones.projectId, [...projectIds]),
        ),
      )
      .orderBy(
        sql`${projectMilestones.dueOn} is null`,
        asc(projectMilestones.dueOn),
        asc(projectMilestones.id),
      );
    return rows.map((row) => ({ ...row, published: Boolean(row.published) }));
  }

  /** The client organization each project is shared with; the first by name wins. */
  async clients(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly PortfolioClientRow[]> {
    if (projectIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({ projectId: projectClients.projectId, clientName: clientOrganizations.name })
      .from(projectClients)
      .innerJoin(
        clientOrganizations,
        and(
          eq(clientOrganizations.organizationId, projectClients.organizationId),
          eq(clientOrganizations.id, projectClients.clientOrganizationId),
        ),
      )
      .where(
        and(
          eq(projectClients.organizationId, context.organizationId),
          inArray(projectClients.projectId, [...projectIds]),
        ),
      )
      .orderBy(asc(projectClients.projectId), asc(clientOrganizations.name));
    const first = new Map<string, string>();
    for (const row of rows) if (!first.has(row.projectId)) first.set(row.projectId, row.clientName);
    return [...first].map(([projectId, clientName]) => ({ projectId, clientName }));
  }

  /** Per project, when its oldest still-pending approval was requested. */
  async clientWaits(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly PortfolioClientWaitRow[]> {
    if (projectIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({ projectId: approvals.projectId, waitingSince: min(approvals.createdAt) })
      .from(approvals)
      .where(
        and(
          eq(approvals.organizationId, context.organizationId),
          inArray(approvals.projectId, [...projectIds]),
          inArray(approvals.state, [...PENDING_APPROVAL_STATES]),
        ),
      )
      .groupBy(approvals.projectId);
    return rows.flatMap((row) =>
      row.waitingSince ? [{ projectId: row.projectId, waitingSince: row.waitingSince }] : [],
    );
  }

  /** Display names for the given users — only users who are members of the acting tenant. */
  async people(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<readonly PortfolioPersonRow[]> {
    if (userIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select({ userId: users.id, displayName: users.displayName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          inArray(memberships.userId, [...userIds]),
        ),
      );
  }
}

/** Exported only so a reader can see the "open" definition without opening the query. */
export { CLOSED_STATES };
