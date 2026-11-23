import { and, asc, eq, exists, inArray, isNull, or, sql } from 'drizzle-orm';
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
 * Since 0412 (work area, 2026-11-23) this table is the **single source** of who does an item:
 * every owned item has a doer row for its owner (the back-fill), and every write that names an
 * owner keeps it so (`WorkItemsRepository.create`, `update`, `transitionState`,
 * `clearOwnerForUser`, and the people routes all go through {@link syncLead} or
 * {@link replaceRole}). `work_items.owner_user_id` is the denormalised **lead doer** — the first
 * doer row — kept for the 40-odd readers that sort and filter by it. The predicates here still
 * count the owner, which is now redundant but costs nothing and keeps a row written by a path
 * this file has not met honest. Members are stored by membership id and exchanged with the rest
 * of the work module by user id, the way the owner is.
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
   * Keep the doer rows in step after the owner changed (0412: always, so the rows stay the single
   * source). The old lead's doer row goes, the new lead gets one at the front, the other doers
   * keep their order, and a cleared owner clears every doer (the rule `PUT …/people/doers` with
   * `[]` already follows). An owner who is not an active member gets no row (the service refuses
   * one before it writes; this only keeps an older row honest).
   */
  async syncLead(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    afterOwnerUserId: string | null,
    beforeOwnerUserId: string | null,
  ): Promise<void> {
    const rows = (await this.list(runner, context, workItemId)).filter((r) => r.role === 'doer');
    if (afterOwnerUserId === null) {
      if (rows.length === 0) return;
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
    const same =
      next.length === rows.length && next.every((id, index) => rows[index]?.membershipId === id);
    if (same) return;
    await this.replaceRole(runner, context, workItemId, 'doer', next);
  }

  /**
   * 0412 — a member leaves (offboarding): every item they led that has another active doer
   * passes to the next one, then their doer and supervisor rows go, so a task is never waiting on
   * the approval of someone who can no longer sign in. Items with no other doer keep the owner
   * for the caller to clear. Returns how many items changed lead.
   */
  async removeMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    options: { readonly liveOnly?: boolean } = {},
  ): Promise<number> {
    const membershipId = (
      await tenantDrizzle(runner)
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, context.organizationId),
            eq(memberships.userId, userId),
          ),
        )
        .limit(1)
    )[0]?.id;
    if (membershipId === undefined) return 0;
    const a = workItemAssignees;
    // The next doer of each item this person led, by the rows' own order. A correlated
    // subquery on other tables only (MariaDB-safe: no self-reference in the UPDATE).
    const result = await tenantDrizzle(runner)
      .update(workItems)
      .set({
        ownerUserId: sql`(select ${memberships.userId} from ${a} inner join ${memberships}
          on ${memberships.organizationId} = ${a.organizationId} and ${memberships.id} = ${a.membershipId}
          where ${a.organizationId} = ${context.organizationId}
          and ${a.workItemId} = ${workItems.id}
          and ${a.role} = 'doer'
          and ${a.membershipId} <> ${membershipId}
          and ${memberships.status} = 'active'
          order by ${a.createdAt}, ${a.membershipId}
          limit 1)`,
        version: sql`version + 1`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.ownerUserId, userId),
          ...(options.liveOnly === true ? [isNull(workItems.deletedAt)] : []),
          // Only items that have another active doer to pass to; the caller clears the rest.
          exists(
            sql`(select 1 from ${a} inner join ${memberships}
              on ${memberships.organizationId} = ${a.organizationId} and ${memberships.id} = ${a.membershipId}
              where ${a.organizationId} = ${context.organizationId}
              and ${a.workItemId} = ${workItems.id}
              and ${a.role} = 'doer'
              and ${a.membershipId} <> ${membershipId}
              and ${memberships.status} = 'active')`,
          ),
        ),
      );
    await tenantDrizzle(runner)
      .delete(a)
      .where(and(eq(a.organizationId, context.organizationId), eq(a.membershipId, membershipId)));
    return result[0].affectedRows;
  }

  /** 0412 — a new item's doer rows, lead first, written in the create's own transaction. */
  async writeOnCreate(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    ownerUserId: string | null,
  ): Promise<void> {
    if (ownerUserId === null) return;
    const lead = (await this.activeMemberships(runner, context, [ownerUserId])).get(ownerUserId);
    if (lead === undefined) return;
    await this.replaceRole(runner, context, workItemId, 'doer', [lead]);
  }
}
