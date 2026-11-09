import { and, asc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  memberships,
  timeAutoTracking,
  users,
  workItemTimeLogs,
} from '../../common/database/schema.js';
import type { TimeAutoTrackingRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { Span } from './time-auto-rules.js';

/**
 * FIX-2026-11-10 — storage for automatic tracking (`time_auto_tracking`, 0341). Every statement
 * carries the `organization_id` of the caller's context; the own-row statements also carry the
 * caller's membership. Finished sessions are written by `WorkTimeLogsRepository` (source
 * `automatic`); this repository only reads the person's other timed entries to keep them apart.
 */

/** The team view reads at most this many people. */
export const MAX_TEAM_MEMBERS = 500;

export interface AutoRowPatch {
  readonly enabled?: boolean;
  readonly idleThresholdMinutes?: number;
  readonly workItemId?: string | null;
  readonly projectId?: string | null;
  readonly sessionStartedAt?: Date | null;
  readonly lastActiveAt?: Date | null;
  readonly lastHeartbeatAt?: Date | null;
}

export interface MemberName {
  readonly membershipId: string;
  readonly displayName: string;
}

export class TimeAutoRepository {
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    lock = false,
  ): Promise<TimeAutoTrackingRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(timeAutoTracking)
      .where(
        and(
          eq(timeAutoTracking.organizationId, context.organizationId),
          eq(timeAutoTracking.membershipId, membershipId),
        ),
      )
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  /** The caller's row, created with the defaults when it does not exist yet, locked FOR UPDATE. */
  async ensureOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    at: Date,
  ): Promise<TimeAutoTrackingRow> {
    await tenantDrizzle(runner)
      .insert(timeAutoTracking)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId: context.membershipId,
        userId: context.userId,
        createdAt: at,
        updatedAt: at,
      })
      .onDuplicateKeyUpdate({ set: { id: sql`id` } });
    const row = await this.find(runner, context, context.membershipId, true);
    if (row === null) throw new Error('automatic tracking row vanished after it was written');
    return row;
  }

  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    rowId: string,
    patch: AutoRowPatch,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(timeAutoTracking)
      .set({ ...patch, updatedAt: at })
      .where(
        and(
          eq(timeAutoTracking.organizationId, context.organizationId),
          eq(timeAutoTracking.id, rowId),
        ),
      );
  }

  /**
   * The member's timed entries that overlap `span` (started and ended set), so a finished session
   * is filed only where no other entry already counts the time.
   */
  async timedEntriesOverlapping(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    span: Span,
  ): Promise<readonly Span[]> {
    const rows = await tenantDrizzle(runner)
      .select({ startedAt: workItemTimeLogs.startedAt, endedAt: workItemTimeLogs.endedAt })
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.loggedBy, membershipId),
          isNotNull(workItemTimeLogs.startedAt),
          isNotNull(workItemTimeLogs.endedAt),
          lt(workItemTimeLogs.startedAt, span.endedAt),
          gt(workItemTimeLogs.endedAt, span.startedAt),
        ),
      )
      .orderBy(asc(workItemTimeLogs.startedAt));
    return rows.flatMap((row) =>
      row.startedAt !== null && row.endedAt !== null
        ? [{ startedAt: row.startedAt, endedAt: row.endedAt }]
        : [],
    );
  }

  /** Every automatic tracking row of these members (the team view's live state). */
  async listForMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<readonly TimeAutoTrackingRow[]> {
    if (membershipIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select()
      .from(timeAutoTracking)
      .where(
        and(
          eq(timeAutoTracking.organizationId, context.organizationId),
          inArray(timeAutoTracking.membershipId, [...membershipIds]),
        ),
      )
      .limit(MAX_TEAM_MEMBERS);
  }

  /** Display names of memberships of this organization. */
  async memberNames(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
  ): Promise<readonly MemberName[]> {
    if (membershipIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select({ membershipId: memberships.id, displayName: users.displayName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          inArray(memberships.id, [...membershipIds]),
        ),
      )
      .limit(MAX_TEAM_MEMBERS);
  }
}
