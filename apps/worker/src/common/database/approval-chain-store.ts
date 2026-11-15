import type { ApprovalChainStore, ChainRecordRow } from '../../jobs/approval-chain-walk.js';
import { insertWorkerOutboxEvent } from './lifecycle-store.js';
import { incrementOrganizationSignal } from './security-signal-store.js';
import type { WorkerDatabase } from './worker-database.js';

/**
 * 52-19 (0349, 0355) — the SQL behind `jobs/approval-chain-walk.ts`, as `tmanage_worker`: SELECT on
 * `approval_records`; SELECT, INSERT, DELETE on `approval_chain_checks` (scripts/db/users.sql); a
 * broken verdict's `approval.chain_broken.v1` row goes into `outbox_events` (existing INSERT grant)
 * in the verdict's transaction; the break signal goes through the security-signal store's
 * `incrementOrganizationSignal` (existing 56-23 grant). Every record read names one organization;
 * the cross-tenant reads are the organization list and the newest verdict time. Nothing here
 * writes a record.
 */

const ORGANIZATIONS_SQL = `SELECT DISTINCT organization_id FROM approval_records`;

const RECORDS_SQL = `SELECT record_no, record_hash, previous_record_hash, record_json, signature,
    approval_id, deliverable_version_id, approver_user_id, approver_kind, decision
   FROM approval_records
  WHERE organization_id = ? AND record_no > ?
  ORDER BY record_no
  LIMIT ?`;

const LATEST_SQL = `SELECT MAX(checked_at) AS latest FROM approval_chain_checks`;

const INSERT_SQL = `INSERT INTO approval_chain_checks
   (id, organization_id, checked_at, status, records, break_record_no, break_reason)
 VALUES (?, ?, ?, ?, ?, ?, ?)`;

const PRUNE_SQL = `DELETE FROM approval_chain_checks WHERE checked_at < ?`;

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value : new Date(String(value).replace(' ', 'T') + 'Z');
  return Number.isNaN(at.getTime()) ? null : at;
}

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
    latestCheckedAt: () =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly { readonly latest: unknown }[]>(LATEST_SQL);
        return toDate(rows[0]?.latest);
      }),
    recordVerdict: (check) =>
      database.transaction(async (tx) => {
        await tx.query(INSERT_SQL, [
          check.id,
          check.organizationId,
          check.checkedAt,
          check.status,
          check.records,
          check.breakRecordNo,
          check.reason,
        ]);
        if (check.status !== 'broken' || check.breakRecordNo === null || check.reason === null) {
          return;
        }
        await insertWorkerOutboxEvent(tx, {
          organizationId: check.organizationId,
          type: 'approval.chain_broken.v1',
          aggregateId: check.id,
          payload: {
            checkId: check.id,
            breakRecordNo: check.breakRecordNo,
            reason: check.reason,
            records: check.records,
          },
          correlationId: null,
        });
      }),
    pruneBefore: (before) =>
      database.transaction(async (tx) => {
        const result = await tx.query<{ readonly affectedRows?: number }>(PRUNE_SQL, [before]);
        return Number(result.affectedRows ?? 0);
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
