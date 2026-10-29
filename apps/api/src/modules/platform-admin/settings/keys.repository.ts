import type { RowDataPacket } from 'mysql2';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import { insertPlatformAudit } from '../platform-audit.service.js';

/**
 * 56-02 · Platform admin → Settings → Keys. Every statement the Keys page needs, on the global
 * `key_rotations` ledger (0249): counts and key ids only — never a key, never a secret. The API
 * holds INSERT (queue a rotation) and the database-wide read; the worker claims and finishes.
 */

/** The most ledger rows one status read folds (a rotation is quarterly; this is years). */
export const MAX_ROTATION_ROWS = 200;

export const KEYS_SQL = {
  rotations: `select r.id as id, r.purpose as purpose, r.from_key_id as from_key_id,
      r.to_key_id as to_key_id, r.status as status, r.rows_total as rows_total,
      r.rows_done as rows_done, r.rows_skipped as rows_skipped, r.rows_failed as rows_failed,
      r.created_at as created_at, r.started_at as started_at, r.finished_at as finished_at
    from key_rotations r order by r.created_at desc, r.id desc limit ${MAX_ROTATION_ROWS}`,
  openForPurpose: `select r.id as id from key_rotations r
    where r.purpose = ? and r.status in ('queued', 'running') limit 1`,
  queue: `insert into key_rotations (id, purpose, from_key_id, to_key_id, status, requested_by,
      created_at)
    values (?, ?, ?, ?, 'queued', ?, current_timestamp(3))`,
} as const;

const READ_TABLES = ['key_rotations'] as const;
const WRITE_TABLES = ['key_rotations', 'platform_admin_audit_events'] as const;

type Row = RowDataPacket & Record<string, unknown>;

export type RotationStatus = 'queued' | 'running' | 'done' | 'failed';

export interface StoredRotation {
  readonly id: string;
  readonly purpose: string;
  readonly fromKeyId: string | null;
  readonly toKeyId: string;
  readonly status: RotationStatus;
  readonly rowsTotal: number;
  readonly rowsDone: number;
  readonly rowsSkipped: number;
  readonly rowsFailed: number;
  readonly createdAt: Date | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface QueueRotation {
  readonly id: string;
  readonly purpose: string;
  readonly fromKeyId: string | null;
  readonly toKeyId: string;
  readonly requestedBy: string;
}

/** The statements the Keys service needs. Faked by the unit test. */
export interface KeysStore {
  rotations(correlationId: string): Promise<readonly StoredRotation[]>;
  /** Insert the queued row and its audit together; false when one is already open. */
  queue(input: QueueRotation, audit: PlatformAuditInput): Promise<boolean>;
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function status(value: unknown): RotationStatus {
  return value === 'running' || value === 'done' || value === 'failed' ? value : 'queued';
}

export class PlatformKeysRepository implements KeysStore {
  constructor(private readonly database: TenantDatabase) {}

  async rotations(correlationId: string): Promise<readonly StoredRotation[]> {
    return this.database.identityRead({ correlationId, tables: [...READ_TABLES] }, async (db) => {
      const rows = await db.query<Row[]>(KEYS_SQL.rotations);
      return rows.map((row) => ({
        id: String(row['id']),
        purpose: String(row['purpose']),
        fromKeyId: row['from_key_id'] == null ? null : String(row['from_key_id']),
        toKeyId: String(row['to_key_id']),
        status: status(row['status']),
        rowsTotal: num(row['rows_total']),
        rowsDone: num(row['rows_done']),
        rowsSkipped: num(row['rows_skipped']),
        rowsFailed: num(row['rows_failed']),
        createdAt: date(row['created_at']),
        startedAt: date(row['started_at']),
        finishedAt: date(row['finished_at']),
      }));
    });
  }

  async queue(input: QueueRotation, audit: PlatformAuditInput): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        const open = await tx.query<Row[]>(KEYS_SQL.openForPurpose, [input.purpose]);
        if (open.length > 0) return false;
        await tx.query(KEYS_SQL.queue, [
          input.id,
          input.purpose,
          input.fromKeyId,
          input.toKeyId,
          input.requestedBy,
        ]);
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }
}
