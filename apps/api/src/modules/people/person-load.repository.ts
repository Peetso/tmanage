import { and, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { defaultWorkingCalendar } from '@tmanage/domain';
import type { WorkItemState, WorkingCalendar } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  personCapacity,
  workItemEstimates,
  workItemTimeLogs,
  workItems,
} from '../../common/database/schema.js';
import type {
  PersonAllocationRow,
  PersonCapacityRow,
  PersonTimeOffRow,
  WorkItemRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { WorkingCalendarRepository } from '../working-calendar/working-calendar.repository.js';
import { effectiveRemaining } from '../work/item-estimate.service.js';
import { CapacityHeatmapRepository } from './capacity-heatmap.repository.js';
import { PersonTimeOffRepository } from './time-off.repository.js';

/**
 * 53-08 (R20-b) — the reads behind one person's load. Read-only, tenant-scoped on every statement
 * (`organization_id = context.organizationId`, executed through the guard). It composes the existing
 * capacity-heatmap allocation read, the time-off read and the working-calendar read; its own two
 * statements are the member's open work items (bounded by the window and a row cap) and their
 * estimates (a second statement rather than a join, so each table carries its own tenant predicate).
 */

/** The open states — the same set the WK-06 workload counts (`done` and `archived` are not load). */
export const OPEN_LOAD_STATES: readonly WorkItemState[] = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'internal_review',
];

/** A defensive cap: one person's open dated work in a 26-week window never needs more rows. */
export const MAX_LOAD_ITEMS = 2000;
const ESTIMATE_CHUNK = 500;

export interface LoadItemRow {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly audience: WorkItemRow['audience'];
  readonly state: string;
  readonly startAt: Date | null;
  readonly dueAt: Date | null;
  readonly deletedAt: Date | null;
}

export class PersonLoadRepository {
  constructor(
    private readonly heatmap = new CapacityHeatmapRepository(),
    private readonly timeOff = new PersonTimeOffRepository(),
    private readonly calendars = new WorkingCalendarRepository(),
  ) {}

  /**
   * The member's open, not-deleted work items with at least one date touching
   * `[windowStart, windowEnd)` (instants; the caller pads a day either side for time zones).
   */
  async listOpenItemsForOwner(
    runner: TenantQueryRunner,
    context: TenantContext,
    ownerUserId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<readonly LoadItemRow[]> {
    return tenantDrizzle(runner)
      .select({
        id: workItems.id,
        organizationId: workItems.organizationId,
        projectId: workItems.projectId,
        audience: workItems.audience,
        state: workItems.state,
        startAt: workItems.startAt,
        dueAt: workItems.dueAt,
        deletedAt: workItems.deletedAt,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          eq(workItems.ownerUserId, ownerUserId),
          inArray(workItems.state, [...OPEN_LOAD_STATES]),
          isNull(workItems.deletedAt),
          or(isNotNull(workItems.startAt), isNotNull(workItems.dueAt)),
          or(isNull(workItems.startAt), lte(workItems.startAt, windowEnd)),
          or(isNull(workItems.dueAt), gte(workItems.dueAt, windowStart)),
        ),
      )
      .limit(MAX_LOAD_ITEMS);
  }

  /**
   * Remaining estimate minutes by work item id, for the given items only (53-08, R21-b / 0309).
   *
   * The map keeps its name and shape, but the value is what is LEFT, not the original estimate:
   * `effectiveRemaining` — the manual override when set, else `max(0, estimate − logged)`, the logged
   * sum read from `work_item_time_logs` in one grouped statement per chunk. A fully (or over-)
   * logged item without an override contributes 0 minutes, so it adds 0 h to the planned load.
   */
  async estimatesFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < workItemIds.length; i += ESTIMATE_CHUNK) {
      const chunk = workItemIds.slice(i, i + ESTIMATE_CHUNK);
      const rows = await tenantDrizzle(runner)
        .select({
          workItemId: workItemEstimates.workItemId,
          estimateMinutes: workItemEstimates.estimateMinutes,
          remainingMinutes: workItemEstimates.remainingMinutes,
        })
        .from(workItemEstimates)
        .where(
          and(
            eq(workItemEstimates.organizationId, context.organizationId),
            inArray(workItemEstimates.workItemId, chunk),
          ),
        );
      if (rows.length === 0) continue;
      const logged = await tenantDrizzle(runner)
        .select({
          workItemId: workItemTimeLogs.workItemId,
          total: sql<string | null>`sum(${workItemTimeLogs.minutes})`,
        })
        .from(workItemTimeLogs)
        .where(
          and(
            eq(workItemTimeLogs.organizationId, context.organizationId),
            inArray(
              workItemTimeLogs.workItemId,
              rows.map((row) => row.workItemId),
            ),
          ),
        )
        .groupBy(workItemTimeLogs.workItemId);
      const loggedById = new Map(
        logged.map((row) => [row.workItemId, row.total == null ? 0 : Number(row.total)] as const),
      );
      for (const row of rows) {
        const remaining = effectiveRemaining({
          estimateMinutes: Number(row.estimateMinutes),
          remainingMinutes: row.remainingMinutes == null ? null : Number(row.remainingMinutes),
          loggedMinutes: loggedById.get(row.workItemId) ?? 0,
        });
        out.set(row.workItemId, remaining.remainingMinutes);
      }
    }
    return out;
  }

  /** The member's capacity row, if any. */
  async capacityFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<PersonCapacityRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(personCapacity)
      .where(
        and(
          eq(personCapacity.organizationId, context.organizationId),
          eq(personCapacity.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The member's allocations overlapping `[from, to]` (the heatmap's bounded read, filtered). */
  async allocationsFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    from: string,
    to: string,
  ): Promise<readonly PersonAllocationRow[]> {
    const rows = await this.heatmap.listAllocationsInWindow(runner, context, from, to);
    return rows.filter((row) => row.membershipId === membershipId);
  }

  async timeOffFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    personUserId: string,
    from: string,
    to: string,
  ): Promise<readonly PersonTimeOffRow[]> {
    return this.timeOff.listForPerson(runner, context, personUserId, { from, to });
  }

  /** The organization's working calendar (53-02), else the default calendar in the org's zone. */
  async orgCalendar(runner: TenantQueryRunner, context: TenantContext): Promise<WorkingCalendar> {
    const org = await this.calendars.findCalendar(runner, context, null);
    if (org === null) {
      return defaultWorkingCalendar(await this.calendars.organizationTimeZone(runner, context));
    }
    const holidays = (await this.calendars.listHolidays(runner, context, org.id)).map(
      (h) => h.date,
    );
    return {
      workingDaysMask: Number(org.workingDaysMask),
      dayStart: String(org.dayStart),
      dayEnd: String(org.dayEnd),
      timeZone: org.timeZone,
      holidays: new Set(holidays),
    };
  }
}
