import { assertSafeAuditMetadata, auditObjectTypeFor, uuidv7 } from '@tmanage/domain';
import type { AuditMetadata } from '@tmanage/domain';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';
import type {
  ExpiredSupportSession,
  MembershipExit,
  SupportSessionSweepStore,
} from '../../jobs/support-session-sweeper.js';

/**
 * platform-admin v2 · PA-05: the Support-session sweeper's statements, over the worker's pool.
 *
 * `tmanage_worker` holds SELECT/UPDATE on `platform_support_sessions`, UPDATE on `memberships`
 * and `organizations`, INSERT on `audit_events` and `platform_admin_audit_events`
 * (scripts/db/users.sql, PA-05 block). "Expired" is judged on the database clock. Every
 * statement on a tenant table names the session's `organization_id`.
 */

interface ExpiredRow {
  readonly id: string;
  readonly admin_user_id: string;
  readonly organization_id: string;
  readonly membership_id: string | null;
  readonly previous_role: string | null;
  readonly previous_has_org_wide_scope: number | null;
  readonly actions_count: number;
}

interface WriteResult {
  readonly affectedRows: number;
}

const SELECT_EXPIRED = `SELECT id, admin_user_id, organization_id, membership_id, previous_role,
       previous_has_org_wide_scope, actions_count
  FROM platform_support_sessions
 WHERE ended_at IS NULL AND expires_at <= current_timestamp(3)
 ORDER BY expires_at, id
 LIMIT ?`;

const END_SESSION = `UPDATE platform_support_sessions
   SET ended_at = current_timestamp(3), ended_reason = 'expired'
 WHERE id = ? AND ended_at IS NULL AND expires_at <= current_timestamp(3)`;

const OFFBOARD = `UPDATE memberships
   SET status = 'offboarded', version = version + 1, policy_version = policy_version + 1,
       updated_at = current_timestamp(3)
 WHERE organization_id = ? AND id = ? AND role = 'platform_support'
   AND platform_support_session_id = ?`;

const RESTORE = `UPDATE memberships
   SET role = ?, status = ?, has_org_wide_scope = ?, platform_support_session_id = NULL,
       version = version + 1, policy_version = policy_version + 1,
       updated_at = current_timestamp(3)
 WHERE organization_id = ? AND id = ? AND platform_support_session_id = ?`;

const BUMP_ORGANIZATION = `UPDATE organizations SET policy_version = policy_version + 1 WHERE id = ?`;

const ORG_AUDIT = `INSERT INTO audit_events
   (id, organization_id, actor_user_id, effective_actor_id, action, object_type, object_id,
    result, correlation_id, metadata_json, created_at, platform_support_session_id)
 VALUES (?, ?, NULL, ?, 'support.session_ended', ?, ?, 'allowed', ?, ?, NOW(3), ?)`;

const PLATFORM_AUDIT = `INSERT INTO platform_admin_audit_events
   (id, actor_user_id, actor_email, action, target_type, target_id, target_label,
    organization_id, reason, correlation_id, created_at, support_session_id, before_json,
    after_json, ip, user_agent)
 SELECT ?, u.id, u.email, 'platform.support_session_ended', 'support_session', ?, NULL, ?, NULL, ?,
        current_timestamp(3), ?, NULL, ?, NULL, NULL
   FROM users u WHERE u.id = ?`;

export async function listExpiredSupportSessions(
  tx: WorkerTransaction,
  limit: number,
): Promise<readonly ExpiredSupportSession[]> {
  const rows = await tx.query<readonly ExpiredRow[]>(SELECT_EXPIRED, [
    Math.max(1, Math.trunc(limit)),
  ]);
  return rows.map((row) => ({
    id: row.id,
    adminUserId: row.admin_user_id,
    organizationId: row.organization_id,
    membershipId: row.membership_id,
    previousRole: row.previous_role,
    previousHasOrgWideScope:
      row.previous_has_org_wide_scope === null ? null : Boolean(row.previous_has_org_wide_scope),
    actionsCount: Number(row.actions_count),
  }));
}

export async function endExpiredSupportSession(
  tx: WorkerTransaction,
  session: ExpiredSupportSession,
  exit: MembershipExit,
): Promise<boolean> {
  const ended = await tx.query<WriteResult>(END_SESSION, [session.id]);
  if (ended.affectedRows === 0) return false;

  if (exit.kind === 'offboard') {
    await tx.query(OFFBOARD, [session.organizationId, exit.membershipId, session.id]);
  } else if (exit.kind === 'restore') {
    await tx.query(RESTORE, [
      exit.role,
      exit.status,
      exit.hasOrgWideScope ? 1 : 0,
      session.organizationId,
      exit.membershipId,
      session.id,
    ]);
  }
  await tx.query(BUMP_ORGANIZATION, [session.organizationId]);

  const correlationId = uuidv7();
  const metadata: AuditMetadata = {
    platform_support_session_id: session.id,
    end_cause: 'expired',
    actions_count: session.actionsCount,
  };
  assertSafeAuditMetadata(metadata);
  await tx.query(ORG_AUDIT, [
    uuidv7(),
    session.organizationId,
    session.adminUserId,
    auditObjectTypeFor('support.session_ended'),
    session.id,
    correlationId,
    JSON.stringify(metadata),
    session.id,
  ]);
  await tx.query(PLATFORM_AUDIT, [
    uuidv7(),
    session.id,
    session.organizationId,
    correlationId,
    session.id,
    JSON.stringify({ endedReason: 'expired', actionsCount: session.actionsCount }),
    session.adminUserId,
  ]);
  return true;
}

export function createSupportSessionSweepStore(database: WorkerDatabase): SupportSessionSweepStore {
  return {
    listExpired: (limit) => database.read((tx) => listExpiredSupportSessions(tx, limit)),
    endExpired: (session, exit) =>
      database.transaction((tx) => endExpiredSupportSession(tx, session, exit)),
  };
}
