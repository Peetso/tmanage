import { assertSafeAuditMetadata, uuidv7 } from '@tmanage/domain';
import {
  BUDGET_THRESHOLD_NOTICE,
  budgetAlertRecipients,
  decideBurnAlert,
} from '../../jobs/budget-burn-sweeper.js';
import type { BudgetBurnStore, BudgetToSweep } from '../../jobs/budget-burn-sweeper.js';
import { insertNotification, listActiveInternalMemberships } from './notifications-store.js';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

/**
 * 52-05 (0291) — the SQL behind `jobs/budget-burn-sweeper.ts`, as `tmanage_worker`: SELECT, UPDATE
 * on `project_budgets`; SELECT on `work_item_time_logs`, `memberships`, `project_memberships`,
 * `custom_roles`; SELECT, INSERT on `budget_alert_events`; INSERT on `notifications` and
 * `audit_events`. The used figures are the API's (`budget-burn.repository.ts`): every minute, and
 * money as `SUM(rate_snapshot_minor * minutes) / 60` over billable entries.
 */

// The one cross-tenant read: which budgets are due, stalest cache first. Every later statement
// names the budget's own organization.
const LIST_BUDGETS = `SELECT organization_id, project_id
  FROM project_budgets
 ORDER BY cache_refreshed_at IS NOT NULL, cache_refreshed_at, id
 LIMIT ?`;

const LOCK_BUDGET = `SELECT budget_type, budget_minutes, budget_amount_minor, alert_thresholds,
       last_alert_bp
  FROM project_budgets
 WHERE organization_id = ? AND project_id = ?
 FOR UPDATE`;

const SUM_USED = `SELECT COALESCE(SUM(minutes), 0) AS used_minutes,
       COALESCE(FLOOR(SUM(CASE WHEN billable = 1 THEN rate_snapshot_minor * minutes ELSE 0 END) / 60), 0)
         AS used_amount
  FROM work_item_time_logs
 WHERE organization_id = ? AND project_id = ?`;

const INSERT_EVENT = `INSERT INTO budget_alert_events
   (id, organization_id, project_id, threshold_bp, used_bp, notified_to, created_at)
 VALUES (?, ?, ?, ?, ?, ?, NOW(3))`;

const INSERT_AUDIT = `INSERT INTO audit_events
   (id, organization_id, actor_user_id, effective_actor_id, action, object_type, object_id,
    result, correlation_id, metadata_json, created_at)
 VALUES (?, ?, NULL, NULL, 'budget.alert_raised', 'project', ?, 'allowed', ?, ?, NOW(3))`;

// `updated_at = updated_at`: a refresh is not a save.
const STORE_CACHE = `UPDATE project_budgets
   SET used_minutes_cache = ?, used_amount_cache_minor = ?, cache_refreshed_at = NOW(3),
       last_alert_bp = ?, updated_at = updated_at
 WHERE organization_id = ? AND project_id = ?`;

interface BudgetRow {
  readonly budget_type: string;
  readonly budget_minutes: number | null;
  readonly budget_amount_minor: number | string | null;
  readonly alert_thresholds: string;
  readonly last_alert_bp: number;
}

interface SumRow {
  readonly used_minutes: number | string;
  readonly used_amount: number | string;
}

/** One budget: refresh, decide, alert, remember. Returns whether an alert was raised. */
export async function sweepOneBudget(
  tx: WorkerTransaction,
  budget: BudgetToSweep,
): Promise<boolean> {
  const org = budget.organizationId;
  const rows = await tx.query<readonly BudgetRow[]>(LOCK_BUDGET, [org, budget.projectId]);
  const row = rows[0];
  if (row === undefined) return false;
  const sums = await tx.query<readonly SumRow[]>(SUM_USED, [org, budget.projectId]);
  const usedMinutes = Number(sums[0]?.used_minutes ?? 0);
  const usedAmountMinor = Number(sums[0]?.used_amount ?? 0);
  const decision = decideBurnAlert({
    budgetType: row.budget_type,
    budgetMinutes: row.budget_minutes === null ? null : Number(row.budget_minutes),
    budgetAmountMinor: row.budget_amount_minor === null ? null : Number(row.budget_amount_minor),
    alertThresholds: row.alert_thresholds,
    lastAlertBp: Number(row.last_alert_bp),
    usedMinutes,
    usedAmountMinor,
  });

  if (decision.raiseBp !== null) {
    const recipients = budgetAlertRecipients(
      await listActiveInternalMemberships(tx, org, budget.projectId),
    );
    const eventId = uuidv7();
    await tx.query(INSERT_EVENT, [
      eventId,
      org,
      budget.projectId,
      decision.raiseBp,
      decision.burn.percentBp,
      JSON.stringify(recipients),
    ]);
    for (const recipientUserId of recipients) {
      await insertNotification(tx, {
        organizationId: org,
        recipientUserId,
        type: BUDGET_THRESHOLD_NOTICE,
        objectType: 'project',
        objectId: budget.projectId,
        dedupeKey: `budget.threshold:${eventId}`,
      });
    }
    const metadata = {
      budget_alert_event_id: eventId,
      threshold_bp: decision.raiseBp,
      used_bp: decision.burn.percentBp,
      recipient_count: recipients.length,
    };
    assertSafeAuditMetadata(metadata);
    await tx.query(INSERT_AUDIT, [
      uuidv7(),
      org,
      budget.projectId,
      uuidv7(),
      JSON.stringify(metadata),
    ]);
  }

  await tx.query(STORE_CACHE, [
    usedMinutes,
    usedAmountMinor,
    decision.lastAlertBp,
    org,
    budget.projectId,
  ]);
  return decision.raiseBp !== null;
}

export function createBudgetBurnStore(database: WorkerDatabase): BudgetBurnStore {
  return {
    listBudgets: (limit) =>
      database.read(async (tx) => {
        const rows = await tx.query<
          readonly { readonly organization_id: string; readonly project_id: string }[]
        >(LIST_BUDGETS, [Math.max(1, Math.trunc(limit))]);
        return rows.map((r) => ({ organizationId: r.organization_id, projectId: r.project_id }));
      }),
    sweepBudget: (budget) => database.transaction((tx) => sweepOneBudget(tx, budget)),
  };
}
