import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Audience } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  workItemDependencies,
  workItemScheduleStats,
  workItems,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 53-06's storage: the project's live items and active edges the critical path reads, and the
 * `work_item_schedule_stats` rows (0297) it writes. Every statement carries the tenant predicate
 * from the `TenantContext`; no input names an organization. No policy here — the service decides
 * who may read which row and names nothing the caller cannot read.
 */

export interface ScheduleItemDatesRow {
  readonly id: string;
  readonly startAt: Date | null;
  readonly dueAt: Date | null;
}

export interface ScheduleEdgeRow {
  readonly workItemId: string;
  readonly dependsOnWorkItemId: string;
  readonly kind: string;
  readonly lag: number;
}

export interface ScheduleStatsInsert {
  readonly workItemId: string;
  readonly earlyStart: string | null;
  readonly earlyFinish: string | null;
  readonly lateStart: string | null;
  readonly lateFinish: string | null;
  readonly totalFloatDays: number | null;
  readonly isCritical: boolean;
}

/** A stats row with what the service needs to authorize and name its item. */
export interface ScheduleStatsItemRow extends ScheduleStatsInsert {
  readonly organizationId: string;
  readonly projectId: string;
  readonly title: string;
  readonly audience: Audience;
  readonly state: string;
  readonly batchId: string;
  readonly computedAt: Date;
}

const INSERT_CHUNK = 500;

export class ScheduleStatsRepository {
  /** The project's live items with their dates, at most `limit` (the caller passes cap + 1). */
  async listProjectItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    limit: number,
  ): Promise<readonly ScheduleItemDatesRow[]> {
    return tenantDrizzle(runner)
      .select({ id: workItems.id, startAt: workItems.startAt, dueAt: workItems.dueAt })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.projectId, projectId),
          isNull(workItems.deletedAt),
        ),
      )
      .orderBy(asc(workItems.id))
      .limit(limit);
  }

  /** How many live items the project has (scheduled or not). */
  async countLiveItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<number> {
    const [row] = await tenantDrizzle(runner)
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.projectId, projectId),
          isNull(workItems.deletedAt),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /** Active edges whose dependent item is a live item of the project (the predecessor may not be). */
  async listProjectEdges(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly ScheduleEdgeRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        workItemId: workItemDependencies.workItemId,
        dependsOnWorkItemId: workItemDependencies.dependsOnWorkItemId,
        kind: workItemDependencies.kind,
        lag: workItemDependencies.lagWorkingDays,
      })
      .from(workItemDependencies)
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, workItemDependencies.organizationId),
          eq(workItems.id, workItemDependencies.workItemId),
        ),
      )
      .where(
        and(
          eq(workItemDependencies.organizationId, context.organizationId),
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.projectId, projectId),
          isNull(workItems.deletedAt),
          eq(workItemDependencies.status, 'active'),
        ),
      );
    return rows.map((row) => ({ ...row, lag: Number(row.lag) }));
  }

  /** Dates of live items by id (the predecessors outside the project). */
  async findItemDates(
    runner: TenantQueryRunner,
    context: TenantContext,
    ids: readonly string[],
  ): Promise<readonly ScheduleItemDatesRow[]> {
    if (ids.length === 0) return [];
    return tenantDrizzle(runner)
      .select({ id: workItems.id, startAt: workItems.startAt, dueAt: workItems.dueAt })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          inArray(workItems.id, [...ids]),
          isNull(workItems.deletedAt),
        ),
      );
  }

  /** The newest change to any of the project's items (an edit, or a soft delete), or null. */
  async latestItemChange(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<Date | null> {
    const [row] = await tenantDrizzle(runner)
      .select({
        updated: sql<Date | string | null>`max(${workItems.updatedAt})`,
        deleted: sql<Date | string | null>`max(${workItems.deletedAt})`,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.projectId, projectId),
        ),
      );
    const times = [row?.updated, row?.deleted]
      .filter((v): v is Date | string => v !== null && v !== undefined)
      .map((v) => (v instanceof Date ? v : new Date(`${String(v).replace(' ', 'T')}Z`)).getTime())
      .filter((t) => !Number.isNaN(t));
    return times.length === 0 ? null : new Date(Math.max(...times));
  }

  /** Replace the project's rows with one batch, inside the caller's transaction. */
  async replaceProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    batch: { readonly batchId: string; readonly computedAt: Date },
    rows: readonly ScheduleStatsInsert[],
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(workItemScheduleStats)
      .where(
        and(
          eq(workItemScheduleStats.organizationId, context.organizationId),
          eq(workItemScheduleStats.projectId, projectId),
        ),
      );
    for (let at = 0; at < rows.length; at += INSERT_CHUNK) {
      await db.insert(workItemScheduleStats).values(
        rows.slice(at, at + INSERT_CHUNK).map((row) => ({
          ...row,
          organizationId: context.organizationId,
          projectId,
          batchId: batch.batchId,
          computedAt: batch.computedAt,
        })),
      );
    }
  }

  /** The project's stats rows joined to their live items, early finish descending. */
  async listProjectStats(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly ScheduleStatsItemRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        workItemId: workItemScheduleStats.workItemId,
        earlyStart: workItemScheduleStats.earlyStart,
        earlyFinish: workItemScheduleStats.earlyFinish,
        lateStart: workItemScheduleStats.lateStart,
        lateFinish: workItemScheduleStats.lateFinish,
        totalFloatDays: workItemScheduleStats.totalFloatDays,
        isCritical: workItemScheduleStats.isCritical,
        batchId: workItemScheduleStats.batchId,
        computedAt: workItemScheduleStats.computedAt,
        organizationId: workItems.organizationId,
        projectId: workItems.projectId,
        title: workItems.title,
        audience: workItems.audience,
        state: workItems.state,
      })
      .from(workItemScheduleStats)
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, workItemScheduleStats.organizationId),
          eq(workItems.id, workItemScheduleStats.workItemId),
        ),
      )
      .where(
        and(
          eq(workItemScheduleStats.organizationId, context.organizationId),
          eq(workItems.organizationId, context.organizationId),
          eq(workItemScheduleStats.projectId, projectId),
          isNull(workItems.deletedAt),
        ),
      )
      .orderBy(desc(workItemScheduleStats.earlyFinish), asc(workItemScheduleStats.workItemId));
    return rows.map((row) => ({
      ...row,
      totalFloatDays: row.totalFloatDays === null ? null : Number(row.totalFloatDays),
      isCritical: Boolean(row.isCritical),
    }));
  }
}
