import type { RowDataPacket } from 'mysql2';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { insertPlatformAudit } from '../platform-admin.repository.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';

/**
 * C6 export jobs (platform-admin v2 · PA-09, 0246) — identity path over the global
 * `platform_export_jobs`. The API inserts, lists and marks deleted (UPDATE, never DELETE); the
 * worker claims and finishes jobs. Every write carries its platform audit row in the same
 * transaction.
 */

type Row = RowDataPacket & Record<string, unknown>;

const JOB_COLUMNS = `j.id as id, j.requested_by as requested_by, u.email as requested_by_email,
  u.display_name as requested_by_name, j.scope as scope, j.filter_json as filter_json,
  j.status as status, j.row_count as row_count, j.object_key as object_key, j.error as error,
  j.created_at as created_at, j.finished_at as finished_at, j.expires_at as expires_at,
  current_timestamp(3) as db_now`;

export const EXPORT_SQL = {
  insert: `insert into platform_export_jobs
      (id, requested_by, scope, filter_json, status, created_at)
    values (?, ?, ?, ?, 'queued', current_timestamp(3))`,
  list: `select ${JOB_COLUMNS} from platform_export_jobs j join users u on u.id = j.requested_by
    where j.status <> 'deleted' order by j.created_at desc, j.id desc limit ?`,
  find: `select ${JOB_COLUMNS} from platform_export_jobs j join users u on u.id = j.requested_by
    where j.id = ? and j.status <> 'deleted' limit 1`,
  markDeleted: `update platform_export_jobs set status = 'deleted'
    where id = ? and status <> 'deleted'`,
  /** The API's own finish (sign-ins): ready with the file, or failed with the reason. */
  finishReady: `update platform_export_jobs
    set status = 'ready', row_count = ?, object_key = ?, error = null,
        finished_at = current_timestamp(3),
        expires_at = date_add(current_timestamp(3), interval 24 hour)
    where id = ? and status in ('queued', 'running')`,
  finishFailed: `update platform_export_jobs
    set status = 'failed', error = ?, finished_at = current_timestamp(3)
    where id = ? and status in ('queued', 'running')`,
} as const;

const TABLES = ['platform_export_jobs', 'users', 'platform_admin_audit_events'] as const;

export interface ExportJobRecord {
  readonly id: string;
  readonly requestedBy: string;
  readonly requestedByEmail: string;
  readonly requestedByName: string;
  readonly scope: string;
  readonly filterJson: string;
  readonly status: string;
  readonly rowCount: number | null;
  readonly objectKey: string | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
  readonly expiresAt: Date | null;
  /** The database clock at read time — expiry is judged on it. */
  readonly now: Date;
}

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toJob(row: Row): ExportJobRecord {
  const rowCount = row['row_count'];
  return {
    id: String(row['id']),
    requestedBy: String(row['requested_by']),
    requestedByEmail: String(row['requested_by_email'] ?? ''),
    requestedByName: String(row['requested_by_name'] ?? ''),
    scope: String(row['scope']),
    filterJson: String(row['filter_json'] ?? '{}'),
    status: String(row['status']),
    rowCount: rowCount === null || rowCount === undefined ? null : Number(rowCount),
    objectKey: text(row['object_key']),
    error: text(row['error']),
    createdAt: date(row['created_at']) ?? new Date(0),
    finishedAt: date(row['finished_at']),
    expiresAt: date(row['expires_at']),
    now: date(row['db_now']) ?? new Date(),
  };
}

function affected(value: unknown): number {
  const rows = (value as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}

export class ExportsRepository {
  constructor(private readonly database: TenantDatabase) {}

  /** Queue a job and its `platform.export_requested` row, atomically. */
  async create(input: {
    readonly id: string;
    readonly requestedBy: string;
    readonly scope: string;
    readonly filterJson: string;
    readonly audit: PlatformAuditInput;
  }): Promise<ExportJobRecord> {
    return this.database.identityTransaction(
      { correlationId: input.audit.correlationId, tables: [...TABLES] },
      async (tx) => {
        await tx.query(EXPORT_SQL.insert, [
          input.id,
          input.requestedBy,
          input.scope,
          input.filterJson,
        ]);
        await insertPlatformAudit(tx, input.audit);
        const rows = await tx.query<Row[]>(EXPORT_SQL.find, [input.id]);
        const row = rows[0];
        if (!row) throw new Error('export job vanished inside its own transaction');
        return toJob(row);
      },
    );
  }

  async list(limit: number, correlationId: string): Promise<readonly ExportJobRecord[]> {
    return this.database.identityRead({ correlationId, tables: [...TABLES] }, async (db) => {
      const rows = await db.query<Row[]>(EXPORT_SQL.list, [limit]);
      return rows.map(toJob);
    });
  }

  async find(id: string, correlationId: string): Promise<ExportJobRecord | null> {
    return this.database.identityRead({ correlationId, tables: [...TABLES] }, async (db) => {
      const rows = await db.query<Row[]>(EXPORT_SQL.find, [id]);
      return rows[0] ? toJob(rows[0]) : null;
    });
  }

  /** Mark deleted with its audit row. False when there was nothing to delete. */
  async markDeleted(id: string, audit: PlatformAuditInput): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...TABLES] },
      async (tx) => {
        const result = await tx.query(EXPORT_SQL.markDeleted, [id]);
        if (affected(result) === 0) return false;
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  async finishReady(
    id: string,
    rowCount: number,
    objectKey: string,
    correlationId: string,
  ): Promise<void> {
    await this.database.identityTransaction(
      { correlationId, tables: ['platform_export_jobs'] },
      async (tx) => {
        await tx.query(EXPORT_SQL.finishReady, [rowCount, objectKey, id]);
      },
    );
  }

  async finishFailed(id: string, error: string, correlationId: string): Promise<void> {
    await this.database.identityTransaction(
      { correlationId, tables: ['platform_export_jobs'] },
      async (tx) => {
        await tx.query(EXPORT_SQL.finishFailed, [error.slice(0, 500), id]);
      },
    );
  }
}
