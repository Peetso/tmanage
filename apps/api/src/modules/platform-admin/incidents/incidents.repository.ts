import { isIncidentSeverity, uuidv7 } from '@tmanage/domain';
import type { IncidentSeverity } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2';
import { INCIDENT_STATUSES } from '../../../common/database/schema.js';
import type { SqlParameter, TenantDatabase } from '../../../common/database/tenant-context.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import { insertPlatformAudit } from '../platform-audit.service.js';

/**
 * 56-13 — the platform incident register on the GLOBAL `incidents` table (0060 + 0302), identity
 * path. ONE register: the public status page reads the same rows through its own explicit column
 * list (`public-site/status.repository.ts`), so nothing written here beyond the six public fields
 * is ever public. No DELETE: rows are kept 5 years (the breach register).
 */

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** The most incidents the register list shows. */
export const MAX_REGISTER_ROWS = 200;

const WRITE_TABLES = ['incidents', 'platform_admin_audit_events'] as const;

const COLUMNS = `i.id as id, i.component as component, i.status as status, i.title as title,
  i.body as body, i.started_at as started_at, i.resolved_at as resolved_at,
  i.published as published, i.created_at as created_at, i.severity as severity,
  i.detected_at as detected_at, i.contained_at as contained_at,
  i.affected_org_ids_json as affected_org_ids_json, i.data_categories_json as data_categories_json,
  i.countries_json as countries_json, i.personal_data as personal_data,
  i.notified_authority_at as notified_authority_at,
  i.notified_customers_at as notified_customers_at, i.postmortem_url as postmortem_url,
  i.created_by as created_by, i.updated_at as updated_at`;

const EDITABLE = `component = ?, status = ?, title = ?, body = ?, started_at = ?, resolved_at = ?,
  severity = ?, detected_at = ?, contained_at = ?, affected_org_ids_json = ?,
  data_categories_json = ?, countries_json = ?, personal_data = ?, notified_authority_at = ?,
  notified_customers_at = ?, postmortem_url = ?`;

export const INCIDENTS_SQL = {
  list: `select ${COLUMNS} from incidents i
    order by i.started_at desc, i.created_at desc limit ${MAX_REGISTER_ROWS}`,
  // A17: the rows a workspace may ever see — published, or announced to customers. The service
  // keeps only those published or naming the workspace, and maps them to the public fields.
  forWorkspaces: `select ${COLUMNS} from incidents i
    where i.published = 1 or i.notified_customers_at is not null
    order by i.started_at desc, i.created_at desc limit ${MAX_REGISTER_ROWS}`,
  byId: `select ${COLUMNS} from incidents i where i.id = ? limit 1`,
  byIdForUpdate: `select ${COLUMNS} from incidents i where i.id = ? limit 1 for update`,
  insert: `insert into incidents
      (id, component, status, title, body, started_at, resolved_at, severity, detected_at,
       contained_at, affected_org_ids_json, data_categories_json, countries_json, personal_data,
       notified_authority_at, notified_customers_at, postmortem_url, published, created_by,
       created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, current_timestamp(3),
      current_timestamp(3))`,
  update: `update incidents set ${EDITABLE}, updated_at = current_timestamp(3) where id = ?`,
  publish: `update incidents set published = ?, updated_at = current_timestamp(3) where id = ?`,
  resolve: `update incidents set status = 'resolved', resolved_at = ?,
      updated_at = current_timestamp(3)
    where id = ?`,
} as const;

type Row = RowDataPacket & Record<string, unknown>;

export interface IncidentRecord {
  readonly id: string;
  readonly component: string;
  readonly status: IncidentStatus;
  readonly title: string;
  readonly body: string;
  readonly startedAt: Date;
  readonly resolvedAt: Date | null;
  readonly severity: IncidentSeverity;
  readonly detectedAt: Date | null;
  readonly containedAt: Date | null;
  readonly affectedOrgIds: readonly string[];
  readonly dataCategories: readonly string[];
  readonly countries: readonly string[];
  readonly personalData: boolean;
  readonly notifiedAuthorityAt: Date | null;
  readonly notifiedCustomersAt: Date | null;
  readonly postmortemUrl: string | null;
  readonly published: boolean;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date | null;
}

/** Every field `PUT` may change — all but the id, the publish flag and who/when created it. */
export type IncidentInput = Omit<
  IncidentRecord,
  'id' | 'published' | 'createdBy' | 'createdAt' | 'updatedAt'
