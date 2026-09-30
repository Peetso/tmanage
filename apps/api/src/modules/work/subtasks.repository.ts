import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItemSubtasks } from '../../common/database/schema.js';
import type { WorkItemSubtaskRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Work item subtasks — x307's storage half (Work module).
 *
 * Follows `WorkChecklistRepository`: `TenantContext` is the scoping parameter, no `organizationId`
 * on any input type (it comes from the context), and every read and write is bound to
 * `(organization_id, …)` so a caller in the wrong tenant sees nothing rather than a leak. The
 * repository holds no policy — the service decides who may read or write, and the composite foreign
 * key of migration 0175 is what makes a cross-tenant `parent_work_item_id` a non-existent pair.
 */

/** The largest subtask page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_SUBTASK_PAGE = 500;

export interface CreateSubtaskInput {
  readonly parentWorkItemId: string;
  readonly title: string;
  readonly createdBy: string;
}

export interface UpdateSubtaskInput {
  readonly title?: string;
  readonly isDone?: boolean;
  readonly position?: number;
}

export class WorkSubtasksRepository {
  /** One subtask, scoped to the tenant and its parent work item; `null` if absent. */
  async findSubtask(
    runner: TenantQueryRunner,
    context: TenantContext,
    parentWorkItemId: string,
    subtaskId: string,
  ): Promise<WorkItemSubtaskRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemSubtasks)
      .where(
        and(
          eq(workItemSubtasks.organizationId, context.organizationId),
          eq(workItemSubtasks.parentWorkItemId, parentWorkItemId),
          eq(workItemSubtasks.id, subtaskId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The work item's subtasks, position ascending then id, bounded to one page. */
  async listForWorkItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    parentWorkItemId: string,
    limit: number = MAX_SUBTASK_PAGE,
  ): Promise<readonly WorkItemSubtaskRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemSubtasks)
      .where(
        and(
          eq(workItemSubtasks.organizationId, context.organizationId),
          eq(workItemSubtasks.parentWorkItemId, parentWorkItemId),
        ),
      )
      .orderBy(asc(workItemSubtasks.position), asc(workItemSubtasks.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_SUBTASK_PAGE));
  }

  /**
   * Append a subtask. `position` is one past the current highest for this work item, so a new
   * subtask lands at the end of the list.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateSubtaskInput,
  ): Promise<WorkItemSubtaskRow> {
    const id = uuidv7();

    const [aggregate] = await tenantDrizzle(runner)
      .select({ maxPosition: sql<number | null>`max(${workItemSubtasks.position})` })
      .from(workItemSubtasks)
      .where(
        and(
          eq(workItemSubtasks.organizationId, context.organizationId),
          eq(workItemSubtasks.parentWorkItemId, input.parentWorkItemId),
        ),
      );
    const nextPosition =
      aggregate?.maxPosition === null || aggregate?.maxPosition === undefined
        ? 0
        : Number(aggregate.maxPosition) + 1;

    await tenantDrizzle(runner)
      .insert(workItemSubtasks)
      .values({
        id,
        organizationId: context.organizationId,
        parentWorkItemId: input.parentWorkItemId,
        title: input.title,
        isDone: false,
        position: nextPosition,
        createdBy: input.createdBy,
        createdAt: sql`current_timestamp(3)`,
      });

    // Read back rather than reconstruct: the row now carries the server-generated timestamp.
    const created = await this.findSubtask(runner, context, input.parentWorkItemId, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('subtask vanished immediately after insert');
    }
    return created;
  }

  /**
   * Move `title`, `is_done` and/or `position` in place. Identity (`organization_id`,
   * `parent_work_item_id`) is never written — the 0175 trigger refuses it — and an empty patch is a
   * no-op that still reads the row back so the caller gets the current state (idempotent PUT).
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    parentWorkItemId: string,
    subtaskId: string,
    input: UpdateSubtaskInput,
  ): Promise<WorkItemSubtaskRow | null> {
    const changes: Partial<{ title: string; isDone: boolean; position: number }> = {};
    if (input.title !== undefined) changes.title = input.title;
    if (input.isDone !== undefined) changes.isDone = input.isDone;
    if (input.position !== undefined) changes.position = input.position;

    if (Object.keys(changes).length > 0) {
      await tenantDrizzle(runner)
        .update(workItemSubtasks)
        .set(changes)
        .where(
          and(
            eq(workItemSubtasks.organizationId, context.organizationId),
            eq(workItemSubtasks.parentWorkItemId, parentWorkItemId),
            eq(workItemSubtasks.id, subtaskId),
          ),
        );
    }

    return this.findSubtask(runner, context, parentWorkItemId, subtaskId);
  }

  /** Remove a subtask, scoped to the tenant and its parent work item. */
  async deleteSubtask(
    runner: TenantQueryRunner,
    context: TenantContext,
    parentWorkItemId: string,
    subtaskId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(workItemSubtasks)
      .where(
        and(
          eq(workItemSubtasks.organizationId, context.organizationId),
          eq(workItemSubtasks.parentWorkItemId, parentWorkItemId),
          eq(workItemSubtasks.id, subtaskId),
        ),
      );
  }
}
