import { uuidv7 } from '@tmanage/domain';
import type { WorkerDatabase } from './worker-database.js';
import {
  SECURITY_REPORT_PURGE_ACTION,
  SECURITY_REPORT_RETENTION_MONTHS,
  SYSTEM_ACTOR_EMAIL,
  SYSTEM_ACTOR_ID,
  type SecurityReportPurgeStore,
} from '../../jobs/security-report-purge.js';

/**
 * 56-17 follow-up: the security-report purge's statements, over the worker's pool.
 * `tmanage_worker` holds SELECT and DELETE on `security_reports` and INSERT on
 * `platform_admin_audit_events` (scripts/db/users.sql). The bound is always a bound JS Date.
 */

const LIST_EXPIRED = `SELECT id FROM security_reports
 WHERE created_at < ? AND id > ?
 ORDER BY id LIMIT ?`;

const PLATFORM_AUDIT = `INSERT INTO platform_admin_audit_events
   (id, actor_user_id, actor_email, action, target_type, target_id, target_label,
    organization_id, reason, correlation_id, created_at, support_session_id, before_json,
    after_json, ip, user_agent)
 VALUES (?, ?, ?, ?, 'security_report', NULL, NULL, NULL, ?, ?, current_timestamp(3), NULL, NULL,
         ?, NULL, NULL)`;

export function createSecurityReportPurgeStore(database: WorkerDatabase): SecurityReportPurgeStore {
  return {
    listExpired: (cutoff, afterId, limit) =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly { id: string }[]>(LIST_EXPIRED, [
          cutoff,
          afterId ?? '',
          Math.max(1, Math.trunc(limit)),
        ]);
        return rows.map((row) => row.id);
      }),
    deleteExpired: (ids, cutoff) =>
      ids.length === 0
        ? Promise.resolve(0)
        : database.transaction(async (tx) => {
            const result = await tx.query<{ affectedRows: number }>(
              `DELETE FROM security_reports WHERE id IN (${ids.map(() => '?').join(', ')})
                 AND created_at < ?`,
              [...ids, cutoff],
            );
            return result.affectedRows;
          }),
    audit: (deleted, cutoff) =>
      database.transaction(async (tx) => {
        await tx.query(PLATFORM_AUDIT, [
          uuidv7(),
          SYSTEM_ACTOR_ID,
          SYSTEM_ACTOR_EMAIL,
          SECURITY_REPORT_PURGE_ACTION,
          `retention ${String(SECURITY_REPORT_RETENTION_MONTHS)} months`,
          uuidv7(),
          JSON.stringify({ deleted, before: cutoff.toISOString() }),
        ]);
      }),
  };
}
