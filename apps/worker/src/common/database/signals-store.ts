import {
  MS_PER_DAY,
  SIGNAL_DEDUPE_WINDOW_MS,
  UNUSUAL_EXPENSE_BASELINE_DAYS,
  UNUSUAL_EXPENSE_RECENT_DAYS,
  signalDay,
  uuidv7,
} from '@tmanage/domain';
import type { StoredSignalSetting } from '@tmanage/domain';
import {
  BUSINESS_BRIEFING_FLAG,
  WORK_SIGNAL_RAISED_EVENT,
  subjectKey,
} from '../../jobs/signals-sweeper.js';
import type {
  OrganizationSignalFacts,
  SignalsSweepStore,
  SweepRecord,
} from '../../jobs/signals-sweeper.js';
import { organizationsWithFlagOn } from './feature-flag-store.js';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

/**
 * 62-27 (0380) — the SQL behind `jobs/signals-sweeper.ts`, as `tmanage_worker`. Every statement
 * names the organization and binds every value; every date bound is computed from the run's `now`.
 * Each fact read is capped at {@link SIGNAL_FACTS_LIMIT} rows; what is cut is read next hour.
 *
 * Grants: SELECT on `work_items`, `work_item_estimates`, `work_item_time_logs`, `timesheets`,
 * `projects`, `person_capacity`, `memberships`, `client_invoices`, `project_budgets`, `expenses`,
 * `approvals`, `work_signal_settings`; SELECT, INSERT, UPDATE on `work_signals`; INSERT, UPDATE
 * on `work_signal_sweeps`; INSERT on `outbox_events`; and the flag reads of
 * `feature-flag-store.ts`.
 */

export const SIGNAL_FACTS_LIMIT = 5_000;

const LIVE_PROJECT = `JOIN projects p ON p.organization_id = x.organization_id AND p.id = x.project_id
        AND p.archived_at IS NULL`;

