import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { uuidv7 } from '@tmanage/domain';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { unwrapQueryError } from '../../../common/database/query-error.js';
import { insertPlatformAudit } from '../../platform-admin/platform-admin.repository.js';
import type { PlatformAuditInput } from '../../platform-admin/platform-admin.repository.js';

/**
 * SEC-ALERTS item 7 — the statements of the sign-in door, all on the identity path (every table
 * here is GLOBAL: `network_block_lists`, `network_block_ranges`, `network_access_allowlist`,
 * `network_access_blocklist` (0406), `platform_settings`, `users`, `authentication_events`,
 * `ip_lookups`).
 *
 * - The block-list lookup is one indexed point read per active list: the greatest `range_start`
 *   not above the address in that version (primary key `(list_key, version, range_start)`), then
 *   its `range_end`. Exact because the worker stores merged, non-overlapping ranges.
 * - The allowlist, the block list, the policy switch and the active versions are small and read
 *   on a cache
 *   (`network-access.service.ts`), never per request.
 * - Layer C reads the named account's last 24 hours of log rows with their cached network.
 */

export const POLICY_SETTING_KEY = 'security.anonymous_networks';

const toDate = (value: unknown): Date | null =>
  value === null || value === undefined
    ? null
    : value instanceof Date
      ? value
      : new Date(String(value));

/** ER_DUP_ENTRY: the unique key on `value` (the write-skew backstop of an identical value). */
export function isDuplicateKey(error: unknown): boolean {
  const cause = unwrapQueryError(error) as { errno?: number; code?: string } | null;
  return cause?.errno === 1062 || cause?.code === 'ER_DUP_ENTRY';
}

const toBlockEntry = (r: RowDataPacket): BlockEntry => ({
  id: String(r['id']),
  value: String(r['value']),
  note: r['note'] === null ? null : String(r['note']),
  createdAt: toDate(r['created_at']) ?? new Date(0),
});

const SQL = {
  activeLists: `select list_key, active_version from network_block_lists
    where active_version is not null`,
  rangeAt: `select range_end from network_block_ranges
    where list_key = ? and version = ? and range_start <= ?
    order by range_start desc limit 1`,
  allowlist: `select id, kind, value, note, created_at from network_access_allowlist
    order by created_at, id`,
  policy: `select setting_value from platform_settings where setting_key = ? limit 1`,
  userByEmail: `select id from users where email = ? limit 1`,
  spread: `select count(distinct l.country_code) as countries, count(distinct l.asn) as networks
    from authentication_events e join ip_lookups l on l.ip = e.ip
    where e.user_id = ? and e.occurred_at >= ?`,
  addAllow: `insert into network_access_allowlist (id, kind, value, note, created_at)
    values (?, ?, ?, ?, ?)`,
  removeAllow: `delete from network_access_allowlist where id = ?`,
  blocklist: `select id, value, note, created_at from network_access_blocklist
    order by created_at, id`,
  blockById: `select id, value, note, created_at from network_access_blocklist
    where id = ? for update`,
  addBlock: `insert into network_access_blocklist (id, value, note, created_at) values (?, ?, ?, ?)`,
  removeBlock: `delete from network_access_blocklist where id = ?`,
  listStatus: `select list_key, active_version, range_count, fetched_at, last_attempt_at,
      last_error is not null as failed
    from network_block_lists order by list_key`,
  upsertPolicy: `insert into platform_settings (setting_key, setting_value, updated_by_user_id, updated_at)
    values (?, ?, ?, ?) on duplicate key update setting_value = values(setting_value),
    updated_by_user_id = values(updated_by_user_id), updated_at = values(updated_at)`,
} as const;

export interface ActiveList {
  readonly listKey: string;
  readonly version: string;
}

export interface AllowlistEntry {
  readonly id: string;
  readonly kind: 'cidr' | 'asn';
  readonly value: string;
  readonly note: string | null;
  readonly createdAt: Date;
}

/** SEC-TRACKER (0406): an address or CIDR a platform admin blocked; `value` is canonical. */
export interface BlockEntry {
  readonly id: string;
  readonly value: string;
  readonly note: string | null;
  readonly createdAt: Date;
}

