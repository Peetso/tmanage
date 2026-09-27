import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItemReminders, workItems } from '../../common/database/schema.js';
import type { WorkItemReminderRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Work item reminders — x256's storage half (Work module 7).
 *
 * Follows `WorkWatchersRepository`: `TenantContext` is the scoping parameter, no `organizationId`
 * on any input type (it comes from the context), and every read and write is bound to
 * `(organization_id, …)` so a caller in the wrong tenant sees nothing rather than a leak. The
 * repository holds no policy — the service decides who may read or write, and the composite foreign
 * key of migration 0126 is what makes a cross-tenant `work_item_id` a non-existent pair.
 *
 * Unlike the append-only joins in this module, a reminder is genuinely mutable: {@link upsert} is a
 * single `INSERT ... ON DUPLICATE KEY UPDATE` against `uq_work_item_reminders_member`, so two saves
 * racing for one member's row serialise on the unique key rather than on a row this code read first.
 * `remind_at` is written from a bound Date the caller supplies, never the connection's
 * `CURRENT_TIMESTAMP`, so the stored instant does not depend on which pool's clock ran the statement.
 */

/** The largest due-reminder page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_REMINDER_PAGE = 500;

export interface UpsertReminderInput {
  readonly workItemId: string;
  readonly membershipId: string;
  /** A bound instant — never reconstructed from the DB clock (admin-pool-clock safe). */
  readonly remindAt: Date;
}

/** A due reminder joined to the work item it names, for the "My Reminders" list projection. */
export interface DueReminderWithItem {
  readonly reminder: WorkItemReminderRow;
  readonly workItemTitle: string;
  readonly workItemState: string;
}

export class WorkItemRemindersRepository {
  /** One member's reminder on one item, scoped to the tenant; `null` if absent. */
  async findForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    membershipId: string,
  ): Promise<WorkItemReminderRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemReminders)
      .where(
        and(
          eq(workItemReminders.organizationId, context.organizationId),
          eq(workItemReminders.workItemId, workItemId),
          eq(workItemReminders.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create or move this member's reminder on this item. Idempotent by the unique
   * `(organization_id, work_item_id, membership_id)` key: a repeat moves `remind_at` in place rather
   * than duplicating. The insert path fills `id`/`created_at`; the update path moves only
   * `remind_at` (and `updated_at` follows by the column's `ON UPDATE`). Read back so the caller gets
   * the server-generated timestamps.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertReminderInput,
  ): Promise<WorkItemReminderRow> {
    await tenantDrizzle(runner)
      .insert(workItemReminders)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        workItemId: input.workItemId,
        membershipId: input.membershipId,
        remindAt: input.remindAt,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          remindAt: input.remindAt,
          updatedAt: sql`current_timestamp(3)`,
        },
      });

    const saved = await this.findForMember(runner, context, input.workItemId, input.membershipId);
    if (!saved) {
      // Unreachable: the upsert above committed this row in this transaction.
      throw new Error('work item reminder vanished immediately after upsert');
    }
    return saved;
  }

  /** Remove one member's reminder on one item, scoped to the tenant. Idempotent — a no-op if absent. */
  async deleteForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    membershipId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(workItemReminders)
      .where(
        and(
          eq(workItemReminders.organizationId, context.organizationId),
          eq(workItemReminders.workItemId, workItemId),
          eq(workItemReminders.membershipId, membershipId),
        ),
      );
  }

  /**
   * The acting member's reminders whose `remind_at` is at or before `before`, joined to each work
   * item so the caller can render a title and state without a second query. The join is on the
   * composite `(organization_id, id)` so it never crosses a tenant; the order is `remind_at ASC,
   * id ASC` — soonest first, UUIDv7 id as the deterministic tiebreaker. Own reminders only: the
   * `membership_id` predicate is not optional, so this is never another member's list.
   */
  async listDueForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    before: Date,
    limit: number = MAX_REMINDER_PAGE,
  ): Promise<readonly DueReminderWithItem[]> {
    const rows = await tenantDrizzle(runner)
      .select({ reminder: workItemReminders, title: workItems.title, state: workItems.state })
      .from(workItemReminders)
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, workItemReminders.organizationId),
          eq(workItems.id, workItemReminders.workItemId),
        ),
      )
      .where(
        and(
          eq(workItemReminders.organizationId, context.organizationId),
          eq(workItemReminders.membershipId, membershipId),
          lte(workItemReminders.remindAt, before),
        ),
      )
      .orderBy(asc(workItemReminders.remindAt), asc(workItemReminders.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_REMINDER_PAGE));

    return rows.map((row) => ({
      reminder: row.reminder,
      workItemTitle: row.title,
      workItemState: row.state,
    }));
  }
}
