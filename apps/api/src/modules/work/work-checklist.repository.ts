import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItemChecklistItems } from '../../common/database/schema.js';
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
}

export interface UpdateChecklistItemInput {
  readonly label?: string;
  readonly done?: boolean;
}

export class WorkChecklistRepository {
  /** One checklist item, scoped to the tenant and its parent work item; `null` if absent. */
  async findItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    itemId: string,
  ): Promise<WorkItemChecklistItemRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemChecklistItems)
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
  ): Promise<readonly WorkItemChecklistItemRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemChecklistItems)
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
  ): Promise<WorkItemChecklistItemRow> {
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
  ): Promise<WorkItemChecklistItemRow | null> {
    const changes: Partial<{ label: string; done: boolean }> = {};
    if (input.label !== undefined) changes.label = input.label;
    if (input.done !== undefined) changes.done = input.done;

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
}