/** One `network_block_lists` row as stored. `failed` only: the error text never leaves here. */
export interface BlockListRow {
  readonly listKey: string;
  readonly activeVersion: string | null;
  readonly rangeCount: number;
  readonly fetchedAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly failed: boolean;
}

export interface NetworkAccessStore {
  activeLists(): Promise<readonly ActiveList[]>;
  /** The lists (of `lists`) whose active version holds `key`. */
  listHits(lists: readonly ActiveList[], key: string): Promise<readonly string[]>;
  allowlist(): Promise<readonly AllowlistEntry[]>;
  policy(): Promise<string | null>;
  accountSpread(
    email: string,
    since: Date,
  ): Promise<{ readonly countries: number; readonly networks: number } | null>;
  /** Each write lands with its platform audit row in one transaction. */
  addAllowlistEntry(
    entry: Omit<AllowlistEntry, 'id'>,
    audit: (id: string) => PlatformAuditInput,
  ): Promise<AllowlistEntry>;
  removeAllowlistEntry(id: string, audit: PlatformAuditInput): Promise<boolean>;
  setPolicy(mode: string, now: Date, audit: PlatformAuditInput): Promise<void>;
  blocklist(): Promise<readonly BlockEntry[]>;
  /** Each write lands with its platform audit row in one transaction. */
  /** The new entry, or null when the same value is already there (the unique key; 409). */
  addBlock(
    entry: Omit<BlockEntry, 'id'>,
    audit: (id: string) => PlatformAuditInput,
  ): Promise<BlockEntry | null>;
  /** The removed entry, or null when there was none (404). */
  removeBlock(id: string, audit: PlatformAuditInput): Promise<BlockEntry | null>;
  listStatus(): Promise<readonly BlockListRow[]>;
}

export class NetworkAccessRepository implements NetworkAccessStore {
  constructor(private readonly database: TenantDatabase) {}

  async activeLists(): Promise<readonly ActiveList[]> {
    const rows = await this.database.identityRead(
      { correlationId: uuidv7(), tables: ['network_block_lists'] },
      (db) => db.query<RowDataPacket[]>(SQL.activeLists, []),
    );
    return rows.map((r) => ({
      listKey: String(r['list_key']),
      version: String(r['active_version']),
    }));
  }

  async listHits(lists: readonly ActiveList[], key: string): Promise<readonly string[]> {
    if (lists.length === 0) return [];
    return this.database.identityRead(
      { correlationId: uuidv7(), tables: ['network_block_ranges'] },
      async (db) => {
        const hits: string[] = [];
        for (const list of lists) {
          const rows = await db.query<RowDataPacket[]>(SQL.rangeAt, [
            list.listKey,
            list.version,
            key,
          ]);
          const end = rows[0]?.['range_end'];
          if (typeof end === 'string' && key <= end) hits.push(list.listKey);
        }
        return hits;
      },
    );
  }

  async allowlist(): Promise<readonly AllowlistEntry[]> {
    const rows = await this.database.identityRead(
      { correlationId: uuidv7(), tables: ['network_access_allowlist'] },
      (db) => db.query<RowDataPacket[]>(SQL.allowlist, []),
    );
    return rows.map((r) => ({
      id: String(r['id']),
      kind: r['kind'] === 'asn' ? 'asn' : 'cidr',
      value: String(r['value']),
      note: r['note'] === null ? null : String(r['note']),
      createdAt:
        r['created_at'] instanceof Date ? r['created_at'] : new Date(String(r['created_at'])),
    }));
  }

  async policy(): Promise<string | null> {
    const rows = await this.database.identityRead(
      { correlationId: uuidv7(), tables: ['platform_settings'] },
      (db) => db.query<RowDataPacket[]>(SQL.policy, [POLICY_SETTING_KEY]),
    );
    const value = rows[0]?.['setting_value'];
    return typeof value === 'string' ? value : null;
  }

