import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { PLATFORM_METADATA_REASON } from '../platform-admin.repository.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import { insertPlatformAudit } from '../platform-audit.service.js';

/**
 * 56-21 (R46 L2) — the SQL behind owner notices and the two-person rule. Both tables are global
 * (0334, `NON_TENANT_TABLES`); the owner lookup is a bootstrap read of one organization's owner.
 */

export const TWO_PERSON_SETTING = 'two_person_approval';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'used' | 'expired';

export interface ApprovalRecord {
  readonly id: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetLabel: string | null;
  readonly reason: string;
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  readonly requestedByEmail: string | null;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
  readonly decidedBy: string | null;
  readonly decidedByEmail: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly usedAt: Date | null;
}

export interface NewApproval {
  readonly id: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetLabel: string | null;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
}

export interface CompanyOwner {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly ownerUserId: string | null;
  readonly ownerEmail: string | null;
}

export interface OwnerNoticeRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string | null;
  readonly subject: string;
  readonly severity: string;
  readonly delivery: string;
  readonly sentByEmail: string | null;
  readonly createdAt: Date;
}

export interface NewOwnerNotice {
  readonly id: string;
  readonly organizationId: string;
  readonly ownerUserId: string | null;
  readonly subject: string;
  readonly body: string;
  readonly severity: string;
  readonly delivery: string;
  readonly sentBy: string;
  readonly createdAt: Date;
}

/** The port the services use; the repository satisfies it, tests hand in a fake. */
export interface GovernanceStore {
  readPolicy(correlationId: string): Promise<boolean>;
  writePolicy(enabled: boolean, audit: PlatformAuditInput): Promise<void>;
  listApprovals(correlationId: string): Promise<readonly ApprovalRecord[]>;
  findApproval(id: string, correlationId: string): Promise<ApprovalRecord | null>;
  insertApproval(row: NewApproval, audit: PlatformAuditInput): Promise<void>;
  /** Pending and unexpired at `now` → the new status. `false` when nothing matched. */
  decide(
    id: string,
    status: 'approved' | 'rejected',
    decidedBy: string,
    note: string | null,
    now: Date,
    audit: PlatformAuditInput,
  ): Promise<boolean>;
  /** Approved, unexpired, same action/target/asker → `used`. `false` when nothing matched. */
  consume(
    id: string,
    action: string,
    targetId: string,
    requestedBy: string,
    now: Date,
    audit: PlatformAuditInput,
  ): Promise<boolean>;
  findOwner(organizationId: string, correlationId: string): Promise<CompanyOwner | null>;
  insertNotice(row: NewOwnerNotice, audit: PlatformAuditInput): Promise<void>;
  listNotices(
    organizationId: string | null,
    correlationId: string,
  ): Promise<readonly OwnerNoticeRecord[]>;
}

const APPROVAL_COLUMNS = `a.id as id, a.action as action, a.target_id as target_id,
  a.target_label as target_label, a.reason as reason, a.status as status,
  a.requested_by as requested_by, ru.email as requested_by_email, a.requested_at as requested_at,
  a.expires_at as expires_at, a.decided_by as decided_by, du.email as decided_by_email,
  a.decided_at as decided_at, a.decision_note as decision_note, a.used_at as used_at`;

const APPROVAL_FROM = `from platform_action_approvals a
  left join users ru on ru.id = a.requested_by
  left join users du on du.id = a.decided_by`;