export const SIGNALS_SQL = {
  settings: `SELECT rule_key, enabled, threshold, recipient FROM work_signal_settings
   WHERE organization_id = ?`,
  workItems: `SELECT x.id, x.project_id, x.state, x.due_at, x.updated_at, x.owner_user_id,
       e.estimate_minutes,
       (SELECT COALESCE(SUM(l.minutes), 0) FROM work_item_time_logs l
         WHERE l.organization_id = x.organization_id AND l.work_item_id = x.id) AS logged_minutes
  FROM work_items x
  ${LIVE_PROJECT}
  LEFT JOIN work_item_estimates e ON e.organization_id = x.organization_id AND e.work_item_id = x.id
 WHERE x.organization_id = ? AND x.deleted_at IS NULL
   AND x.state IN ('backlog', 'ready', 'in_progress', 'blocked', 'internal_review')
 ORDER BY x.id
 LIMIT ?`,
  capacities: `SELECT m.id AS membership_id, m.user_id, pc.weekly_hours
  FROM person_capacity pc
  JOIN memberships m ON m.organization_id = pc.organization_id AND m.id = pc.membership_id
 WHERE pc.organization_id = ? AND m.status = 'active' AND pc.effective_from <= ?
 ORDER BY m.id
 LIMIT ?`,
  invoices: `SELECT id, project_id, state, DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date,
       total_minor, paid_minor
  FROM client_invoices
 WHERE organization_id = ? AND state IN ('sent', 'partially_paid') AND due_date < ?
 ORDER BY id
 LIMIT ?`,
  budgets: `SELECT x.project_id, x.budget_type, x.budget_minutes, x.budget_amount_minor,
       x.used_minutes_cache, x.used_amount_cache_minor
  FROM project_budgets x
  ${LIVE_PROJECT}
 WHERE x.organization_id = ?
 ORDER BY x.project_id
 LIMIT ?`,
  expenses: `SELECT id, project_id, state, DATE_FORMAT(spent_on, '%Y-%m-%d') AS spent_on, category,
       amount_base_minor
  FROM expenses
 WHERE organization_id = ? AND amount_base_minor IS NOT NULL AND spent_on >= ?
   AND state IN ('submitted', 'approved', 'invoiced', 'locked')
 ORDER BY spent_on DESC, id
 LIMIT ?`,
  approvals: `SELECT x.id, x.project_id, x.state, x.created_at
  FROM approvals x
  ${LIVE_PROJECT}
 WHERE x.organization_id = ? AND x.state IN ('requested', 'viewed') AND x.created_at <= ?
 ORDER BY x.id
 LIMIT ?`,
  uninvoicedTime: `SELECT x.project_id, COALESCE(SUM(x.minutes), 0) AS minutes,
       DATE_FORMAT(MIN(x.spent_on), '%Y-%m-%d') AS oldest_spent_on
  FROM work_item_time_logs x
  JOIN timesheets t ON t.organization_id = x.organization_id AND t.id = x.timesheet_id
  ${LIVE_PROJECT}
 WHERE x.organization_id = ? AND x.billable = 1 AND x.invoice_line_id IS NULL
   AND t.state = 'approved'
 GROUP BY x.project_id
 ORDER BY x.project_id
 LIMIT ?`,
  lastRaised: `SELECT rule_key, subject_id, MAX(raised_at) AS last_raised_at
  FROM work_signals
 WHERE organization_id = ? AND raised_at > ?
 GROUP BY rule_key, subject_id`,
  insertSignal: `INSERT IGNORE INTO work_signals
   (id, organization_id, rule_key, subject_type, subject_id, project_id, signal_day, measure,
    threshold, notify, raised_at, seen_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  // A held condition: its latest row (raised inside the 24 h window) is seen by this sweep.
  touchSignal: `UPDATE work_signals SET measure = ?, threshold = ?, seen_at = ?
 WHERE organization_id = ? AND rule_key = ? AND subject_id = ? AND raised_at > ?`,
  stampSweep: `INSERT INTO work_signal_sweeps (id, organization_id, swept_at) VALUES (?, ?, ?)
 ON DUPLICATE KEY UPDATE swept_at = VALUES(swept_at)`,
  insertEvent: `INSERT INTO outbox_events
   (id, organization_id, type, schema_version, aggregate_type, aggregate_id, payload_json,
    correlation_id, occurred_at, available_at)
 VALUES (?, ?, ?, 1, 'work_signal', ?, ?, ?, ?, ?)`,
} as const;

type Row = Readonly<Record<string, unknown>>;

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : num(value);
const str = (value: unknown): string => String(value);
const strOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const date = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const dateOrNull = (value: unknown): Date | null =>
  value === null || value === undefined ? null : date(value);
const bool = (value: unknown): boolean => value === true || value === 1 || value === '1';
const dayBefore = (now: Date, days: number): string =>
  signalDay(new Date(now.getTime() - days * MS_PER_DAY));

/** Read one organization's facts at `now`. */
export async function readSignalFacts(
  tx: WorkerTransaction,
  organizationId: string,
  now: Date,
): Promise<OrganizationSignalFacts> {
  const rows = (sql: string, params: readonly unknown[]) =>
    tx.query<readonly Row[]>(sql, [organizationId, ...params]);
  const today = signalDay(now);
  const workItems = await rows(SIGNALS_SQL.workItems, [SIGNAL_FACTS_LIMIT]);
  const capacities = await rows(SIGNALS_SQL.capacities, [today, SIGNAL_FACTS_LIMIT]);
  const invoices = await rows(SIGNALS_SQL.invoices, [today, SIGNAL_FACTS_LIMIT]);
  const budgets = await rows(SIGNALS_SQL.budgets, [SIGNAL_FACTS_LIMIT]);
  const expenses = await rows(SIGNALS_SQL.expenses, [
    dayBefore(now, UNUSUAL_EXPENSE_BASELINE_DAYS + UNUSUAL_EXPENSE_RECENT_DAYS),
    SIGNAL_FACTS_LIMIT,
  ]);
  const approvals = await rows(SIGNALS_SQL.approvals, [
    new Date(now.getTime() - MS_PER_DAY),
    SIGNAL_FACTS_LIMIT,
  ]);
  const uninvoiced = await rows(SIGNALS_SQL.uninvoicedTime, [SIGNAL_FACTS_LIMIT]);
  return {
    workItems: workItems.map((r) => ({
      workItemId: str(r['id']),
      projectId: str(r['project_id']),
      state: str(r['state']),
      dueAt: dateOrNull(r['due_at']),
      updatedAt: date(r['updated_at']),
      ownerUserId: strOrNull(r['owner_user_id']),
      estimateMinutes: numOrNull(r['estimate_minutes']),
      loggedMinutes: num(r['logged_minutes']),
    })),
    capacities: capacities.map((r) => ({
      membershipId: str(r['membership_id']),
      userId: str(r['user_id']),
      weeklyMinutes: Math.round(num(r['weekly_hours']) * 60),
    })),
    invoices: invoices.map((r) => ({
      invoiceId: str(r['id']),
      projectId: strOrNull(r['project_id']),
      state: str(r['state']),
      dueDate: strOrNull(r['due_date']),
      totalMinor: num(r['total_minor']),
      paidMinor: num(r['paid_minor']),
    })),
    budgets: budgets.map((r) => ({
      projectId: str(r['project_id']),
      budgetType: str(r['budget_type']),
      budgetMinutes: numOrNull(r['budget_minutes']),
      budgetAmountMinor: numOrNull(r['budget_amount_minor']),
      usedMinutes: num(r['used_minutes_cache']),
      usedAmountMinor: num(r['used_amount_cache_minor']),
    })),
    expenses: expenses.map((r) => ({
      expenseId: str(r['id']),
      projectId: strOrNull(r['project_id']),
      state: str(r['state']),
      spentOn: str(r['spent_on']),
      category: str(r['category']),
      amountBaseMinor: num(r['amount_base_minor']),
    })),
    approvals: approvals.map((r) => ({
      approvalId: str(r['id']),
      projectId: str(r['project_id']),
      state: str(r['state']),
      requestedAt: date(r['created_at']),
    })),
    uninvoicedTime: uninvoiced.map((r) => ({
      projectId: str(r['project_id']),
      minutes: num(r['minutes']),
      oldestSpentOn: strOrNull(r['oldest_spent_on']),
    })),
  };
}

/**
 * Record one sweep: file the new signals (a notifying one also writes its outbox event), move the
 * held ones on, stamp the sweep time. Run inside one transaction. Returns the rows filed.
 */
export async function recordSweep(
  tx: WorkerTransaction,
  organizationId: string,
  sweep: SweepRecord,
  now: Date,
): Promise<number> {
  let written = 0;
  const day = signalDay(now);
  const windowStart = new Date(now.getTime() - SIGNAL_DEDUPE_WINDOW_MS);
  for (const held of sweep.held) {
    await tx.query(SIGNALS_SQL.touchSignal, [
      Math.trunc(held.measure),
      held.threshold,
      now,
      organizationId,
      held.rule,
      held.subjectId,
      windowStart,
    ]);
  }
  for (const signal of sweep.filed) {
    const id = uuidv7();
    const result = await tx.query<{ readonly affectedRows: number }>(SIGNALS_SQL.insertSignal, [
      id,
      organizationId,
      signal.rule,
      signal.subjectType,
      signal.subjectId,
      signal.projectId,
      day,
      Math.trunc(signal.measure),
      signal.threshold,
      signal.notify ? 1 : 0,
      now,
      now,
    ]);
    if (result.affectedRows !== 1) continue;
    written += 1;
    if (!signal.notify) continue;
    await tx.query(SIGNALS_SQL.insertEvent, [
      uuidv7(),
      organizationId,
      WORK_SIGNAL_RAISED_EVENT,
      id,
      JSON.stringify({ signalId: id, rule: signal.rule }),
      uuidv7(),
      now,
      now,
    ]);
  }
  await tx.query(SIGNALS_SQL.stampSweep, [uuidv7(), organizationId, now]);
  return written;
}

export function createSignalsStore(
  database: WorkerDatabase,
  env: NodeJS.ProcessEnv = process.env,
): SignalsSweepStore {
  return {
    organizations: (limit) =>
      database.read((tx) => organizationsWithFlagOn(tx, BUSINESS_BRIEFING_FLAG, limit, env)),
    settings: (organizationId) =>
      database.read(async (tx) =>
        (await tx.query<readonly Row[]>(SIGNALS_SQL.settings, [organizationId])).map(
          (r): StoredSignalSetting => ({
            rule: str(r['rule_key']),
            enabled: bool(r['enabled']),
            threshold: num(r['threshold']),
            recipient: str(r['recipient']),
          }),
        ),
      ),
    facts: (organizationId, now) => database.read((tx) => readSignalFacts(tx, organizationId, now)),
    lastRaised: (organizationId, now) =>
      database.read(async (tx) => {
        const since = new Date(now.getTime() - SIGNAL_DEDUPE_WINDOW_MS);
        const rows = await tx.query<readonly Row[]>(SIGNALS_SQL.lastRaised, [
          organizationId,
          since,
        ]);
        return new Map(
          rows.map((r) => [
            subjectKey(str(r['rule_key']), str(r['subject_id'])),
            date(r['last_raised_at']),
          ]),
        );
      }),
    record: (organizationId, sweep, now) =>
      database.transaction((tx) => recordSweep(tx, organizationId, sweep, now)),
  };
}
