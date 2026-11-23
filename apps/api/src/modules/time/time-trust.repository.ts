import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItemTimeLogs } from '../../common/database/schema.js';
import type { WorkItemTimeLogRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Time trust (0410) — the approval-side statements on `work_item_time_logs`. Every statement binds
 * the caller's `organization_id` (DA-12); no input names an organization. New rows (corrections)
 * are not inserted here: the service hands them to `WorkTimeLogsRepository.create`, the one insert
 * (rate snapshots, billable default).
 *
 * Concurrency (DA-1): a decision is a conditional UPDATE `… WHERE approval_state = 'pending'`, so
 * two managers deciding at once cannot both win (lost update); the loser reads 0 rows and gets a
 * 409. A supersede is conditional on `superseded_by IS NULL` for the same reason.
 */

/** The most entries the approval queue returns in one read. */
export const MAX_APPROVAL_QUEUE = 200;

export interface DecisionPatch {
  readonly approvalState: 'approved' | 'rejected';
  readonly counted: boolean;
  readonly decidedBy: string;
  readonly decidedAt: Date;
  readonly decisionNote: string | null;
}

export class TimeTrustRepository {
  /** One entry by id, tenant-scoped; `lock` takes the row lock for a decision. */
  async findEntry(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    lock = false,
  ): Promise<WorkItemTimeLogRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.id, id),
        ),
      )
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  /** Entries waiting for a decision, oldest day first. The service filters what the caller may decide. */
  async listPending(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit = MAX_APPROVAL_QUEUE,
  ): Promise<readonly WorkItemTimeLogRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.approvalState, 'pending'),
        ),
      )
      .orderBy(asc(workItemTimeLogs.spentOn), asc(workItemTimeLogs.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_APPROVAL_QUEUE));
  }

  /** The corrections asked for on one entry, oldest first. */
  async correctionsOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    entryId: string,
  ): Promise<readonly WorkItemTimeLogRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemTimeLogs)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.correctsEntryId, entryId),
        ),
      )
      .orderBy(asc(workItemTimeLogs.createdAt), asc(workItemTimeLogs.id))
      .limit(50);
  }

  /**
   * Record a decision on a still-pending, unlocked entry. Returns the rows changed (0 = lost race).
   * `updated_at` stays as it was: a decision is not an edit (the "Edited" badge means the minutes,
   * day, note or billable flag changed after the entry was written).
   */
  async decide(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    patch: DecisionPatch,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(workItemTimeLogs)
      .set(patch)
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.id, id),
          eq(workItemTimeLogs.approvalState, 'pending'),
          isNull(workItemTimeLogs.lockedAt),
        ),
      );
    return result[0].affectedRows;
  }

  /**
   * An approved correction replaces the measured entry in every total: the original stops counting
   * and names its correction; it stays in the history. Returns the rows changed.
   */
  async supersede(
    runner: TenantQueryRunner,
    context: TenantContext,
    originalId: string,
    correctionId: string,
    by: string,
    at: Date,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(workItemTimeLogs)
      .set({ supersededBy: correctionId, counted: false, decidedBy: by, decidedAt: at })
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.id, originalId),
          isNull(workItemTimeLogs.supersededBy),
          isNull(workItemTimeLogs.lockedAt),
        ),
      );
    return result[0].affectedRows;
  }

  /**
   * The owner changed how pending hand time counts: rewrite the stored answer of every pending,
   * unlocked hand entry (not corrections, not capped timers: those never count before approval).
   */
  async recountPendingHand(
    runner: TenantQueryRunner,
    context: TenantContext,
    counted: boolean,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(workItemTimeLogs)
      .set({ counted })
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          eq(workItemTimeLogs.approvalState, 'pending'),
          eq(workItemTimeLogs.source, 'manual'),
          isNull(workItemTimeLogs.lockedAt),
          sql`${workItemTimeLogs.counted} <> ${counted ? 1 : 0}`,
        ),
      );
    return result[0].affectedRows;
  }
}
