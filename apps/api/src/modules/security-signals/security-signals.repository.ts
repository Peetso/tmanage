import type { RowDataPacket } from 'mysql2';
import type {
  SqlParameter,
  TenantContext,
  TenantDatabase,
} from '../../common/database/tenant-context.js';
import { insertPlatformAudit } from '../platform-admin/platform-admin.repository.js';
import type { PlatformAuditInput } from '../platform-admin/platform-admin.repository.js';

/**
 * 56-23 — `security_signals` (TENANT, nullable organization) and `platform_alert_rules` (GLOBAL),
 * 0263. The API only reads signals (the worker writes them) and updates rules.
 *
 * - An organization's read names its own `organization_id`; NULL (platform) rows never match.
 * - The platform list is a `bootstrapRead` over `security_signals` alone (read-only, audited
 *   reason): platform admins see every row, organization or platform.
 * - Rules ride the identity path with `platform_admin_audit_events`, so a change and its audit row
 *   commit together.
 *
 * `source_hash` and `details_json` are never selected: no route shape carries them.
 */

export interface SignalRecord {
  readonly id: string;
  readonly organizationId: string | null;
  readonly ruleKey: string;
  readonly severity: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly hasSource: boolean;
  readonly count: number;
  readonly windowStart: Date;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
  readonly notifyStatus: string;
  /** 0332 (R44 L2). When an owner marked it reviewed; null = not reviewed. */
  readonly reviewedAt: Date | null;
}

export interface SignalFilter {
  readonly ruleKey?: string;
  readonly from?: Date;
  /** `true` only reviewed, `false` only not reviewed, absent both. */
  readonly reviewed?: boolean;
  readonly before?: string;
  readonly limit: number;
}

export interface AlertRuleRecord {
  readonly ruleKey: string;
  readonly enabled: boolean;
  readonly thresholdJson: string;
  readonly cooldownMinutes: number;
  readonly lastFiredAt: Date | null;
  readonly updatedAt: Date;
}

export interface AlertRuleChange {
  readonly enabled: boolean;
  readonly thresholdJson: string;
  readonly cooldownMinutes: number;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

/** What the service needs from storage; the unit tests hand in a fake. */
export interface SecuritySignalsStore {
  listForOrganization(
    context: TenantContext,
    filter: SignalFilter,
  ): Promise<readonly SignalRecord[]>;
  listAll(
    filter: SignalFilter & { readonly platformOnly: boolean },
    correlationId: string,
  ): Promise<readonly SignalRecord[]>;
  listRules(correlationId: string): Promise<readonly AlertRuleRecord[]>;
  /**
   * 0332. Stamp `reviewed_at`/`reviewed_by_user_id` on one of the caller's own signals, once.
   * Returns the row after the write, or null when no signal of this organization has that id.
   */
  markReviewed(
    context: TenantContext,
    signalId: string,
    reviewedAt: Date,
  ): Promise<SignalRecord | null>;
  updateRuleAudited(
    ruleKey: string,
    change: (row: AlertRuleRecord) => {
      readonly next: AlertRuleChange;
      readonly audit: PlatformAuditInput;
    },
    correlationId: string,
  ): Promise<AlertRuleRecord | null>;
}

const SIGNAL_COLUMNS = `id, organization_id, rule_key, severity, subject_type, subject_id,
  source_hash is not null as has_source, count, window_start, first_seen, last_seen, notify_status, reviewed_at`;
const RULE_COLUMNS = `rule_key, enabled, threshold_json, cooldown_minutes, last_fired_at, updated_at`;
const PLATFORM_READ_REASON =
  'platform security signal triage: platform admins read every organization and platform signal';

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function toSignal(row: RowDataPacket): SignalRecord {
  return {
    id: String(row['id']),
    organizationId: nullableText(row['organization_id']),
    ruleKey: String(row['rule_key']),
    severity: String(row['severity']),
    subjectType: String(row['subject_type']),
    subjectId: nullableText(row['subject_id']),
    hasSource: Number(row['has_source']) === 1,
    count: Number(row['count']),
    windowStart: toDate(row['window_start']),
    firstSeen: toDate(row['first_seen']),
    lastSeen: toDate(row['last_seen']),
    notifyStatus: String(row['notify_status']),
    reviewedAt:
      row['reviewed_at'] === null || row['reviewed_at'] === undefined
        ? null
        : toDate(row['reviewed_at']),
  };
}

function toRule(row: RowDataPacket): AlertRuleRecord {
  return {
    ruleKey: String(row['rule_key']),
    enabled: Number(row['enabled']) === 1,
    thresholdJson: String(row['threshold_json']),
    cooldownMinutes: Number(row['cooldown_minutes']),
    lastFiredAt:
      row['last_fired_at'] === null || row['last_fired_at'] === undefined
        ? null
        : toDate(row['last_fired_at']),
    updatedAt: toDate(row['updated_at']),
  };
}

/** The optional filters, in order, after whatever leading predicate the caller wrote. */
function filters(filter: SignalFilter): { sql: string; params: SqlParameter[] } {
  const parts: string[] = [];
  const params: SqlParameter[] = [];
  if (filter.ruleKey !== undefined) {
    parts.push('rule_key = ?');
    params.push(filter.ruleKey);
  }
  if (filter.from !== undefined) {
    parts.push('last_seen >= ?');
    params.push(filter.from);
  }
  if (filter.reviewed !== undefined) {
    parts.push(filter.reviewed ? 'reviewed_at is not null' : 'reviewed_at is null');
  }
  if (filter.before !== undefined) {
    parts.push('id < ?');
    params.push(filter.before);
  }
  return { sql: parts.map((part) => ` and ${part}`).join(''), params };
}

export class SecuritySignalsRepository implements SecuritySignalsStore {
  constructor(private readonly database: TenantDatabase) {}

