import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, workItemChecklistItems } from '../../common/database/schema.js';
import type { WorkItemChecklistItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Work item checklist items — x145's storage half (Work module 7).
 *
 * Follows `WorkItemsRepository`: `TenantContext` is the scoping parameter, no `organizationId`
 * on any input type (it comes from the context), and every read and write is bound to
 * `(organization_id, …)` so a caller in the wrong tenant sees nothing rather than a leak. The
 * repository holds no policy — the service decides who may read or write, and the composite
 * foreign key of migration 0051 is what makes a cross-tenant `work_item_id` a non-existent pair.
 */

/** The largest checklist page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_CHECKLIST_PAGE = 500;

export interface CreateChecklistItemInput {
  readonly workItemId: string;
  readonly label: string;
  /** Work area D3 (0414): who does the step, and the day it is due. */
  readonly assigneeMembershipId?: string | null;
  readonly dueOn?: string | null;
}

export interface UpdateChecklistItemInput {
  readonly label?: string;
  readonly done?: boolean;
  readonly assigneeMembershipId?: string | null;
  readonly dueOn?: string | null;
}

/** A step as read: the row plus the user its assignee membership names (`null` = nobody). */
export type ChecklistItemWithAssignee = WorkItemChecklistItemRow & {
  readonly assigneeUserId?: string | null;
};

/** Done and total steps of one work (the portal's "2/5"). */
export interface StepCounts {
  readonly done: number;
  readonly total: number;
}

export class WorkChecklistRepository {
  /** One checklist item, scoped to the tenant and its parent work item; `null` if absent. */
  async findItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    itemId: string,
  ): Promise<ChecklistItemWithAssignee | null> {
    const rows = await this.selectWithAssignee(runner)
      .where(
        and(
          eq(workItemChecklistItems.organizationId, context.organizationId),
          eq(workItemChecklistItems.workItemId, workItemId),
          eq(workItemChecklistItems.id, itemId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The work item's checklist, position ascending then id, bounded to one page. */
  async listForWorkItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    limit: number = MAX_CHECKLIST_PAGE,
  ): Promise<readonly ChecklistItemWithAssignee[]> {
    return this.selectWithAssignee(runner)
      .where(
        and(
          eq(workItemChecklistItems.organizationId, context.organizationId),
          eq(workItemChecklistItems.workItemId, workItemId),
        ),
      )
      .orderBy(asc(workItemChecklistItems.position), asc(workItemChecklistItems.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_CHECKLIST_PAGE));
  }

  /**
   * Append a checklist item. `position` is one past the current highest for this work item, so a
   * new item lands at the end of the list; reorder persistence beyond this is NS-13.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateChecklistItemInput,
  ): Promise<ChecklistItemWithAssignee> {
    const id = uuidv7();

    const [aggregate] = await tenantDrizzle(runner)
      .select({ maxPosition: sql<number | null>`max(${workItemChecklistItems.position})` })
      .from(workItemChecklistItems)
      .where(
        and(
          eq(workItemChecklistItems.organizationId, context.organizationId),
          eq(workItemChecklistItems.workItemId, input.workItemId),
        ),
      );
    const nextPosition =
      aggregate?.maxPosition === null || aggregate?.maxPosition === undefined
        ? 0
        : Number(aggregate.maxPosition) + 1;

    await tenantDrizzle(runner)
      .insert(workItemChecklistItems)
      .values({
        id,
        organizationId: context.organizationId,
        workItemId: input.workItemId,
        label: input.label,
        done: false,
        position: nextPosition,
        createdAt: sql`current_timestamp(3)`,
        assigneeMembershipId: input.assigneeMembershipId ?? null,
        dueOn: input.dueOn ?? null,
      });

    // Read back rather than reconstruct: the row now carries the server-generated timestamp.
    const created = await this.findItem(runner, context, input.workItemId, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('checklist item vanished immediately after insert');
    }
    return created;
  }

  /**
   * Toggle `done` and/or rename `label` in place. Identity (`organization_id`, `work_item_id`)
   * is never written — the 0051 trigger refuses it — and an empty patch is a no-op that still
   * reads the row back so the caller gets the current state.
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    itemId: string,
    input: UpdateChecklistItemInput,
  ): Promise<ChecklistItemWithAssignee | null> {
    const changes: Partial<{
      label: string;
      done: boolean;
      assigneeMembershipId: string | null;
      dueOn: string | null;
    }> = {};
    if (input.label !== undefined) changes.label = input.label;
    if (input.done !== undefined) changes.done = input.done;
    if (input.assigneeMembershipId !== undefined) {
      changes.assigneeMembershipId = input.assigneeMembershipId;
    }
    if (input.dueOn !== undefined) changes.dueOn = input.dueOn;

    if (Object.keys(changes).length > 0) {
      await tenantDrizzle(runner)
        .update(workItemChecklistItems)
        .set(changes)
        .where(
          and(
            eq(workItemChecklistItems.organizationId, context.organizationId),
            eq(workItemChecklistItems.workItemId, workItemId),
            eq(workItemChecklistItems.id, itemId),
          ),
        );
    }

    return this.findItem(runner, context, workItemId, itemId);
  }

  /** Work area D3: delete one step of one work. Returns whether a row went. */
  async delete(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    itemId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(workItemChecklistItems)
      .where(
        and(
          eq(workItemChecklistItems.organizationId, context.organizationId),
          eq(workItemChecklistItems.workItemId, workItemId),
          eq(workItemChecklistItems.id, itemId),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /** Work area D3: the steps' new order, `itemIds[0]` first (the service checks the list). */
  async setPositions(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    itemIds: readonly string[],
  ): Promise<void> {
    for (const [index, itemId] of itemIds.entries()) {
      await tenantDrizzle(runner)
        .update(workItemChecklistItems)
        .set({ position: index })
        .where(
          and(
            eq(workItemChecklistItems.organizationId, context.organizationId),
            eq(workItemChecklistItems.workItemId, workItemId),
            eq(workItemChecklistItems.id, itemId),
          ),
        );
    }
  }

  /** Work area D5: done and total steps per work, in one grouped read. Absent = no steps. */
  async countsFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemIds: readonly string[],
  ): Promise<ReadonlyMap<string, StepCounts>> {
    if (workItemIds.length === 0) return new Map();
    const c = workItemChecklistItems;
    const rows = await tenantDrizzle(runner)
      .select({
        workItemId: c.workItemId,
        total: sql<number>`count(*)`,
        done: sql<number>`sum(case when ${c.done} then 1 else 0 end)`,
      })
      .from(c)
      .where(
        and(eq(c.organizationId, context.organizationId), inArray(c.workItemId, [...workItemIds])),
      )
      .groupBy(c.workItemId);
    return new Map(
      rows.map((row) => [
        row.workItemId,
        { done: Number(row.done ?? 0), total: Number(row.total) },
      ]),
    );
  }

  /** Every step read names its assignee's user, through the tenant's own membership row. */
  private selectWithAssignee(runner: TenantQueryRunner) {
    return tenantDrizzle(runner)
      .select({ ...getTableColumns(workItemChecklistItems), assigneeUserId: memberships.userId })
      .from(workItemChecklistItems)
      .leftJoin(
        memberships,
        and(
          eq(memberships.organizationId, workItemChecklistItems.organizationId),
          eq(memberships.id, workItemChecklistItems.assigneeMembershipId),
        ),
      )
      .$dynamic();
  }
}