  async accountSpread(
    email: string,
    since: Date,
  ): Promise<{ readonly countries: number; readonly networks: number } | null> {
    return this.database.identityRead(
      { correlationId: uuidv7(), tables: ['users', 'authentication_events', 'ip_lookups'] },
      async (db) => {
        const users = await db.query<RowDataPacket[]>(SQL.userByEmail, [
          email.trim().toLowerCase(),
        ]);
        const id = users[0]?.['id'];
        if (typeof id !== 'string') return null;
        const rows = await db.query<RowDataPacket[]>(SQL.spread, [id, since]);
        return {
          countries: Number(rows[0]?.['countries'] ?? 0),
          networks: Number(rows[0]?.['networks'] ?? 0),
        };
      },
    );
  }

  async addAllowlistEntry(
    entry: Omit<AllowlistEntry, 'id'>,
    audit: (id: string) => PlatformAuditInput,
  ): Promise<AllowlistEntry> {
    const id = uuidv7();
    await this.database.identityTransaction(
      { correlationId: id, tables: ['network_access_allowlist', 'platform_admin_audit_events'] },
      async (tx) => {
        await tx.query(SQL.addAllow, [id, entry.kind, entry.value, entry.note, entry.createdAt]);
        await insertPlatformAudit(tx, audit(id));
      },
    );
    return { id, ...entry };
  }

  async removeAllowlistEntry(id: string, audit: PlatformAuditInput): Promise<boolean> {
    return this.database.identityTransaction(
      {
        correlationId: audit.correlationId,
        tables: ['network_access_allowlist', 'platform_admin_audit_events'],
      },
      async (tx) => {
        const result = await tx.query<ResultSetHeader>(SQL.removeAllow, [id]);
        if (result.affectedRows === 0) return false;
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  async setPolicy(mode: string, now: Date, audit: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      {
        correlationId: audit.correlationId,
        tables: ['platform_settings', 'platform_admin_audit_events'],
      },
      async (tx) => {
        await tx.query(SQL.upsertPolicy, [POLICY_SETTING_KEY, mode, audit.actorUserId, now]);
        await insertPlatformAudit(tx, audit);
      },
    );
  }
  async blocklist(): Promise<readonly BlockEntry[]> {
    const rows = await this.database.identityRead(
      { correlationId: uuidv7(), tables: ['network_access_blocklist'] },
      (db) => db.query<RowDataPacket[]>(SQL.blocklist, []),
    );
    return rows.map(toBlockEntry);
  }

  async addBlock(
    entry: Omit<BlockEntry, 'id'>,
    audit: (id: string) => PlatformAuditInput,
  ): Promise<BlockEntry | null> {
    const id = uuidv7();
    try {
      await this.database.identityTransaction(
        { correlationId: id, tables: ['network_access_blocklist', 'platform_admin_audit_events'] },
        async (tx) => {
          await tx.query(SQL.addBlock, [id, entry.value, entry.note, entry.createdAt]);
          await insertPlatformAudit(tx, audit(id));
        },
      );
    } catch (error) {
      if (isDuplicateKey(error)) return null;
      throw error;
    }
    return { id, ...entry };
  }

  async removeBlock(id: string, audit: PlatformAuditInput): Promise<BlockEntry | null> {
    return this.database.identityTransaction(
      {
        correlationId: audit.correlationId,
        tables: ['network_access_blocklist', 'platform_admin_audit_events'],
      },
      async (tx) => {
        const rows = await tx.query<RowDataPacket[]>(SQL.blockById, [id]);
        const row = rows[0];
        if (row === undefined) return null;
        const entry = toBlockEntry(row);
        await tx.query<ResultSetHeader>(SQL.removeBlock, [id]);
        await insertPlatformAudit(tx, { ...audit, targetLabel: `cidr:${entry.value}` });
        return entry;
      },
    );
  }

  async listStatus(): Promise<readonly BlockListRow[]> {
    const rows = await this.database.identityRead(
      { correlationId: uuidv7(), tables: ['network_block_lists'] },
      (db) => db.query<RowDataPacket[]>(SQL.listStatus, []),
    );
    return rows.map((r) => ({
      listKey: String(r['list_key']),
      activeVersion: r['active_version'] === null ? null : String(r['active_version']),
      rangeCount: Number(r['range_count'] ?? 0),
      fetchedAt: toDate(r['fetched_at']),
      lastAttemptAt: toDate(r['last_attempt_at']),
      failed: Number(r['failed']) === 1,
    }));
  }
}
