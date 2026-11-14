import { and, asc, eq, gt, gte, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import { ACTIVITY_GAP_SECONDS, uuidv7 } from '@tmanage/domain';
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
import { MAX_SPAN_MS } from './time-rules.js';

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
  readonly deviceKind?: string;
  readonly deviceSeenAt?: Date;
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

  /**
   * Minutes of the member's `automatic` entries whose session piece started in `[from, to)`: the
   * time already counted against a company day's cap, wherever a late piece was filed.
   */
  async automaticMinutesBetween(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    from: Date,
    to: Date,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ minutes: sql<string | number | null>`sum(${workItemTimeLogs.minutes})` })
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.loggedBy, membershipId),
          eq(workItemTimeLogs.source, 'automatic'),
          gte(workItemTimeLogs.startedAt, from),
          lt(workItemTimeLogs.startedAt, to),
        ),
      );
    return Number(rows[0]?.minutes ?? 0);
  }

  /**
   * Open sessions that no heartbeat can extend any more (silent past the join gap, or 24 h old),
   * locked FOR UPDATE so a concurrent heartbeat and a settling reader never file one twice.
   * `membershipIds` null = the whole company.
   */
  async staleSessions(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[] | null,
    at: Date,
  ): Promise<readonly TimeAutoTrackingRow[]> {
    if (membershipIds !== null && membershipIds.length === 0) return [];
    const silentSince = new Date(at.getTime() - ACTIVITY_GAP_SECONDS * 1000);
    const oldSince = new Date(at.getTime() - MAX_SPAN_MS);
    return tenantDrizzle(runner)
      .select()
      .from(timeAutoTracking)
      .where(
        and(
          eq(timeAutoTracking.organizationId, context.organizationId),
          membershipIds === null
            ? undefined
            : inArray(timeAutoTracking.membershipId, [...membershipIds]),
          isNotNull(timeAutoTracking.sessionStartedAt),
          or(
            lt(timeAutoTracking.lastHeartbeatAt, silentSince),
            lte(timeAutoTracking.sessionStartedAt, oldSince),
          ),
        ),
      )
      .limit(MAX_TEAM_MEMBERS)
      .for('update');
  }

  /** Every open session of the company, locked FOR UPDATE (the owner turned tracking off). */
  async openSessions(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly TimeAutoTrackingRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(timeAutoTracking)
      .where(
        and(
          eq(timeAutoTracking.organizationId, context.organizationId),
          isNotNull(timeAutoTracking.sessionStartedAt),
        ),
      )
      .limit(MAX_TEAM_MEMBERS)
      .for('update');
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