export const GOVERNANCE_SQL = {
  readSetting: `select setting_value from platform_settings where setting_key = ? limit 1`,
  writeSetting: `insert into platform_settings (setting_key, setting_value, updated_by_user_id, updated_at)
    values (?, ?, ?, current_timestamp(3))
    on duplicate key update setting_value = values(setting_value),
      updated_by_user_id = values(updated_by_user_id), updated_at = current_timestamp(3)`,
  listApprovals: `select ${APPROVAL_COLUMNS} ${APPROVAL_FROM}
    order by a.requested_at desc limit 100`,
  approvalById: `select ${APPROVAL_COLUMNS} ${APPROVAL_FROM} where a.id = ? limit 1`,
  insertApproval: `insert into platform_action_approvals
      (id, action, target_id, target_label, reason, status, requested_by, requested_at, expires_at)
    values (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  decide: `update platform_action_approvals
    set status = ?, decided_by = ?, decided_at = ?, decision_note = ?
    where id = ? and status = 'pending' and expires_at > ? and requested_by <> ?`,
  consume: `update platform_action_approvals set status = 'used', used_at = ?
    where id = ? and action = ? and target_id = ? and requested_by = ? and status = 'approved'
      and expires_at > ? and decided_by <> requested_by`,
  owner: `select o.id as id, o.name as name,
      (select m.user_id from memberships m
        where m.organization_id = o.id and m.role = 'owner' and m.status = 'active'
        order by m.created_at asc limit 1) as owner_user_id
    from organizations o where o.id = ? and o.deleted_at is null limit 1`,
  ownerEmail: `select u.email as email from users u where u.id = ? limit 1`,
  insertNotice: `insert into platform_owner_notices
      (id, organization_id, owner_user_id, subject, body, severity, delivery, sent_by, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  listNotices: `select n.id as id, n.organization_id as organization_id, n.subject as subject,
      n.severity as severity, n.delivery as delivery, u.email as sent_by_email,
      n.created_at as created_at
    from platform_owner_notices n left join users u on u.id = n.sent_by
    where (? is null or n.organization_id = ?)
    order by n.created_at desc limit 100`,
} as const;

type Row = RowDataPacket & Record<string, unknown>;

const str = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const date = (value: unknown): Date | null =>
  value instanceof Date
    ? value
    : value === null || value === undefined
      ? null
      : new Date(String(value));

function toApproval(row: Row): ApprovalRecord {
  return {
    id: String(row['id']),
    action: String(row['action']),
    targetId: String(row['target_id']),
    targetLabel: str(row['target_label']),
    reason: String(row['reason'] ?? ''),
    status: String(row['status']) as ApprovalStatus,
    requestedBy: String(row['requested_by']),
    requestedByEmail: str(row['requested_by_email']),
    requestedAt: date(row['requested_at']) ?? new Date(0),
    expiresAt: date(row['expires_at']) ?? new Date(0),
    decidedBy: str(row['decided_by']),
    decidedByEmail: str(row['decided_by_email']),
    decidedAt: date(row['decided_at']),
    decisionNote: str(row['decision_note']),
    usedAt: date(row['used_at']),
  };
}

const SETTINGS_TABLES = ['platform_settings', 'platform_admin_audit_events'];
const APPROVAL_TABLES = ['platform_action_approvals', 'users', 'platform_admin_audit_events'];
const NOTICE_TABLES = ['platform_owner_notices', 'users', 'platform_admin_audit_events'];

export class GovernanceRepository implements GovernanceStore {
  constructor(private readonly database: TenantDatabase) {}

  async readPolicy(correlationId: string): Promise<boolean> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_settings'] },
      async (db) => {
        const rows = await db.query<Row[]>(GOVERNANCE_SQL.readSetting, [TWO_PERSON_SETTING]);
        return str(rows[0]?.['setting_value']) === 'on';
      },
    );
  }

  async writePolicy(enabled: boolean, audit: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: SETTINGS_TABLES },
      async (tx) => {
        await tx.query(GOVERNANCE_SQL.writeSetting, [
          TWO_PERSON_SETTING,
          enabled ? 'on' : 'off',
          audit.actorUserId,
        ]);
        await insertPlatformAudit(tx, audit);
      },
    );
  }

  async listApprovals(correlationId: string): Promise<readonly ApprovalRecord[]> {
    return this.database.identityRead({ correlationId, tables: APPROVAL_TABLES }, async (db) =>
      (await db.query<Row[]>(GOVERNANCE_SQL.listApprovals)).map(toApproval),
    );
  }

  async findApproval(id: string, correlationId: string): Promise<ApprovalRecord | null> {
    return this.database.identityRead({ correlationId, tables: APPROVAL_TABLES }, async (db) => {
      const [row] = await db.query<Row[]>(GOVERNANCE_SQL.approvalById, [id]);
      return row ? toApproval(row) : null;
    });
  }

  async insertApproval(row: NewApproval, audit: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: APPROVAL_TABLES },
      async (tx) => {
        await tx.query(GOVERNANCE_SQL.insertApproval, [
          row.id,
          row.action,
          row.targetId,
          row.targetLabel,
          row.reason,
          row.requestedBy,
          row.requestedAt,
          row.expiresAt,
        ]);
        await insertPlatformAudit(tx, audit);
      },
    );
  }

  async decide(
    id: string,
    status: 'approved' | 'rejected',
    decidedBy: string,
    note: string | null,
    now: Date,
    audit: PlatformAuditInput,
  ): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: APPROVAL_TABLES },
      async (tx) => {
        const result = await tx.query<ResultSetHeader>(GOVERNANCE_SQL.decide, [
          status,
          decidedBy,
          now,
          note,
          id,
          now,
          decidedBy,
        ]);
        if (result.affectedRows !== 1) return false;
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  async consume(
    id: string,
    action: string,
    targetId: string,
    requestedBy: string,
    now: Date,
    audit: PlatformAuditInput,
  ): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: APPROVAL_TABLES },
      async (tx) => {
        const result = await tx.query<ResultSetHeader>(GOVERNANCE_SQL.consume, [
          now,
          id,
          action,
          targetId,
          requestedBy,
          now,
        ]);
        if (result.affectedRows !== 1) return false;
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  async findOwner(organizationId: string, correlationId: string): Promise<CompanyOwner | null> {
    const found = await this.database.bootstrapRead(
      { correlationId, reason: PLATFORM_METADATA_REASON, tables: ['organizations', 'memberships'] },
      async (db) => {
        const [row] = await db.query<Row[]>(GOVERNANCE_SQL.owner, [organizationId]);
        return row ?? null;
      },
    );
    if (!found) return null;
    const ownerUserId = str(found['owner_user_id']);
    const ownerEmail =
      ownerUserId === null
        ? null
        : await this.database.identityRead({ correlationId, tables: ['users'] }, async (db) => {
            const [user] = await db.query<Row[]>(GOVERNANCE_SQL.ownerEmail, [ownerUserId]);
            return str(user?.['email']);
          });
    return {
      organizationId: String(found['id']),
      organizationName: String(found['name'] ?? ''),
      ownerUserId,
      ownerEmail,
    };
  }

  async insertNotice(row: NewOwnerNotice, audit: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: NOTICE_TABLES },
      async (tx) => {
        await tx.query(GOVERNANCE_SQL.insertNotice, [
          row.id,
          row.organizationId,
          row.ownerUserId,
          row.subject,
          row.body,
          row.severity,
          row.delivery,
          row.sentBy,
          row.createdAt,
        ]);
        await insertPlatformAudit(tx, audit);
      },
    );
  }

  async listNotices(
    organizationId: string | null,
    correlationId: string,
  ): Promise<readonly OwnerNoticeRecord[]> {
    return this.database.identityRead({ correlationId, tables: NOTICE_TABLES }, async (db) => {
      const rows = await db.query<Row[]>(GOVERNANCE_SQL.listNotices, [
        organizationId,
        organizationId,
      ]);
      return rows.map((row) => ({
        id: String(row['id']),
        organizationId: String(row['organization_id']),
        organizationName: null,
        subject: String(row['subject']),
        severity: String(row['severity']),
        delivery: String(row['delivery']),
        sentByEmail: str(row['sent_by_email']),
        createdAt: date(row['created_at']) ?? new Date(0),
      }));
    });
  }
}
