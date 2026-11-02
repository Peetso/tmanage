import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { isCustomRoleId, isInternalRole, uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  memberships,
  orgFinanceProfiles,
  personCapacity,
  projects,
  timePeriodLocks,
  timesheets,
  workItemTimeLogs,
  workItems,
} from '../../common/database/schema.js';
import type { TimesheetRow, WorkItemTimeLogRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { LockedPeriod, WeekBounds } from './time-rules.js';
import type { TimesheetState } from './timesheets-rules.js';

/**
 * 52-02 — storage for `timesheets` (0290) and the timesheet-side writes on `work_item_time_logs`.
 * Every statement carries the `organization_id` of the caller's context; no input names an
 * organization. New entries are NOT inserted here: the service hands them to
 * `WorkTimeLogsRepository.create` (rate snapshots, billable default). A week is history: nothing
 * here deletes one.
 */

export interface SheetPatch {
  readonly state?: TimesheetState;
  readonly submittedAt?: Date;
  readonly decidedBy?: string | null;
  readonly decidedAt?: Date | null;
  readonly decisionNote?: string | null;
  readonly editedByManager?: boolean;
  readonly totalMinutes?: number;
  readonly billableMinutes?: number;
}

export interface EntryPatch {
  readonly minutes: number;
  readonly spentOn: string;
  readonly billable: boolean;
  readonly note: string | null;
}

export interface InternalMember {
  readonly membershipId: string;
  readonly userId: string;
}

export class TimesheetsRepository {
  /** `org_finance_profiles.week_start` (0260), 0 (Sunday) when the org has no profile. */
  async weekStart(runner: TenantQueryRunner, context: TenantContext): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ weekStart: orgFinanceProfiles.weekStart })
      .from(orgFinanceProfiles)
      .where(eq(orgFinanceProfiles.organizationId, context.organizationId))
      .limit(1);
    return rows[0]?.weekStart ?? 0;
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    lock = false,
  ): Promise<TimesheetRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(timesheets)
      .where(and(eq(timesheets.organizationId, context.organizationId), eq(timesheets.id, id)))
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async findForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    periodStart: string,
  ): Promise<TimesheetRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(timesheets)
      .where(
        and(
          eq(timesheets.organizationId, context.organizationId),
          eq(timesheets.membershipId, membershipId),
          eq(timesheets.periodStart, periodStart),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The open row of a week, inserted when absent. A racing insert of the same week loses on
   * `uq_timesheets_member_period` and becomes a no-op; both callers then read the one row.
   */
  async ensure(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    bounds: WeekBounds,
    at: Date,
  ): Promise<TimesheetRow> {
    await tenantDrizzle(runner)
      .insert(timesheets)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId,
        periodStart: bounds.periodStart,
        periodEnd: bounds.periodEnd,
        state: 'open',
        createdAt: at,
        updatedAt: at,
      })
      .onDuplicateKeyUpdate({ set: { id: sql`id` } });
    const row = await this.findForMember(runner, context, membershipId, bounds.periodStart);
    if (row === null) throw new Error('timesheet vanished after it was written');
    return row;
  }

  async listForPeriod(
    runner: TenantQueryRunner,
    context: TenantContext,
    periodStart: string,
  ): Promise<readonly TimesheetRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(timesheets)
      .where(
        and(
          eq(timesheets.organizationId, context.organizationId),
          eq(timesheets.periodStart, periodStart),
        ),
      );
  }

  /**
   * Apply a patch and move `version` on by one, only when the row still holds `expectedVersion`.
   * 0 = somebody else wrote first.
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    expectedVersion: number,
    patch: SheetPatch,
    at: Date,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(timesheets)
      .set({ ...patch, version: sql`${timesheets.version} + 1`, updatedAt: at })
      .where(
        and(
          eq(timesheets.organizationId, context.organizationId),
          eq(timesheets.id, id),
          eq(timesheets.version, expectedVersion),
        ),
      );
    return result[0].affectedRows;
  }

  /** The entries of these members (`logged_by` = membership id) on the days of the week. */
  async entriesInPeriod(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipIds: readonly string[],
    bounds: WeekBounds,
    lock = false,
  ): Promise<readonly WorkItemTimeLogRow[]> {
    if (membershipIds.length === 0) return [];
    const query = tenantDrizzle(runner)
      .select()
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          inArray(workItemTimeLogs.loggedBy, [...membershipIds]),
          gte(workItemTimeLogs.spentOn, bounds.periodStart),
          lte(workItemTimeLogs.spentOn, bounds.periodEnd),
        ),
      )
      .orderBy(asc(workItemTimeLogs.spentOn), asc(workItemTimeLogs.id));
    return lock ? query.for('update') : query;
  }

  /** Change the numbers of one entry of `loggedBy`; the work item is never moved here. */
  async updateEntry(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    patch: EntryPatch,
    timesheetId: string,
    by: string,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(workItemTimeLogs)
      .set({ ...patch, timesheetId, updatedBy: by, updatedAt: at })
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.id, id),
          isNull(workItemTimeLogs.lockedAt),
        ),
      );
  }

  /** Name the sheet on freshly created entries. */
  async stampTimesheet(
    runner: TenantQueryRunner,
    context: TenantContext,
    ids: readonly string[],
    timesheetId: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    await tenantDrizzle(runner)
      .update(workItemTimeLogs)
      .set({ timesheetId })
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          inArray(workItemTimeLogs.id, [...ids]),
          isNull(workItemTimeLogs.lockedAt),
        ),
      );
  }

  /**
   * File unsorted entries under a work item: only rows still without an item (the 0265 trigger
   * allows naming the item once). Returns the rows moved.
   */
  async fileUnder(
    runner: TenantQueryRunner,
    context: TenantContext,
    ids: readonly string[],
    target: { readonly workItemId: string; readonly projectId: string },
    timesheetId: string,
    by: string,
    at: Date,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(workItemTimeLogs)
      .set({ ...target, timesheetId, updatedBy: by, updatedAt: at })
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          inArray(workItemTimeLogs.id, [...ids]),
          isNull(workItemTimeLogs.workItemId),
          isNull(workItemTimeLogs.lockedAt),
        ),
      );
    return result[0].affectedRows;
  }

  /** The week's totals by SUM, in the caller's transaction (INT-52-06). */
  async sumTotals(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    bounds: WeekBounds,
  ): Promise<{ readonly totalMinutes: number; readonly billableMinutes: number }> {
    const rows = await tenantDrizzle(runner)
      .select({
        total: sql<string | number | null>`COALESCE(SUM(${workItemTimeLogs.minutes}), 0)`,
        billable: sql<
          string | number | null
        >`COALESCE(SUM(CASE WHEN ${workItemTimeLogs.billable} = 1 THEN ${workItemTimeLogs.minutes} ELSE 0 END), 0)`,
      })
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.loggedBy, membershipId),
          gte(workItemTimeLogs.spentOn, bounds.periodStart),
          lte(workItemTimeLogs.spentOn, bounds.periodEnd),
        ),
      );
    return {
      totalMinutes: Number(rows[0]?.total ?? 0),
      billableMinutes: Number(rows[0]?.billable ?? 0),
    };
  }

  /** Open period locks (52-03) that touch the week. */
  async openLocks(
    runner: TenantQueryRunner,
    context: TenantContext,
    bounds: WeekBounds,
  ): Promise<readonly LockedPeriod[]> {
    return tenantDrizzle(runner)
      .select({
        periodStart: timePeriodLocks.periodStart,
        periodEnd: timePeriodLocks.periodEnd,
        unlockedAt: timePeriodLocks.unlockedAt,
      })
      .from(timePeriodLocks)
      .where(
        and(
          eq(timePeriodLocks.organizationId, context.organizationId),
          gte(timePeriodLocks.periodEnd, bounds.periodStart),
          lte(timePeriodLocks.periodStart, bounds.periodEnd),
          isNull(timePeriodLocks.unlockedAt),
        ),
      );
  }

  /** `person_capacity.weekly_hours` (0068) of a membership, or `null`. */
  async weeklyHours(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<number | null> {
    const rows = await tenantDrizzle(runner)
      .select({ weeklyHours: personCapacity.weeklyHours })
      .from(personCapacity)
      .where(
        and(
          eq(personCapacity.organizationId, context.organizationId),
          eq(personCapacity.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0]?.weeklyHours ?? null;
  }

  /** Active internal memberships (built-in internal or custom role; support seats excluded). */
  async internalMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly InternalMember[]> {
    const rows = await tenantDrizzle(runner)
      .select({ membershipId: memberships.id, userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          isNull(memberships.platformSupportSessionId),
        ),
      );
    return rows
      .filter((row) => isInternalRole(row.role) || isCustomRoleId(row.role.toLowerCase()))
      .map(({ membershipId, userId }) => ({ membershipId, userId }));
  }

  /** The user behind a membership of this organization (the inbox recipient), or `null`. */
  async userOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
        ),
      )
      .limit(1);
    return rows[0]?.userId ?? null;
  }

  async projectExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, context.organizationId), eq(projects.id, projectId)))
      .limit(1);
    return rows.length > 0;
  }

  /** Work item titles by id (the caller decides which ids it may show). */
  async titles(
    runner: TenantQueryRunner,
    context: TenantContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ id: workItems.id, title: workItems.title })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          inArray(workItems.id, [...new Set(ids)]),
        ),
      );
    return new Map(rows.map((row) => [row.id, row.title]));
  }
}
