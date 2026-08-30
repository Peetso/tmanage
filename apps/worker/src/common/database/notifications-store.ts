import { uuidv7 } from '@tmanage/domain';
import type { WorkerTransaction } from './worker-database.js';

/**
 * The statements the notification consumers need — NOTIF-001.
 *
 * Everything here is scoped to the organization the triggering event carries, like the
 * lifecycle store beside it. The two read functions exist because of `24-EVENT-CATALOG`
 * §6: "Consumers cannot infer authorization from event receipt; before user-facing side
 * effects they resolve current permissions." A recipient is computed from the *current*
 * membership rows at delivery time, never from who could see the object when the event
 * was written — the difference is exactly a revocation that happened in between.
 */

/** An internal membership as the recipient decision needs to see it. */
export interface InternalRecipientCandidate {
  readonly userId: string;
  readonly role: string;
  readonly hasOrgWideScope: boolean;
  /** Whether this user holds a project membership on the event's project. */
  readonly onProject: boolean;
}

/**
 * Every **active** internal membership, with the one relation fact the triage-recipient
 * rule reads. The role-to-capability half of the decision is the domain's
 * (`capabilitiesFor`), so it lives in the consumer rather than being restated as SQL.
 */
export async function listActiveInternalMemberships(
  tx: WorkerTransaction,
  organizationId: string,
  projectId: string,
): Promise<readonly InternalRecipientCandidate[]> {
  interface Row {
    readonly user_id: string;
    readonly role: string;
    readonly has_org_wide_scope: number;
    readonly on_project: number;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT m.user_id, m.role, m.has_org_wide_scope,
            EXISTS (
              SELECT 1 FROM project_memberships pm
               WHERE pm.organization_id = m.organization_id
                 AND pm.project_id = ?
                 AND pm.user_id = m.user_id
            ) AS on_project
       FROM memberships m
      WHERE m.organization_id = ? AND m.status = 'active'`,
    [projectId, organizationId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    role: row.role,
    hasOrgWideScope: Boolean(row.has_org_wide_scope),
    onProject: Boolean(row.on_project),
  }));
}

/** The person who filed a request — the transitioned notification's one recipient. */
export async function findRequestSubmitter(
  tx: WorkerTransaction,
  organizationId: string,
  requestId: string,
): Promise<string | null> {
  const rows = await tx.query<readonly { submitted_by_user_id: string }[]>(
    `SELECT submitted_by_user_id FROM client_requests
      WHERE organization_id = ? AND id = ?`,
    [organizationId, requestId],
  );
  return rows[0]?.submitted_by_user_id ?? null;
}

/**
 * §6's revocation check for a client recipient, all three parts current as of this
 * statement: an **active**, unexpired client membership in the client organization the
 * request belongs to, and the project still shared with that client organization. Any of
 * the three failing means the person is told nothing — a notification held back is
 * recoverable; one that reveals a revoked object is not.
 */
export async function clientRecipientStillPermitted(
  tx: WorkerTransaction,
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly clientOrganizationId: string;
    readonly projectId: string;
  },
): Promise<boolean> {
  const rows = await tx.query<readonly { permitted: number }[]>(
    `SELECT EXISTS (
              SELECT 1 FROM client_memberships cm
               WHERE cm.organization_id = ?
                 AND cm.user_id = ?
                 AND cm.client_organization_id = ?
                 AND cm.status = 'active'
                 AND (cm.expires_at IS NULL OR cm.expires_at > NOW(3))
            )
        AND EXISTS (
              SELECT 1 FROM project_clients pc
               WHERE pc.organization_id = ?
                 AND pc.project_id = ?
                 AND pc.client_organization_id = ?
            ) AS permitted`,
    [
      input.organizationId,
      input.userId,
      input.clientOrganizationId,
      input.organizationId,
      input.projectId,
      input.clientOrganizationId,
    ],
  );
  return Boolean(rows[0]?.permitted);
}

export interface NotificationInput {
  readonly organizationId: string;
  readonly recipientUserId: string;
  readonly type: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly dedupeKey: string;
}

/**
 * Write one notification, idempotently. `uq_notifications_dedupe` absorbs the
 * at-least-once replay: `ON DUPLICATE KEY UPDATE id = id` turns the collision into a
 * no-op instead of an error, and the return value says which happened — an insert
 * reports one affected row, a collision zero.
 */
export async function insertNotification(
  tx: WorkerTransaction,
  input: NotificationInput,
): Promise<boolean> {
  const result = await tx.query<{ affectedRows: number }>(
    `INSERT INTO notifications
       (id, organization_id, recipient_user_id, type, object_type, object_id,
        dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))
     ON DUPLICATE KEY UPDATE id = id`,
    [
      uuidv7(),
      input.organizationId,
      input.recipientUserId,
      input.type,
      input.objectType,
      input.objectId,
      input.dedupeKey,
    ],
  );
  return result.affectedRows === 1;
}
