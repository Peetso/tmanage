import { uuidv7 } from '@tmanage/domain';
import type { WorkerTransaction } from './worker-database.js';

/**
 * platform-admin v2 · PA-07 — the statements of the worker's organization purge
 * (`jobs/purge-organizations.ts`). The only file allowed to spell its SQL (the worker's lint rule).
 *
 * An organization whose restore window has passed (`deleted_at` set, `purge_after <= now`, not yet
 * closed) is handed to the privacy erasure path in ONE transaction: an executed company deletion
 * request is recorded (`privacy_deletion_requests`, requested by whoever deleted it) and the
 * organization is closed (`archived_at`, `suspended_at`), which also takes it out of the due set.
 * The API's privacy job then erases its rows and files after its own delay. Nothing is deleted
 * here, and the worker never reads the requests table.
 */

export interface DueOrganization {
  readonly id: string;
  readonly deletedByUserId: string | null;
}

interface DueRow {
  readonly id: string;
  readonly deleted_by_user_id: string | null;
}

interface WriteResult {
  readonly affectedRows: number;
}

const DUE_PREDICATE =
  'deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= current_timestamp(3) ' +
  'AND archived_at IS NULL';

export async function listDueOrganizations(
  tx: WorkerTransaction,
  limit: number,
): Promise<readonly DueOrganization[]> {
  const rows = await tx.query<readonly DueRow[]>(
    `SELECT id, deleted_by_user_id FROM organizations
      WHERE ${DUE_PREDICATE}
      ORDER BY purge_after, id
      LIMIT ${String(Math.max(1, Math.trunc(limit)))}
      FOR UPDATE SKIP LOCKED`,
  );
  return rows.map((row) => ({ id: row.id, deletedByUserId: row.deleted_by_user_id }));
}

/**
 * Close one due organization and record the executed company deletion. Returns false when the
 * organization left the due set in the meantime (restored, or closed by another run), in which
 * case nothing is written. An organization with no recorded deleter is skipped (the request needs
 * a requester); it stays due and the job reports it.
 */
export async function handOrganizationToErasure(
  tx: WorkerTransaction,
  organization: DueOrganization,
): Promise<boolean> {
  if (organization.deletedByUserId === null) return false;
  const closed = await tx.query<WriteResult>(
    `UPDATE organizations
        SET archived_at = current_timestamp(3),
            suspended_at = coalesce(suspended_at, current_timestamp(3)),
            policy_version = policy_version + 1,
            updated_at = current_timestamp(3)
      WHERE id = ? AND ${DUE_PREDICATE}`,
    [organization.id],
  );
  if (closed.affectedRows === 0) return false;
  await tx.query<WriteResult>(
    `INSERT INTO privacy_deletion_requests
       (id, organization_id, kind, subject_user_id, requested_by_user_id, status, requested_at,
        scheduled_for, executed_at, version, created_at, updated_at)
     VALUES (?, ?, 'company', NULL, ?, 'executed', current_timestamp(3), current_timestamp(3),
        current_timestamp(3), 1, current_timestamp(3), current_timestamp(3))`,
    [uuidv7(), organization.id, organization.deletedByUserId],
  );
  return true;
}
