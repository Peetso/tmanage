import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, lt, lte } from 'drizzle-orm';
import { isCustomRoleId, uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  customRoles,
  memberships,
  notifications,
  timePeriodLocks,
  workItemTimeLogs,
} from '../../common/database/schema.js';
import type { TimePeriodLockRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { FinanceCandidate, LockWindow } from './locks-rules.js';

/**
 * 52-03 — storage for `time_period_locks` (0288) and the lock stamp on `work_item_time_logs`.
 * Every statement carries the `organization_id` from the caller's context; no input names an
 * organization. A lock row is history: nothing here deletes one.
 */

export interface NewLock extends LockWindow {
  readonly lockedBy: string;
  readonly lockedAt: Date;
}

export class TimeLocksRepository {
  /** Newest first (ids are UUIDv7, so creation order), after `cursor` when given. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    cursor: string | null,
    limit: number,
  ): Promise<readonly TimePeriodLockRow[]> {
    const scope = eq(timePeriodLocks.organizationId, context.organizationId);
    return tenantDrizzle(runner)
      .select()
      .from(timePeriodLocks)
      .where(cursor === null ? scope : and(scope, lt(timePeriodLocks.id, cursor)))
      .orderBy(desc(timePeriodLocks.id))
      .limit(limit);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    lock = false,
  ): Promise<TimePeriodLockRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(timePeriodLocks)
      .where(
        and(eq(timePeriodLocks.organizationId, context.organizationId), eq(timePeriodLocks.id, id)),
      )
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  /**
   * Open locks overlapping the window, read FOR UPDATE: the range scan takes next-key locks on
   * `ix_time_period_locks_end`, so a concurrent overlapping lock waits (or deadlocks) instead of
   * slipping past the check.
   */
  async findOverlappingOpen(
    runner: TenantQueryRunner,
    context: TenantContext,
    window: LockWindow,
  ): Promise<readonly TimePeriodLockRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(timePeriodLocks)
      .where(
        and(
          eq(timePeriodLocks.organizationId, context.organizationId),
          gte(timePeriodLocks.periodEnd, window.periodStart),
          lte(timePeriodLocks.periodStart, window.periodEnd),
          isNull(timePeriodLocks.unlockedAt),
        ),
      )
      .for('update');
  }

  /** The row for this month start, open or reopened (one per organization per start). */
  async findByStart(
    runner: TenantQueryRunner,
    context: TenantContext,
    periodStart: string,
  ): Promise<TimePeriodLockRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(timePeriodLocks)
      .where(
        and(
          eq(timePeriodLocks.organizationId, context.organizationId),
          eq(timePeriodLocks.periodStart, periodStart),
        ),
      )
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  async insert(runner: TenantQueryRunner, context: TenantContext, input: NewLock): Promise<string> {
    const id = uuidv7();
    await tenantDrizzle(runner).insert(timePeriodLocks).values({
      id,
      organizationId: context.organizationId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      lockedBy: input.lockedBy,
      lockedAt: input.lockedAt,
      entriesLocked: 0,
      createdAt: input.lockedAt,
    });
    return id;
  }

  /** Close a reopened row of the same month start again, with the new window and closer. */
  async reopenAsLocked(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    input: NewLock,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(timePeriodLocks)
      .set({
        periodEnd: input.periodEnd,
        lockedBy: input.lockedBy,
        lockedAt: input.lockedAt,
        unlockedBy: null,
        unlockedAt: null,
        reason: null,
        entriesLocked: 0,
      })
      .where(
        and(eq(timePeriodLocks.organizationId, context.organizationId), eq(timePeriodLocks.id, id)),
      );
  }

  async setEntriesLocked(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    count: number,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(timePeriodLocks)
      .set({ entriesLocked: count })
      .where(
        and(eq(timePeriodLocks.organizationId, context.organizationId), eq(timePeriodLocks.id, id)),
      );
  }

  /** Stamp the reopen on a still-open row; 0 tells a racing second unlock that it lost. */
  async markUnlocked(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    by: string,
    at: Date,
    reason: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(timePeriodLocks)
      .set({ unlockedBy: by, unlockedAt: at, reason })
      .where(
        and(
          eq(timePeriodLocks.organizationId, context.organizationId),
          eq(timePeriodLocks.id, id),
          isNull(timePeriodLocks.unlockedAt),
        ),
      );
    return result[0].affectedRows;
  }

  /**
   * One batch of the lock stamp: the next `batch` unlocked entries in the window by id, then
   * `locked_at = at` on exactly those. Returns how many were picked and how many changed.
   */
  async stampBatch(
    runner: TenantQueryRunner,
    context: TenantContext,
    window: LockWindow,
    at: Date,
    batch: number,
  ): Promise<{ readonly picked: number; readonly changed: number }> {
    return this.batch(runner, context, window, batch, false, at);
  }

  /** One batch of the unlock: `locked_at = NULL` on the next `batch` locked entries in the window. */
  async clearBatch(
    runner: TenantQueryRunner,
    context: TenantContext,
    window: LockWindow,
    batch: number,
  ): Promise<{ readonly picked: number; readonly changed: number }> {
    return this.batch(runner, context, window, batch, true, null);
  }

  private async batch(
    runner: TenantQueryRunner,
    context: TenantContext,
    window: LockWindow,
    batch: number,
    locked: boolean,
    stamp: Date | null,
  ): Promise<{ readonly picked: number; readonly changed: number }> {
    const db = tenantDrizzle(runner);
    const scope = eq(workItemTimeLogs.organizationId, context.organizationId);
    const state = locked ? isNotNull(workItemTimeLogs.lockedAt) : isNull(workItemTimeLogs.lockedAt);
    const rows = await db
      .select({ id: workItemTimeLogs.id })
      .from(workItemTimeLogs)
      .where(
        and(
          scope,
          gte(workItemTimeLogs.spentOn, window.periodStart),
          lte(workItemTimeLogs.spentOn, window.periodEnd),
          state,
        ),
      )
      .orderBy(asc(workItemTimeLogs.id))
      .limit(batch);
    if (rows.length === 0) return { picked: 0, changed: 0 };
    const result = await db
      .update(workItemTimeLogs)
      .set({ lockedAt: stamp })
      .where(
        and(
          scope,
          inArray(
            workItemTimeLogs.id,
            rows.map((row) => row.id),
          ),
          state,
        ),
      );
    return { picked: rows.length, changed: result[0].affectedRows };
  }

  /**
   * Active internal memberships (support-session seats excluded) with, for a custom role, the
   * capability list its row stores. `financeManagers` decides who holds `finance.manage`.
   */
  async financeCandidates(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly FinanceCandidate[]> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          isNull(memberships.platformSupportSessionId),
        ),
      );
    const customIds = [
      ...new Set(rows.map((row) => row.role.toLowerCase()).filter(isCustomRoleId)),
    ];
    const custom = new Map<string, string>();
    if (customIds.length > 0) {
      const roleRows = await db
        .select({ id: customRoles.id, capabilitiesJson: customRoles.capabilitiesJson })
        .from(customRoles)
        .where(
          and(
            eq(customRoles.organizationId, context.organizationId),
            inArray(customRoles.id, customIds),
          ),
        );
      for (const row of roleRows) custom.set(row.id, row.capabilitiesJson);
    }
    return rows.map((row) => ({
      userId: row.userId,
      role: row.role,
      customCapabilitiesJson: custom.get(row.role.toLowerCase()) ?? null,
    }));
  }

  /** Has this membership asked to reopen this lock since `since`? Read off the inbox notices. */
  async unlockRequestedSince(
    runner: TenantQueryRunner,
    context: TenantContext,
    type: string,
    lockId: string,
    membershipId: string,
    since: Date,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.organizationId, context.organizationId),
          eq(notifications.type, type),
          eq(notifications.objectId, lockId),
          like(notifications.dedupeKey, `${unlockRequestKeyPrefix(lockId, membershipId)}%`),
          gte(notifications.createdAt, since),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}

/** The dedupe-key prefix of one member's unlock requests on one lock (ids only, no wildcards). */
export function unlockRequestKeyPrefix(lockId: string, membershipId: string): string {
  return `time_lock.unlock:${lockId}:${membershipId}:`;
}
