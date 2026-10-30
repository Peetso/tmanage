import type { RowDataPacket } from 'mysql2';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';
import { insertPlatformAudit } from '../platform-admin/platform-admin.repository.js';
import type { PlatformAuditInput } from '../platform-admin/platform-admin.repository.js';
import type { SecurityReportStatus } from './security-report-content.js';

/**
 * 56-17 — `security_reports` (0262), GLOBAL: reached only through `identityTransaction` /
 * `identityRead` over the one table (plus `platform_admin_audit_events` where a platform read or
 * change is audited in the same unit of work). Dates are bound from the application clock.
 */

export interface SecurityReportRecord {
  readonly id: string;
  readonly reference: string;
  readonly reporterEmailEnc: string | null;
  readonly reporterName: string | null;
  readonly title: string;
  readonly body: string;
  readonly severityClaimed: string;
  readonly status: string;
  readonly riskDecision: string;
  readonly language: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly creditName: string | null;
  readonly creditPublic: boolean;
}

export interface SecurityReportChange {
  readonly status: SecurityReportStatus;
  readonly creditName: string | null;
  readonly creditPublic: boolean;
  readonly resolvedAt: Date | null;
  readonly updatedAt: Date;
}

/** What the service needs from storage; the unit tests hand in a fake. */
export interface SecurityReportStore {
  insert(record: SecurityReportRecord, correlationId: string): Promise<void>;
  markAcknowledged(id: string, at: Date, correlationId: string): Promise<void>;
  list(
    filter: { readonly status?: SecurityReportStatus; readonly limit: number },
    correlationId: string,
  ): Promise<readonly SecurityReportRecord[]>;
  /** Read one report and write its `viewed` audit row in one unit of work. */
  findAudited(
    id: string,
    audit: (row: SecurityReportRecord) => PlatformAuditInput,
    correlationId: string,
  ): Promise<SecurityReportRecord | null>;
  /** Apply a change to one report and write its audit row in one unit of work. */
  updateAudited(
    id: string,
    change: (row: SecurityReportRecord) => {
      readonly next: SecurityReportChange;
      readonly audit: PlatformAuditInput;
    },
    correlationId: string,
  ): Promise<SecurityReportRecord | null>;
}

const TABLE = ['security_reports'] as const;
const AUDITED = ['security_reports', 'platform_admin_audit_events'] as const;
const COLUMNS = `id, reference, reporter_email_enc, reporter_name, title, body, severity_claimed,
  status, risk_decision, language, created_at, updated_at, acknowledged_at, resolved_at,
  credit_name, credit_public`;

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const nullableDate = (value: unknown): Date | null =>
  value === null || value === undefined ? null : toDate(value);
const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function toRecord(row: RowDataPacket): SecurityReportRecord {
  return {
    id: String(row['id']),
    reference: String(row['reference']),
    reporterEmailEnc: nullableText(row['reporter_email_enc']),
    reporterName: nullableText(row['reporter_name']),
    title: String(row['title']),
    body: String(row['body']),
    severityClaimed: String(row['severity_claimed']),
    status: String(row['status']),
    riskDecision: String(row['risk_decision']),
    language: nullableText(row['language']),
    createdAt: toDate(row['created_at']),
    updatedAt: toDate(row['updated_at']),
    acknowledgedAt: nullableDate(row['acknowledged_at']),
    resolvedAt: nullableDate(row['resolved_at']),
    creditName: nullableText(row['credit_name']),
    creditPublic: Number(row['credit_public']) === 1,
  };
}

async function selectOne(
  tx: IdentityQueryRunner,
  id: string,
  lock: boolean,
): Promise<SecurityReportRecord | null> {
  const rows = await tx.query<RowDataPacket[]>(
    `select ${COLUMNS} from security_reports where id = ?${lock ? ' for update' : ''}`,
    [id],
  );
  return rows[0] === undefined ? null : toRecord(rows[0]);
}

export class SecurityReportsRepository implements SecurityReportStore {
  constructor(private readonly database: TenantDatabase) {}

  async insert(record: SecurityReportRecord, correlationId: string): Promise<void> {
    await this.database.identityTransaction({ correlationId, tables: [...TABLE] }, (tx) =>
      tx.query(
        `insert into security_reports (${COLUMNS})
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.reference,
          record.reporterEmailEnc,
          record.reporterName,
          record.title,
          record.body,
          record.severityClaimed,
          record.status,
          record.riskDecision,
          record.language,
          record.createdAt,
          record.updatedAt,
          record.acknowledgedAt,
          record.resolvedAt,
          record.creditName,
          record.creditPublic ? 1 : 0,
        ],
      ),
    );
  }

  async markAcknowledged(id: string, at: Date, correlationId: string): Promise<void> {
    await this.database.identityTransaction({ correlationId, tables: [...TABLE] }, (tx) =>
      tx.query(
        `update security_reports set acknowledged_at = ? where id = ? and acknowledged_at is null`,
        [at, id],
      ),
    );
  }

  async list(
    filter: { readonly status?: SecurityReportStatus; readonly limit: number },
    correlationId: string,
  ): Promise<readonly SecurityReportRecord[]> {
    return this.database.identityRead({ correlationId, tables: [...TABLE] }, async (runner) => {
      const rows = await runner.query<RowDataPacket[]>(
        filter.status === undefined
          ? `select ${COLUMNS} from security_reports order by created_at desc, id desc limit ?`
          : `select ${COLUMNS} from security_reports where status = ?
              order by created_at desc, id desc limit ?`,
        filter.status === undefined ? [filter.limit] : [filter.status, filter.limit],
      );
      return rows.map(toRecord);
    });
  }

  async findAudited(
    id: string,
    audit: (row: SecurityReportRecord) => PlatformAuditInput,
    correlationId: string,
  ): Promise<SecurityReportRecord | null> {
    return this.database.identityTransaction(
      { correlationId, tables: [...AUDITED] },
      async (tx) => {
        const row = await selectOne(tx, id, false);
        if (row !== null) await insertPlatformAudit(tx, audit(row));
        return row;
      },
    );
  }

  async updateAudited(
    id: string,
    change: (row: SecurityReportRecord) => {
      readonly next: SecurityReportChange;
      readonly audit: PlatformAuditInput;
    },
    correlationId: string,
  ): Promise<SecurityReportRecord | null> {
    return this.database.identityTransaction(
      { correlationId, tables: [...AUDITED] },
      async (tx) => {
        const row = await selectOne(tx, id, true);
        if (row === null) return null;
        const { next, audit } = change(row);
        await tx.query(
          `update security_reports
              set status = ?, credit_name = ?, credit_public = ?, resolved_at = ?, updated_at = ?
            where id = ?`,
          [
            next.status,
            next.creditName,
            next.creditPublic ? 1 : 0,
            next.resolvedAt,
            next.updatedAt,
            id,
          ],
        );
        await insertPlatformAudit(tx, audit);
        return {
          ...row,
          status: next.status,
          creditName: next.creditName,
          creditPublic: next.creditPublic,
          resolvedAt: next.resolvedAt,
          updatedAt: next.updatedAt,
        };
      },
    );
  }
}
