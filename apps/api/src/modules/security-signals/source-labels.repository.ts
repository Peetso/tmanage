import type { RowDataPacket } from 'mysql2';
import { uuidv7 } from '@tmanage/domain';
import { unwrapQueryError } from '../../common/database/query-error.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { insertPlatformAudit } from '../platform-admin/platform-admin.repository.js';
import type { PlatformAuditInput } from '../platform-admin/platform-admin.repository.js';
import { isSourceLabelKind } from './source-labels.js';
import type { SourceLabel } from './source-labels.js';

/**
 * SEC-TRACKER (0406) — `security_source_labels`, GLOBAL (an address belongs to no company), on the
 * identity path. Small: read whole, once per tracker read. Each write lands with its platform audit
 * row in one transaction (DA-11).
 */

const SQL = {
  list: `select id, value, label, note, created_at from security_source_labels
    order by created_at, id`,
  byId: `select id, value, label, note, created_at from security_source_labels
    where id = ? for update`,
  add: `insert into security_source_labels (id, value, label, note, created_at)
    values (?, ?, ?, ?, ?)`,
  remove: `delete from security_source_labels where id = ?`,
} as const;

const TABLES = ['security_source_labels', 'platform_admin_audit_events'];

export interface SourceLabelStore {
  list(): Promise<readonly SourceLabel[]>;
  /** The new label, or null when the same value already carries one (unique key; 409). */
  add(
    entry: Omit<SourceLabel, 'id'>,
    audit: (id: string) => PlatformAuditInput,
  ): Promise<SourceLabel | null>;
  /** False when there was no such label (404). */
  remove(id: string, audit: PlatformAuditInput): Promise<boolean>;
}

function toLabel(r: RowDataPacket): SourceLabel | null {
  const label = r['label'];
  if (!isSourceLabelKind(label)) return null;
  const at = r['created_at'];
  return {
    id: String(r['id']),
    value: String(r['value']),
    label,
    note: r['note'] === null || r['note'] === undefined ? null : String(r['note']),
    createdAt: at instanceof Date ? at : new Date(String(at)),
  };
}

function isDuplicateKey(error: unknown): boolean {
  const cause = unwrapQueryError(error) as { errno?: number; code?: string } | null;
  return cause?.errno === 1062 || cause?.code === 'ER_DUP_ENTRY';
}

export class SourceLabelRepository implements SourceLabelStore {
  constructor(private readonly database: TenantDatabase) {}

  async list(): Promise<readonly SourceLabel[]> {
    const rows = await this.database.identityRead(
      { correlationId: uuidv7(), tables: ['security_source_labels'] },
      (db) => db.query<RowDataPacket[]>(SQL.list, []),
    );
    // A label this build does not know (a newer release wrote it) is skipped, not guessed.
    return rows.flatMap((r) => {
      const label = toLabel(r);
      return label === null ? [] : [label];
    });
  }

  async add(
    entry: Omit<SourceLabel, 'id'>,
    audit: (id: string) => PlatformAuditInput,
  ): Promise<SourceLabel | null> {
    const id = uuidv7();
    try {
      await this.database.identityTransaction({ correlationId: id, tables: TABLES }, async (tx) => {
        await tx.query(SQL.add, [id, entry.value, entry.label, entry.note, entry.createdAt]);
        await insertPlatformAudit(tx, audit(id));
      });
    } catch (error) {
      if (isDuplicateKey(error)) return null;
      throw error;
    }
    return { id, ...entry };
  }

  async remove(id: string, audit: PlatformAuditInput): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: TABLES },
      async (tx) => {
        const rows = await tx.query<RowDataPacket[]>(SQL.byId, [id]);
        const row = rows[0];
        if (row === undefined) return false;
        await tx.query(SQL.remove, [id]);
        await insertPlatformAudit(tx, {
          ...audit,
          targetLabel: `${String(row['label'])}:${String(row['value'])}`,
        });
        return true;
      },
    );
  }
}
