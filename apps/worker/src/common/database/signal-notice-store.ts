import { isSignalRuleKey } from '@tmanage/domain';
import type {
  SignalRecipientCandidate,
  SignalRuleKey,
  SignalSubjectPeople,
  StoredSignalSetting,
} from '@tmanage/domain';
import { CUSTOM_ROLE_COLUMNS, customRoleJoin, internalPrincipalRole } from './principal-role.js';
import type { CustomRoleColumns } from './principal-role.js';
import type { WorkerTransaction } from './worker-database.js';

/**
 * 62-27 (B05) — what the `work_signal.raised.v1` consumer reads at delivery, inside the delivery
 * transaction and only within the event's organization (`24-EVENT-CATALOG` §6): the signal row,
 * the rule's current setting, the people around its subject and the current active internal
 * memberships. Grants: SELECT on `work_signals`, `work_signal_settings`, `work_items`,
 * `member_reporting_lines`, `memberships`, `project_memberships`, `custom_roles`.
 */

export interface StoredSignal {
  readonly id: string;
  readonly rule: SignalRuleKey;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly projectId: string | null;
}

const SQL = {
  signal: `SELECT id, rule_key, subject_type, subject_id, project_id FROM work_signals
   WHERE organization_id = ? AND id = ?`,
  setting: `SELECT rule_key, enabled, threshold, recipient FROM work_signal_settings
   WHERE organization_id = ? AND rule_key = ?`,
  workItemOwner: `SELECT owner_user_id FROM work_items
   WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`,
  managerOfMembership: `SELECT manager_member_id FROM member_reporting_lines
   WHERE organization_id = ? AND member_id = ?`,
  managerOfUser: `SELECT r.manager_member_id FROM member_reporting_lines r
  JOIN memberships m ON m.organization_id = r.organization_id AND m.id = r.member_id
 WHERE r.organization_id = ? AND m.user_id = ? AND m.status = 'active'`,
  candidates: `SELECT m.id AS membership_id, m.user_id, m.role, ${CUSTOM_ROLE_COLUMNS},
       m.has_org_wide_scope,
       EXISTS (
         SELECT 1 FROM project_memberships pm
          WHERE pm.organization_id = m.organization_id AND pm.project_id = ?
            AND pm.user_id = m.user_id
       ) AS on_project
  FROM memberships m
  ${customRoleJoin('m')}
 WHERE m.organization_id = ? AND m.status = 'active' AND m.role <> 'platform_support'`,
} as const;

type Row = Readonly<Record<string, unknown>>;

export async function findSignal(
  tx: WorkerTransaction,
  organizationId: string,
  signalId: string,
): Promise<StoredSignal | null> {
  const row = (await tx.query<readonly Row[]>(SQL.signal, [organizationId, signalId]))[0];
  if (row === undefined || !isSignalRuleKey(row['rule_key'])) return null;
  return {
    id: String(row['id']),
    rule: row['rule_key'],
    subjectType: String(row['subject_type']),
    subjectId: String(row['subject_id']),
    projectId: row['project_id'] === null ? null : String(row['project_id']),
  };
}

export async function findSignalSetting(
  tx: WorkerTransaction,
  organizationId: string,
  rule: SignalRuleKey,
): Promise<readonly StoredSignalSetting[]> {
  const rows = await tx.query<readonly Row[]>(SQL.setting, [organizationId, rule]);
  return rows.map((r) => ({
    rule: String(r['rule_key']),
    enabled: r['enabled'] === true || r['enabled'] === 1 || r['enabled'] === '1',
    threshold: Number(r['threshold']),
    recipient: String(r['recipient']),
  }));
}

async function firstString(
  tx: WorkerTransaction,
  sql: string,
  params: readonly unknown[],
  column: string,
): Promise<string | null> {
  const value = (await tx.query<readonly Row[]>(sql, params))[0]?.[column];
  return typeof value === 'string' ? value : null;
}

/** The assignee and the manager of the person a signal is about. */
export async function findSubjectPeople(
  tx: WorkerTransaction,
  organizationId: string,
  signal: StoredSignal,
): Promise<SignalSubjectPeople> {
  if (signal.subjectType === 'membership') {
    return {
      projectId: signal.projectId,
      assigneeUserId: null,
      managerMembershipId: await firstString(
        tx,
        SQL.managerOfMembership,
        [organizationId, signal.subjectId],
        'manager_member_id',
      ),
    };
  }
  if (signal.subjectType === 'work_item') {
    const assignee = await firstString(
      tx,
      SQL.workItemOwner,
      [organizationId, signal.subjectId],
      'owner_user_id',
    );
    return {
      projectId: signal.projectId,
      assigneeUserId: assignee,
      managerMembershipId:
        assignee === null
          ? null
          : await firstString(
              tx,
              SQL.managerOfUser,
              [organizationId, assignee],
              'manager_member_id',
            ),
    };
  }
  return { projectId: signal.projectId, assigneeUserId: null, managerMembershipId: null };
}

/** Every active internal membership, with whether it is on the signal's project. */
export async function listSignalRecipientCandidates(
  tx: WorkerTransaction,
  organizationId: string,
  projectId: string | null,
): Promise<readonly SignalRecipientCandidate[]> {
  // A projectless signal binds an id no project has, so `on_project` is false for everyone.
  const rows = await tx.query<readonly (Row & CustomRoleColumns)[]>(SQL.candidates, [
    projectId ?? '',
    organizationId,
  ]);
  return rows.map((row) => ({
    userId: String(row['user_id']),
    membershipId: String(row['membership_id']),
    role: internalPrincipalRole(row['role'] as string, row),
    hasOrgWideScope: Boolean(Number(row['has_org_wide_scope'])),
    onProject: Boolean(Number(row['on_project'])),
  }));
}
