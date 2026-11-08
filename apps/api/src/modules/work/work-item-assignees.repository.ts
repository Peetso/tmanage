import { and, asc, eq, exists, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  memberships,
  workItemAssignees,
  workItemWatchers,
  workItems,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * C26 (0318) — the doers and supervisors of a work item.
 *
 * `work_items.owner_user_id` stays the **lead doer**. An item with no doer rows reads its owner as
 * its only doer (every item written before 0318), so the predicates here always count the owner
 * and add whoever else holds a doer row. Members are stored by membership id and exchanged with
 * the rest of the work module by user id, the way the owner is.
 */
export type AssigneeRole = 'doer' | 'supervisor';

export interface AssigneeRow {
  readonly userId: string;
  readonly membershipId: string;
  readonly role: AssigneeRole;
}

/**
 * "This person does the item": the owner, or a doer row naming their membership. A SQL predicate
 * on `work_items`, so My Day, Home pulse and the load reads count every doer, not only the lead.
 */
export function isDoerOf(context: TenantContext, userId: string): SQL {
  const a = workItemAssignees;
  return or(
    eq(workItems.ownerUserId, userId),
    exists(
      sql`(select 1 from ${a} inner join ${memberships}
        on ${memberships.organizationId} = ${a.organizationId} and ${memberships.id} = ${a.membershipId}
        where ${a.organizationId} = ${context.organizationId}
        and ${a.organizationId} = ${workItems.organizationId}
        and ${a.workItemId} = ${workItems.id}
        and ${a.role} = 'doer'
        and ${memberships.userId} = ${userId})`,
    ),
  ) as SQL;
}

/** Storage for `work_item_assignees`. Every statement carries the tenant key. */
export class WorkItemAssigneesRepository {
  /** The item's doer and supervisor rows with each member's user id, oldest first. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<readonly AssigneeRow[]> {
    return tenantDrizzle(runner)
      .select({
        userId: memberships.userId,
        membershipId: workItemAssignees.membershipId,
        role: workItemAssignees.role,
      })
      .from(workItemAssignees)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, workItemAssignees.organizationId),
          eq(memberships.id, workItemAssignees.membershipId),
        ),
      )
      .where(
        and(
          eq(workItemAssignees.organizationId, context.organizationId),
          eq(workItemAssignees.workItemId, workItemId),
        ),
      )
      .orderBy(asc(workItemAssignees.createdAt), asc(workItemAssignees.membershipId));
  }

  /**
   * C27: the doer rows of several items at once (a list page), by user id, oldest first per item.
   * The owner is not added here; {@link doersWithLead} puts the lead first.
   */
  async doersFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    if (workItemIds.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ workItemId: workItemAssignees.workItemId, userId: memberships.userId })
      .from(workItemAssignees)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, workItemAssignees.organizationId),
          eq(memberships.id, workItemAssignees.membershipId),
        ),
      )
      .where(
        and(
          eq(workItemAssignees.organizationId, context.organizationId),
          inArray(workItemAssignees.workItemId, [...workItemIds]),
          eq(workItemAssignees.role, 'doer'),
        ),
      )
      .orderBy(asc(workItemAssignees.createdAt), asc(workItemAssignees.membershipId));
    const byItem = new Map<string, string[]>();
    for (const row of rows) {
      const list = byItem.get(row.workItemId) ?? [];
      list.push(row.userId);
      byItem.set(row.workItemId, list);
    }
    return byItem;
  }

  /** The item's watchers by user id, oldest first (the watch rows hold membership ids). */
  async watcherUserIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: memberships.userId })
      .from(workItemWatchers)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, workItemWatchers.organizationId),
          eq(memberships.id, workItemWatchers.memberId),
        ),
      )
      .where(
        and(
          eq(workItemWatchers.organizationId, context.organizationId),
          eq(workItemWatchers.workItemId, workItemId),
        ),
      )
      .orderBy(asc(workItemWatchers.createdAt), asc(workItemWatchers.id))
      .limit(500);
    return rows.map((row) => row.userId);
  }

  /** userId → membership id, for the given people who are active members of this organization. */
  async activeMemberships(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ id: memberships.id, userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          inArray(memberships.userId, [...userIds]),
          eq(memberships.status, 'active'),
        ),
      );
    return new Map(rows.map((row) => [row.userId, row.id]));
  }

  /** Replace one role's set. `[]` clears it. */
  async replaceRole(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    role: AssigneeRole,
    membershipIds: readonly string[],
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(workItemAssignees)
      .where(
        and(
          eq(workItemAssignees.organizationId, context.organizationId),
          eq(workItemAssignees.workItemId, workItemId),
          eq(workItemAssignees.role, role),
        ),
      );
    if (membershipIds.length === 0) return;
    // One millisecond apart, so "oldest first" keeps the order the caller gave.
    const base = Date.now();
    await tenantDrizzle(runner)
      .insert(workItemAssignees)
      .values(
        membershipIds.map((membershipId, index) => ({
          organizationId: context.organizationId,
          workItemId,
          membershipId,
          role,
          createdAt: new Date(base + index),
        })),
      );
  }

  /**
   * Set the item's lead (owner) without an optimistic-version check: the people routes own the
   * doer set, and a concurrent editor still loses its race because `version` is bumped.
   */
  async setLead(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    ownerUserId: string | null,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(workItems)
      .set({
        ownerUserId,
        version: sql`version + 1`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(eq(workItems.organizationId, context.organizationId), eq(workItems.id, workItemId)),
      );
  }

  /**
   * Keep the doer rows in step after the owner changed on the work-item update. Nothing to do
   * when the item has no doer rows (the owner alone is the doer). Otherwise the old lead's doer
   * row goes, the new lead gets one, and a cleared owner clears every doer.
   */
  async syncLead(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    afterOwnerUserId: string | null,
    beforeOwnerUserId: string | null,
  ): Promise<void> {
    const rows = (await this.list(runner, context, workItemId)).filter((r) => r.role === 'doer');
    if (rows.length === 0) return;
    if (afterOwnerUserId === null) {
      await this.replaceRole(runner, context, workItemId, 'doer', []);
      return;
    }
    const kept = rows.filter(
      (row) => row.userId !== beforeOwnerUserId && row.userId !== afterOwnerUserId,
    );
    const lead = (await this.activeMemberships(runner, context, [afterOwnerUserId])).get(
      afterOwnerUserId,
    );
    const next = [...(lead === undefined ? [] : [lead]), ...kept.map((row) => row.membershipId)];
    await this.replaceRole(runner, context, workItemId, 'doer', next);
  }
}