  async listForOrganization(
    context: TenantContext,
    filter: SignalFilter,
  ): Promise<readonly SignalRecord[]> {
    const extra = filters(filter);
    return this.database.read(context, async (runner) => {
      const rows = await runner.query<RowDataPacket[]>(
        `select ${SIGNAL_COLUMNS} from security_signals
          where organization_id = ?${extra.sql} order by id desc limit ?`,
        [context.organizationId, ...extra.params, filter.limit],
      );
      return rows.map(toSignal);
    });
  }

  async markReviewed(
    context: TenantContext,
    signalId: string,
    reviewedAt: Date,
  ): Promise<SignalRecord | null> {
    return this.database.transaction(context, async (runner) => {
      // Write-once: an already-reviewed signal keeps its first reviewer and time.
      await runner.query(
        `update security_signals set reviewed_at = ?, reviewed_by_user_id = ?
          where organization_id = ? and id = ? and reviewed_at is null`,
        [reviewedAt, context.userId, context.organizationId, signalId],
      );
      const rows = await runner.query<RowDataPacket[]>(
        `select ${SIGNAL_COLUMNS} from security_signals where organization_id = ? and id = ?`,
        [context.organizationId, signalId],
      );
      return rows[0] === undefined ? null : toSignal(rows[0]);
    });
  }

  async listAll(
    filter: SignalFilter & { readonly platformOnly: boolean },
    correlationId: string,
  ): Promise<readonly SignalRecord[]> {
    const extra = filters(filter);
    return this.database.bootstrapRead(
      { correlationId, reason: PLATFORM_READ_REASON, tables: ['security_signals'] },
      async (runner) => {
        const rows = await runner.query<RowDataPacket[]>(
          `select ${SIGNAL_COLUMNS} from security_signals
            where ${filter.platformOnly ? 'organization_id is null' : '1 = 1'}${extra.sql}
            order by id desc limit ?`,
          [...extra.params, filter.limit],
        );
        return rows.map(toSignal);
      },
    );
  }

  async listRules(correlationId: string): Promise<readonly AlertRuleRecord[]> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_alert_rules'] },
      async (runner) => {
        const rows = await runner.query<RowDataPacket[]>(
          `select ${RULE_COLUMNS} from platform_alert_rules order by rule_key`,
        );
        return rows.map(toRule);
      },
    );
  }

  async updateRuleAudited(
    ruleKey: string,
    change: (row: AlertRuleRecord) => {
      readonly next: AlertRuleChange;
      readonly audit: PlatformAuditInput;
    },
    correlationId: string,
  ): Promise<AlertRuleRecord | null> {
    return this.database.identityTransaction(
      { correlationId, tables: ['platform_alert_rules', 'platform_admin_audit_events'] },
      async (tx) => {
        const rows = await tx.query<RowDataPacket[]>(
          `select ${RULE_COLUMNS} from platform_alert_rules where rule_key = ? for update`,
          [ruleKey],
        );
        const row = rows[0] === undefined ? null : toRule(rows[0]);
        if (row === null) return null;
        const { next, audit } = change(row);
        await tx.query(
          `update platform_alert_rules
              set enabled = ?, threshold_json = ?, cooldown_minutes = ?, updated_by = ?,
                  updated_at = ?
            where rule_key = ?`,
          [
            next.enabled ? 1 : 0,
            next.thresholdJson,
            next.cooldownMinutes,
            next.updatedBy,
            next.updatedAt,
            ruleKey,
          ],
        );
        await insertPlatformAudit(tx, audit);
        return {
          ...row,
          enabled: next.enabled,
          thresholdJson: next.thresholdJson,
          cooldownMinutes: next.cooldownMinutes,
          updatedAt: next.updatedAt,
        };
      },
    );
  }
}
