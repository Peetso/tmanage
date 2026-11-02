import { and, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItemRecurrence, workItemRecurrenceInstances } from '../../common/database/schema.js';
import type {
  WorkItemRecurrenceInstanceRow,
  WorkItemRecurrenceRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Work item recurrence — x257's storage half (Work module 7), extended by 53-09 (0300).
 *
 * One rule per work item (see `0127_work_item_recurrence.sql`), bound to `(organization_id,
 * work_item_id)` by the composite foreign key so a cross-tenant `work_item_id` is a non-existent
 * pair. The repository holds no policy — the service decides who may read or write, resolving the
 * parent work item tenant-scoped before it authorizes; every read and write here is already scoped
 * to `(organization_id, …)`, so a caller in the wrong tenant sees nothing rather than a leak.
 *
 * 53-09 adds the v2 rule columns and `work_item_recurrence_instances`: an occurrence is claimed by an
 * INSERT whose duplicate key (`uq_wiri_occurrence`) means "already dealt with" — {@link insertInstance}
 * answers `false` then, and that is the spawner's and the skip route's idempotency.
 */

export interface UpsertRecurrenceInput {
  readonly freq: string;
  readonly intervalCount: number;
  readonly untilAt: Date | null;
  /** 53-09 v2 columns. Absent on a legacy write that could not be mapped to the RRULE subset. */
  readonly v2?: RecurrenceV2Columns;
}

export interface RecurrenceV2Columns {
  readonly rrule: string;
  readonly startsOn: string;
  readonly byWeekday: string | null;
  readonly byMonthday: number | null;
  readonly bySetpos: number | null;
  readonly timeZone: string | null;
  readonly spawnMode: string;
  readonly spawnAheadDays: number;
  readonly holidayPolicy: string;
  readonly countLimit: number | null;
  readonly templateJson: Record<string, unknown>;
  readonly ownerUserId: string;
}

export interface InsertInstanceInput {
  readonly recurrenceId: string;
  readonly occurrenceKey: string;
  readonly status: 'created' | 'skipped';
  readonly workItemId?: string | null;
  readonly previousWorkItemId?: string | null;
}

/** MySQL / MariaDB duplicate key (1062), however deep the driver wrapped it. */
export function isDuplicateKey(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth += 1) {
    const record = e as { code?: unknown; errno?: unknown; cause?: unknown };
    if (record.code === 'ER_DUP_ENTRY' || record.errno === 1062) return true;
    e = record.cause;
  }
  return false;
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
   * rewrites the rule in place (the `uq_work_item_recurrence_item` key holds one-rule-per-item). A
   * v2 write also sets the RRULE columns, the template snapshot and the owner, and re-activates the
   * rule. Returns the stored row.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    input: UpsertRecurrenceInput,
  ): Promise<WorkItemRecurrenceRow> {
    const v2 = input.v2
      ? {
          rrule: input.v2.rrule,
          startsOn: input.v2.startsOn,
          byWeekday: input.v2.byWeekday,
          byMonthday: input.v2.byMonthday,
          bySetpos: input.v2.bySetpos,
          timeZone: input.v2.timeZone,
          spawnMode: input.v2.spawnMode,
          spawnAheadDays: input.v2.spawnAheadDays,
          holidayPolicy: input.v2.holidayPolicy,
          countLimit: input.v2.countLimit,
          templateJson: input.v2.templateJson,
          ownerUserId: input.v2.ownerUserId,
          status: 'active',
        }
      : {};
    const existing = await this.findByItem(runner, context, workItemId);
    if (existing) {
      await tenantDrizzle(runner)
        .update(workItemRecurrence)
        .set({
          freq: input.freq,
          intervalCount: input.intervalCount,
          untilAt: input.untilAt,
          ...v2,
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
          ...v2,
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

  /** Clear the rule for a work item. `true` if a row was removed (its instances cascade). */
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

  /** 53-09. Pause / resume / end one rule (by its id). */
  async setStatus(
    runner: TenantQueryRunner,
    context: TenantContext,
    recurrenceId: string,
    status: 'active' | 'paused' | 'ended',
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(workItemRecurrence)
      .set({ status, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(workItemRecurrence.organizationId, context.organizationId),
          eq(workItemRecurrence.id, recurrenceId),
        ),
      );
  }

  /** 53-09. Claim an occurrence. `false` when it was already claimed (the duplicate key). */
  async insertInstance(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsertInstanceInput,
  ): Promise<string | null> {
    const id = uuidv7();
    try {
      await tenantDrizzle(runner)
        .insert(workItemRecurrenceInstances)
        .values({
          id,
          organizationId: context.organizationId,
          recurrenceId: input.recurrenceId,
          occurrenceKey: input.occurrenceKey,
          workItemId: input.workItemId ?? null,
          previousWorkItemId: input.previousWorkItemId ?? null,
          status: input.status,
          createdAt: sql`current_timestamp(3)`,
        });
      return id;
    } catch (error) {
      if (isDuplicateKey(error)) return null;
      throw error;
    }
  }

  /** 53-09. The newest instances of a rule (newest scheduled date first). */
  async listInstances(
    runner: TenantQueryRunner,
    context: TenantContext,
    recurrenceId: string,
    limit = 50,
  ): Promise<readonly WorkItemRecurrenceInstanceRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemRecurrenceInstances)
      .where(
        and(
          eq(workItemRecurrenceInstances.organizationId, context.organizationId),
          eq(workItemRecurrenceInstances.recurrenceId, recurrenceId),
        ),
      )
      .orderBy(desc(workItemRecurrenceInstances.occurrenceKey))
      .limit(limit);
  }
}
