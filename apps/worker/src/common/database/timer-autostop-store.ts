import { assertSafeAuditMetadata, uuidv7 } from '@tmanage/domain';
import { sweepForgottenTimers } from '../../jobs/timer-autostop.js';
import type {
  AutostopEntry,
  AutostopResult,
  RunningTimer,
  TimerAutostopStore,
} from '../../jobs/timer-autostop.js';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

/**
 * 52-01 (0265) — the SQL behind `jobs/timer-autostop.ts`, as `tmanage_worker`: SELECT + DELETE on
 * `time_timers`, SELECT on `org_policies` / `org_finance_profiles` / `work_items`, INSERT on
 * `work_item_time_logs` and `audit_events`. The timer is deleted first and only a delete that
 * removed it files the entry, so a retry or a racing manual stop never yields a second entry.
 */

const SELECT_CANDIDATES = `SELECT t.id, t.organization_id, t.membership_id, t.user_id, t.work_item_id,
       t.project_id, t.note, t.billable, t.started_at, p.policy_json, f.rounding_minutes
  FROM time_timers t
  LEFT JOIN org_policies p ON p.organization_id = t.organization_id
  LEFT JOIN org_finance_profiles f ON f.organization_id = t.organization_id
 WHERE t.started_at <= ?
 ORDER BY t.started_at, t.id
 LIMIT ?`;

const DELETE_TIMER = `DELETE FROM time_timers WHERE organization_id = ? AND id = ?`;

// The work item is re-read: a purged item files the entry unsorted instead of failing the FK.
const INSERT_ENTRY = `INSERT INTO work_item_time_logs
   (id, organization_id, work_item_id, project_id, logged_by, minutes, spent_on, started_at,
    ended_at, billable, source, needs_review, note, created_at)
 VALUES (?, ?, (SELECT w.id FROM work_items w WHERE w.organization_id = ? AND w.id = ?), ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, NOW(3))`;

const INSERT_AUDIT = `INSERT INTO audit_events
   (id, organization_id, actor_user_id, effective_actor_id, action, object_type, object_id,
    result, correlation_id, metadata_json, created_at)
 VALUES (?, ?, NULL, NULL, 'time_timer.auto_stopped', 'time_timer', ?, 'allowed', ?, ?, NOW(3))`;

interface CandidateRow {
  readonly id: string;
  readonly organization_id: string;
  readonly membership_id: string;
  readonly user_id: string;
  readonly work_item_id: string | null;
  readonly project_id: string | null;
  readonly note: string | null;
  readonly billable: number | boolean;
  readonly started_at: Date;
  readonly policy_json: unknown;
  readonly rounding_minutes: number | null;
}

interface WriteResult {
  readonly affectedRows: number;
}

export async function autostopTimer(
  tx: WorkerTransaction,
  timer: RunningTimer,
  entry: AutostopEntry,
): Promise<boolean> {
  const deleted = await tx.query<WriteResult>(DELETE_TIMER, [timer.organizationId, timer.id]);
  if (deleted.affectedRows === 0) return false;
  const entryId = uuidv7();
  await tx.query(INSERT_ENTRY, [
    entryId,
    timer.organizationId,
    timer.organizationId,
    timer.workItemId,
    timer.projectId,
    timer.membershipId,
    entry.minutes,
    entry.spentOn,
    timer.startedAt,
    entry.endedAt,
    timer.billable ? 1 : 0,
    entry.source,
    entry.needsReview ? 1 : 0,
    timer.note,
  ]);
  const metadata = { time_log_id: entryId, autostop_hours: entry.autostopHours };
  assertSafeAuditMetadata(metadata);
  await tx.query(INSERT_AUDIT, [
    uuidv7(),
    timer.organizationId,
    timer.id,
    uuidv7(),
    JSON.stringify(metadata),
  ]);
  return true;
}

export function createTimerAutostopStore(database: WorkerDatabase): TimerAutostopStore {
  return {
    listCandidates: (startedBefore, limit) =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly CandidateRow[]>(SELECT_CANDIDATES, [
          startedBefore,
          Math.max(1, Math.trunc(limit)),
        ]);
        return rows.map((row) => ({
          id: row.id,
          organizationId: row.organization_id,
          membershipId: row.membership_id,
          userId: row.user_id,
          workItemId: row.work_item_id,
          projectId: row.project_id,
          note: row.note,
          billable: Boolean(row.billable),
          startedAt: new Date(row.started_at),
          policy: row.policy_json,
          roundingMinutes: row.rounding_minutes === null ? null : Number(row.rounding_minutes),
        }));
      }),
    autostop: (timer, entry) => database.transaction((tx) => autostopTimer(tx, timer, entry)),
  };
}

/** `--autostop-timers`: one pass over the worker's pool. */
export function runTimerAutostop(
  database: WorkerDatabase,
  now = new Date(),
): Promise<AutostopResult> {
  return sweepForgottenTimers(createTimerAutostopStore(database), now);
}
