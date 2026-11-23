import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import type { TimeApprovalState } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { timeLogPricing, workItemTimeLogs } from '../../common/database/schema.js';
import type { WorkItemTimeLogRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { RatesRepository } from '../finance/rates.repository.js';
import { priceTimeLog } from '../finance/rates.service.js';
import type { TimeLogSource } from '../time/time-rules.js';

/**
 * Work item time logs — x231's storage half (Work module 7).
 *
 * Follows `WorkChecklistRepository`: `TenantContext` is the scoping parameter, no `organizationId`
 * on any input type (it comes from the context), and every read and write is bound to
 * `(organization_id, …)` so a caller in the wrong tenant sees nothing rather than a leak. The
 * repository holds no policy — the service decides who may read, write or delete, and the composite
 * foreign key of migration 0103 is what makes a cross-tenant `work_item_id` a non-existent pair.
 */

/** The largest time-log page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_TIME_LOG_PAGE = 500;

export interface CreateTimeLogInput {
  /** `null` files the entry in the project's unsorted bucket (52-01, 0265). */
  readonly workItemId: string | null;
  readonly loggedBy: string;
  readonly minutes: number;
  readonly spentOn: string;
  readonly note: string | null;
  /** 52-01 (0265). Copied from the work item, or the timer's project; `null` when neither. */
  readonly projectId?: string | null;
  readonly startedAt?: Date | null;
  readonly endedAt?: Date | null;
  /** Absent = 52-04 default: the work item's `billable`, else the project's `billable_default`. */
  readonly billable?: boolean;
  readonly source?: TimeLogSource;
  readonly needsReview?: boolean;
  /**
   * Time trust (0410). Absent = `none` / counted: measured time. Hand time and corrections pass the
   * state and the stored `entryCounts()` answer the time-trust rules decided.
   */
  readonly approvalState?: TimeApprovalState;
  readonly counted?: boolean;
  readonly reason?: string | null;
  readonly correctsEntryId?: string | null;
}

export class WorkTimeLogsRepository {
  /** 52-04 (0287). Reads the rate cards and cost rates for the snapshot taken at log time. */
  constructor(private readonly rates: RatesRepository = new RatesRepository()) {}

  /**
   * FIX-2026-11-10 (review L3): does the member already have `automatic` time inside
   * `[startedAt, endedAt)`? A manual timed entry over it would count the same hour twice.
   */
  async automaticOverlaps(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    startedAt: Date,
    endedAt: Date,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: workItemTimeLogs.id })
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.loggedBy, membershipId),
          eq(workItemTimeLogs.source, 'automatic'),
          lt(workItemTimeLogs.startedAt, endedAt),
          gt(workItemTimeLogs.endedAt, startedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** One time-log entry, scoped to the tenant and its parent work item; `null` if absent. */
  async findEntry(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    entryId: string,
  ): Promise<WorkItemTimeLogRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.workItemId, workItemId),
          eq(workItemTimeLogs.id, entryId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** One time-log entry by id alone (an unsorted entry has no work item), tenant-scoped. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    entryId: string,
  ): Promise<WorkItemTimeLogRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.id, entryId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The work item's time-log entries, newest day first (then id), bounded to one page. */
  async listForWorkItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    limit: number = MAX_TIME_LOG_PAGE,
  ): Promise<readonly WorkItemTimeLogRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.workItemId, workItemId),
        ),
      )
      .orderBy(desc(workItemTimeLogs.spentOn), desc(workItemTimeLogs.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_TIME_LOG_PAGE));
  }

  /** Insert one time-log entry and read it back so the caller sees the stored row. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateTimeLogInput,
  ): Promise<WorkItemTimeLogRow> {
    const id = uuidv7();
    // 52-04: price the hour now — sell rate (resolveRate) and the member's cost rate on `spent_on`.
    // A missing rate stays NULL, never 0; changing a rate later never rewrites this row.
    const pricing = await priceTimeLog(runner, context.organizationId, this.rates, {
      projectId: input.projectId ?? null,
      membershipId: input.loggedBy,
      spentOn: input.spentOn,
    });
    const itemBillable =
      input.billable === undefined && input.workItemId !== null
        ? await this.rates.workItemBillable(runner, context.organizationId, input.workItemId)
        : null;
    const billable = input.billable ?? itemBillable ?? pricing.billableDefault;

    await tenantDrizzle(runner)
      .insert(workItemTimeLogs)
      .values({
        id,
        organizationId: context.organizationId,
        workItemId: input.workItemId,
        projectId: input.projectId ?? null,
        loggedBy: input.loggedBy,
        minutes: input.minutes,
        spentOn: input.spentOn,
        startedAt: input.startedAt ?? null,
        endedAt: input.endedAt ?? null,
        billable,
        source: input.source ?? 'manual',
        needsReview: input.needsReview ?? false,
        approvalState: input.approvalState ?? 'none',
        counted: input.counted ?? true,
        reason: input.reason ?? null,
        correctsEntryId: input.correctsEntryId ?? null,
        note: input.note,
        createdAt: sql`current_timestamp(3)`,
      });
    if (pricing.rateSnapshotMinor !== null || pricing.costSnapshotMinor !== null) {
      await tenantDrizzle(runner)
        .update(timeLogPricing)
        .set({
          rateSnapshotMinor: pricing.rateSnapshotMinor,
          costSnapshotMinor: pricing.costSnapshotMinor,
          snapshotCurrency: pricing.snapshotCurrency,
        })
        .where(
          and(eq(timeLogPricing.organizationId, context.organizationId), eq(timeLogPricing.id, id)),
        );
    }

    const created = await this.findById(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('time-log entry vanished immediately after insert');
    }
    return created;
  }

  /** Delete one entry, scoped to the tenant and its parent; returns the rows affected. */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    entryId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.workItemId, workItemId),
          eq(workItemTimeLogs.id, entryId),
        ),
      );
  }
}