>;

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** A stored JSON string array; anything else reads as empty. */
export function parseStringList(value: unknown): readonly string[] {
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function list(values: readonly string[]): string | null {
  return values.length > 0 ? JSON.stringify(values) : null;
}

export function toIncidentRecord(row: Row): IncidentRecord {
  const status = String(row['status']);
  const severity = String(row['severity']);
  return {
    id: String(row['id']),
    component: String(row['component'] ?? ''),
    status: (INCIDENT_STATUSES as readonly string[]).includes(status)
      ? (status as IncidentStatus)
      : 'investigating',
    title: String(row['title'] ?? ''),
    body: String(row['body'] ?? ''),
    startedAt: date(row['started_at']) ?? new Date(0),
    resolvedAt: date(row['resolved_at']),
    severity: isIncidentSeverity(severity) ? severity : 'SEV3',
    detectedAt: date(row['detected_at']),
    containedAt: date(row['contained_at']),
    affectedOrgIds: parseStringList(row['affected_org_ids_json']),
    dataCategories: parseStringList(row['data_categories_json']),
    countries: parseStringList(row['countries_json']),
    personalData: bool(row['personal_data']),
    notifiedAuthorityAt: date(row['notified_authority_at']),
    notifiedCustomersAt: date(row['notified_customers_at']),
    postmortemUrl: text(row['postmortem_url']),
    published: bool(row['published']),
    createdBy: text(row['created_by']),
    createdAt: date(row['created_at']) ?? new Date(0),
    updatedAt: date(row['updated_at']),
  };
}

function values(input: IncidentInput): SqlParameter[] {
  return [
    input.component,
    input.status,
    input.title,
    input.body,
    input.startedAt,
    input.resolvedAt,
    input.severity,
    input.detectedAt,
    input.containedAt,
    list(input.affectedOrgIds),
    list(input.dataCategories),
    list(input.countries),
    input.personalData ? 1 : 0,
    input.notifiedAuthorityAt,
    input.notifiedCustomersAt,
    input.postmortemUrl,
  ];
}

/** Thrown by a guard callback to refuse a write after the locked re-read; nothing is written. */
export type IncidentGuard = (current: IncidentRecord) => void;

export class PlatformIncidentsRepository {
  constructor(private readonly database: TenantDatabase) {}

  async list(correlationId: string): Promise<readonly IncidentRecord[]> {
    return this.database.identityRead({ correlationId, tables: ['incidents'] }, async (db) =>
      (await db.query<Row[]>(INCIDENTS_SQL.list)).map(toIncidentRecord),
    );
  }

  /** A17 — candidates for a workspace's incidents page (published or customer-notified). */
  async listForWorkspaces(correlationId: string): Promise<readonly IncidentRecord[]> {
    return this.database.identityRead({ correlationId, tables: ['incidents'] }, async (db) =>
      (await db.query<Row[]>(INCIDENTS_SQL.forWorkspaces)).map(toIncidentRecord),
    );
  }

  async find(id: string, correlationId: string): Promise<IncidentRecord | null> {
    return this.database.identityRead({ correlationId, tables: ['incidents'] }, async (db) => {
      const [row] = await db.query<Row[]>(INCIDENTS_SQL.byId, [id]);
      return row ? toIncidentRecord(row) : null;
    });
  }

  async create(
    input: IncidentInput,
    createdBy: string,
    audit: (id: string) => PlatformAuditInput,
  ): Promise<string> {
    const id = uuidv7();
    const row = audit(id);
    await this.database.identityTransaction(
      { correlationId: row.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        await tx.query(INCIDENTS_SQL.insert, [id, ...values(input), createdBy]);
        await insertPlatformAudit(tx, row);
      },
    );
    return id;
  }

  /** `false` when there is no such incident; nothing is written then. */
  async update(
    id: string,
    input: IncidentInput,
    guard: IncidentGuard,
    audit: PlatformAuditInput,
  ): Promise<boolean> {
    return this.write(id, INCIDENTS_SQL.update, [...values(input), id], guard, audit);
  }

  async setPublished(id: string, published: boolean, audit: PlatformAuditInput): Promise<boolean> {
    return this.write(id, INCIDENTS_SQL.publish, [published ? 1 : 0, id], () => undefined, audit);
  }

  async resolve(
    id: string,
    resolvedAt: Date,
    guard: IncidentGuard,
    audit: PlatformAuditInput,
  ): Promise<boolean> {
    return this.write(id, INCIDENTS_SQL.resolve, [resolvedAt, id], guard, audit);
  }

  private async write(
    id: string,
    statement: string,
    params: SqlParameter[],
    guard: IncidentGuard,
    audit: PlatformAuditInput,
  ): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        const [row] = await tx.query<Row[]>(INCIDENTS_SQL.byIdForUpdate, [id]);
        if (!row) return false;
        guard(toIncidentRecord(row));
        await tx.query(statement, params);
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }
}
