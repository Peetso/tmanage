import type { ApprovalChainStore, ChainRecordRow } from '../../jobs/approval-chain-walk.js';
import { incrementOrganizationSignal } from './security-signal-store.js';
import type { WorkerDatabase } from './worker-database.js';

/**
 * 52-19 (0349) — the SQL behind `jobs/approval-chain-walk.ts`, as `tmanage_worker`: SELECT on
 * `approval_records` (scripts/db/users.sql); the break signal goes through the security-signal
 * store's `incrementOrganizationSignal` (existing 56-23 grant). Every record read names one
 * organization; the one cross-tenant read is the organization list. Nothing here writes a record.
 */

const ORGANIZATIONS_SQL = `SELECT DISTINCT organization_id FROM approval_records`;

const RECORDS_SQL = `SELECT record_no, record_hash, previous_record_hash, record_json, signature,
    approval_id, deliverable_version_id, approver_user_id, approver_kind, decision
   FROM approval_records
  WHERE organization_id = ? AND record_no > ?
  ORDER BY record_no
  LIMIT ?`;

interface RecordDbRow {
  readonly record_no: number | string;
  readonly record_hash: string;
  readonly previous_record_hash: string;
  readonly record_json: string;
  readonly signature: string | null;
  readonly approval_id: string;
  readonly deliverable_version_id: string;
  readonly approver_user_id: string;
  readonly approver_kind: string;
  readonly decision: string;
}

const recordOf = (row: RecordDbRow): ChainRecordRow => ({
  recordNo: Number(row.record_no),
  recordHash: String(row.record_hash),
  previousRecordHash: String(row.previous_record_hash),
  recordJson: String(row.record_json),
  signature: row.signature === null ? null : String(row.signature),
  approvalId: String(row.approval_id),
  deliverableVersionId: String(row.deliverable_version_id),
  approverUserId: String(row.approver_user_id),
  approverKind: String(row.approver_kind),
  decision: String(row.decision),
});

export function createApprovalChainStore(database: WorkerDatabase): ApprovalChainStore {
  return {
    organizations: () =>
      database.read(async (tx) => {
        const rows =
          await tx.query<readonly { readonly organization_id: string }[]>(ORGANIZATIONS_SQL);
        return rows.map((row) => String(row.organization_id));
      }),
    records: (organizationId, afterRecordNo, limit) =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly RecordDbRow[]>(RECORDS_SQL, [
          organizationId,
          afterRecordNo,
          limit,
        ]);
        return rows.map(recordOf);
      }),
    recordBreak: (signal) =>
      incrementOrganizationSignal(database, {
        id: signal.id,
        organizationId: signal.organizationId,
        ruleKey: signal.ruleKey,
        severity: signal.severity,
        sourceHash: signal.sourceHash,
        count: signal.count,
        seenAt: signal.seenAt,
        details: { breakRecordNo: signal.breakRecordNo, reason: signal.reason },
      }),
  };
}
