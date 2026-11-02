import { and, asc, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { FINISHED_WORK_ITEM_STATES, uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { iterations, projectPlanning, workItemPlanning } from '../../common/database/schema.js';
import type { IterationRow, WorkItemPlanningRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 53-21 — iterations storage. `TenantContext` scopes every statement (`organization_id = ?` from
 * the context, never from input); no policy here — the service decides who may read and write. The
 * three `work_items` planning columns and `projects.points_enabled` are reached through the narrow
 * mirrors in `schema.ts`, so `WorkItemRow` keeps its shape.
 */

export interface NewIteration {
  readonly projectId: string;
  readonly name: string;
  readonly goal: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface IterationChanges {
  readonly name: string;
  readonly goal: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface IterationTotals {
  readonly itemCount: number;
  readonly committedPoints: number;
  readonly donePoints: number;
}

/** The most items one iteration read returns (the burndown counts the same set). */
export const MAX_ITERATION_ITEMS_READ = 5000;

export class IterationsRepository {
  /** `null` when the project is not in this tenant; otherwise its points switch. */
  async projectPoints(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<{ readonly pointsEnabled: boolean } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ pointsEnabled: projectPlanning.pointsEnabled })
      .from(projectPlanning)
      .where(
        and(
          eq(projectPlanning.organizationId, context.organizationId),
          eq(projectPlanning.id, projectId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? { pointsEnabled: Boolean(row.pointsEnabled) } : null;
  }

  async setPointsEnabled(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    enabled: boolean,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(projectPlanning)
      .set({ pointsEnabled: enabled })
      .where(
        and(
          eq(projectPlanning.organizationId, context.organizationId),
          eq(projectPlanning.id, projectId),
        ),
      );
  }

  async listForProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    limit: number,
  ): Promise<readonly IterationRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(iterations)
      .where(
        and(
          eq(iterations.organizationId, context.organizationId),
          eq(iterations.projectId, projectId),
        ),
      )
      .orderBy(asc(iterations.startsOn), asc(iterations.id))
      .limit(limit);
  }

  async countForProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: count() })
      .from(iterations)
      .where(
        and(
          eq(iterations.organizationId, context.organizationId),
          eq(iterations.projectId, projectId),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    iterationId: string,
  ): Promise<IterationRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(iterations)
      .where(
        and(eq(iterations.organizationId, context.organizationId), eq(iterations.id, iterationId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: NewIteration,
    at: Date,
  ): Promise<string> {
    const id = uuidv7();
    await tenantDrizzle(runner).insert(iterations).values({
      id,
      organizationId: context.organizationId,
      projectId: input.projectId,
      name: input.name,
      goal: input.goal,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      status: 'planned',
      createdBy: context.userId,
      createdAt: at,
      updatedAt: at,
      version: 1,
    });
    return id;
  }

  /** Version-checked edit of an uncompleted iteration; returns rows changed (0 = stale/completed). */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    iterationId: string,
    expectedVersion: number,
    changes: IterationChanges,
    at: Date,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(iterations)
      .set({ ...changes, updatedAt: at, version: sql`version + 1` })
      .where(
        and(
          eq(iterations.organizationId, context.organizationId),
          eq(iterations.id, iterationId),
          eq(iterations.version, expectedVersion),
          ne(iterations.status, 'completed'),
        ),
      );
    return result[0].affectedRows;
  }

  /**
   * Claim the completion: flips status to completed only if it is not already. 0 rows = someone
   * (or an earlier call) completed it first. The row lock this takes serializes concurrent calls.
   */
  async claimCompletion(
    runner: TenantQueryRunner,
    context: TenantContext,
    iterationId: string,
    at: Date,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(iterations)
      .set({ status: 'completed', completedAt: at, updatedAt: at, version: sql`version + 1` })
      .where(
        and(
          eq(iterations.organizationId, context.organizationId),
          eq(iterations.id, iterationId),
          ne(iterations.status, 'completed'),
        ),
      );
    return result[0].affectedRows;
  }

  async recordCompletionCounts(
    runner: TenantQueryRunner,
    context: TenantContext,
    iterationId: string,
    moved: number,
    left: number,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(iterations)
      .set({ movedCount: moved, leftCount: left })
      .where(
        and(eq(iterations.organizationId, context.organizationId), eq(iterations.id, iterationId)),
      );
  }

  /**
   * Item totals per iteration (live items of the iteration's project: an item moved to another
   * project drops out of its old iteration here, without a write on the move).
   */
  async totals(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    iterationIds: readonly string[],
  ): Promise<ReadonlyMap<string, IterationTotals>> {
    if (iterationIds.length === 0) return new Map();
    const finished = sql.join(
      FINISHED_WORK_ITEM_STATES.map((s) => sql`${s}`),
      sql`, `,
    );
    const rows = await tenantDrizzle(runner)
      .select({
        iterationId: workItemPlanning.iterationId,
        itemCount: count(),
        committed: sql<string | null>`sum(coalesce(${workItemPlanning.points}, 0))`,
        done: sql<
          string | null
        >`sum(case when ${workItemPlanning.state} in (${finished}) then coalesce(${workItemPlanning.points}, 0) else 0 end)`,
      })
      .from(workItemPlanning)
      .where(
        and(
          eq(workItemPlanning.organizationId, context.organizationId),
          eq(workItemPlanning.projectId, projectId),
          inArray(workItemPlanning.iterationId, [...iterationIds]),
          isNull(workItemPlanning.deletedAt),
        ),
      )
      .groupBy(workItemPlanning.iterationId);
    const out = new Map<string, IterationTotals>();
    for (const row of rows) {
      if (row.iterationId === null) continue;
      out.set(row.iterationId, {
        itemCount: Number(row.itemCount),
        committedPoints: Number(row.committed ?? 0),
        donePoints: Number(row.done ?? 0),
      });
    }
    return out;
  }

  /** The live items of an iteration in its project (≤ {@link MAX_ITERATION_ITEMS_READ}). */
  async itemsOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    iterationId: string,
  ): Promise<readonly WorkItemPlanningRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemPlanning)
      .where(
        and(
          eq(workItemPlanning.organizationId, context.organizationId),
          eq(workItemPlanning.projectId, projectId),
          eq(workItemPlanning.iterationId, iterationId),
          isNull(workItemPlanning.deletedAt),
        ),
      )
      .orderBy(asc(workItemPlanning.id))
      .limit(MAX_ITERATION_ITEMS_READ);
  }

  /** The named live items, tenant-scoped; ids from another tenant simply do not resolve. */
  async findItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    ids: readonly string[],
  ): Promise<readonly WorkItemPlanningRow[]> {
    if (ids.length === 0) return [];
    return tenantDrizzle(runner)
      .select()
      .from(workItemPlanning)
      .where(
        and(
          eq(workItemPlanning.organizationId, context.organizationId),
          inArray(workItemPlanning.id, [...ids]),
          isNull(workItemPlanning.deletedAt),
        ),
      );
  }

  /** Put items into an iteration (stamping when they joined) or back in the backlog (`null`). */
  async assignItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    ids: readonly string[],
    iterationId: string | null,
    at: Date,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await tenantDrizzle(runner)
      .update(workItemPlanning)
      .set({ iterationId, iterationAssignedAt: iterationId === null ? null : at })
      .where(
        and(
          eq(workItemPlanning.organizationId, context.organizationId),
          inArray(workItemPlanning.id, [...ids]),
        ),
      );
    return result[0].affectedRows;
  }

  async setPoints(
    runner: TenantQueryRunner,
    context: TenantContext,
    itemId: string,
    points: number | null,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(workItemPlanning)
      .set({ points })
      .where(
        and(
          eq(workItemPlanning.organizationId, context.organizationId),
          eq(workItemPlanning.id, itemId),
        ),
      );
  }

  /** One item's planning columns (iteration and points), tenant-scoped. */
  async findItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    itemId: string,
  ): Promise<WorkItemPlanningRow | null> {
    const rows = await this.findItems(runner, context, [itemId]);
    return rows[0] ?? null;
  }
}
