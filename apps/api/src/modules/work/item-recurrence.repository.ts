import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItemRecurrence } from '../../common/database/schema.js';
import type { WorkItemRecurrenceRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Work item recurrence — x257's storage half (Work module 7).
 *
 * One rule per work item (see `0127_work_item_recurrence.sql`), bound to `(organization_id,
 * work_item_id)` by the composite foreign key so a cross-tenant `work_item_id` is a non-existent
 * pair. The repository holds no policy — the service decides who may read or write, resolving the
 * parent work item tenant-scoped before it authorizes; every read and write here is already scoped
 * to `(organization_id, …)`, so a caller in the wrong tenant sees nothing rather than a leak.
 */

export interface UpsertRecurrenceInput {
  readonly freq: string;
  readonly intervalCount: number;
  readonly untilAt: Date | null;
}

export class WorkItemRecurrenceRepository {
  /** The recurrence rule for one work item of this tenant; `null` if the item does not recur. */
  async findByItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<WorkItemRecurrenceRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemRecurrence)
      .where(
        and(
          eq(workItemRecurrence.organizationId, context.organizationId),
          eq(workItemRecurrence.workItemId, workItemId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Set the rule for a work item, upserting the single row: the first PUT inserts it, a later PUT
   * rewrites `freq`/`interval_count`/`until_at` in place (the `uq_work_item_recurrence_item` key
   * holds one-rule-per-item). Returns the stored row.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    input: UpsertRecurrenceInput,
  ): Promise<WorkItemRecurrenceRow> {
    const existing = await this.findByItem(runner, context, workItemId);
    if (existing) {
      await tenantDrizzle(runner)
        .update(workItemRecurrence)
        .set({
          freq: input.freq,
          intervalCount: input.intervalCount,
          untilAt: input.untilAt,
          updatedAt: sql`current_timestamp(3)`,
        })
        .where(
          and(
            eq(workItemRecurrence.organizationId, context.organizationId),
            eq(workItemRecurrence.workItemId, workItemId),
          ),
        );
    } else {
      await tenantDrizzle(runner)
        .insert(workItemRecurrence)
        .values({
          id: uuidv7(),
          organizationId: context.organizationId,
          workItemId,
          freq: input.freq,
          intervalCount: input.intervalCount,
          untilAt: input.untilAt,
          createdAt: sql`current_timestamp(3)`,
          updatedAt: sql`current_timestamp(3)`,
        });
    }

    const stored = await this.findByItem(runner, context, workItemId);
    if (!stored) {
      // Unreachable: the upsert above committed this row in this transaction.
      throw new Error('recurrence rule vanished immediately after upsert');
    }
    return stored;
  }

  /** Clear the rule for a work item. `true` if a row was removed. */
  async deleteByItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<boolean> {
    const existing = await this.findByItem(runner, context, workItemId);
    if (!existing) return false;
    await tenantDrizzle(runner)
      .delete(workItemRecurrence)
      .where(
        and(
          eq(workItemRecurrence.organizationId, context.organizationId),
          eq(workItemRecurrence.workItemId, workItemId),
        ),
      );
    return true;
  }
}
