import type { RowDataPacket } from 'mysql2';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import { insertPlatformAudit } from '../platform-audit.service.js';

/**
 * Platform admin · Settings (PA-10) — every `platform_settings` statement of the D1 page, and the
 * cross-organization counts the page shows beside the switches.
 *
 * `platform_settings` is global (`NON_TENANT_TABLES`) and runs on the identity path. The counts
 * (organizations, connected integrations) span tenants, so they run on the audited, read-only
 * bootstrap path with their own reason and a declared table list; every statement is a
 * `count(distinct organization_id)` or a `max(...)` over status columns — no content is read.
 */

/** Why the settings page may count across organizations. Recorded with every statement. */
export const SETTINGS_COUNTS_REASON =
  'platform settings: counting organizations and their integration connections (metadata only)';

const SETTINGS_TABLES = ['platform_settings', 'users'] as const;
const WRITE_TABLES = ['platform_settings', 'platform_admin_audit_events'] as const;

export const SETTINGS_SQL = {
  all: `select ps.setting_key as setting_key, ps.setting_value as setting_value,
      ps.updated_at as updated_at, u.display_name as updated_by_name
    from platform_settings ps left join users u on u.id = ps.updated_by_user_id`,
  seed: `insert into platform_settings (setting_key, setting_value, updated_by_user_id, updated_at)
    values (?, ?, null, current_timestamp(3))
    on duplicate key update setting_key = setting_key`,
  write: `insert into platform_settings (setting_key, setting_value, updated_by_user_id, updated_at)
    values (?, ?, ?, current_timestamp(3))
    on duplicate key update setting_value = values(setting_value),
      updated_by_user_id = values(updated_by_user_id), updated_at = current_timestamp(3)`,
  organizationCount: `select count(*) as total from organizations o`,
  billingOverrides: `select count(*) as total from organizations o
    where o.billing_mode_override is not null`,
  storageCounts: `select sc.provider as provider,
      count(distinct case when sc.status = 'connected' then sc.organization_id end) as connected,
      max(case when sc.status = 'connected' then sc.updated_at end) as last_success,
      max(case when sc.status = 'error' then sc.updated_at end) as last_error_at
    from storage_connections sc group by sc.provider`,
  storageLastError: `select sc.last_error_code as code from storage_connections sc
    where sc.provider = ? and sc.status = 'error' order by sc.updated_at desc limit 1`,
  calendarCounts: `select cc.provider as provider,
      count(distinct case when cc.status = 'connected' then cc.organization_id end) as connected,
      max(cc.last_synced_at) as last_success,
      max(case when cc.status = 'error' then cc.updated_at end) as last_error_at
    from calendar_connections cc group by cc.provider`,
  calendarLastError: `select cc.last_error_code as code from calendar_connections cc
    where cc.provider = ? and cc.status = 'error' order by cc.updated_at desc limit 1`,
  grantCounts: `select count(distinct og.organization_id) as connected,
      max(og.created_at) as last_success
    from oauth_grants og where og.revoked_at is null`,
} as const;

type Row = RowDataPacket & Record<string, unknown>;

/** One stored setting with who changed it last. */
export interface StoredSetting {
  readonly value: string;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

/** A connection count for one provider row. */
export interface ConnectionCount {
  readonly connected: number;
  readonly lastSuccessAt: Date | null;
  readonly lastErrorAt: Date | null;
  readonly lastErrorCode: string | null;
}

export interface IntegrationCounts {
  readonly storage: Readonly<Record<string, ConnectionCount>>;
  readonly calendar: Readonly<Record<string, ConnectionCount>>;
  readonly grants: ConnectionCount;
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

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export class PlatformSettingsRepository {
  constructor(private readonly database: TenantDatabase) {}

  /** Every stored setting, keyed by `setting_key`. */
  async readAll(correlationId: string): Promise<ReadonlyMap<string, StoredSetting>> {
    return this.database.identityRead(
      { correlationId, tables: [...SETTINGS_TABLES] },
      async (db) => {
        const rows = await db.query<Row[]>(SETTINGS_SQL.all);
        const out = new Map<string, StoredSetting>();
        for (const row of rows) {
          out.set(String(row['setting_key']), {
            value: String(row['setting_value'] ?? ''),
            updatedAt: date(row['updated_at']),
            updatedBy: text(row['updated_by_name']),
          });
        }
        return out;
      },
    );
  }

  /**
   * Seed the code defaults the settings page owns (retention, support defaults, integrations) on
   * first read, so PA-03's retention reader and the support-session defaults find a row. A key
   * that already has a row is left exactly as it is.
   */
  async seed(defaults: ReadonlyMap<string, string>, correlationId: string): Promise<void> {
    if (defaults.size === 0) return;
    await this.database.identityTransaction(
      { correlationId, tables: ['platform_settings'] },
      async (tx) => {
        for (const [key, value] of defaults) await tx.query(SETTINGS_SQL.seed, [key, value]);
      },
    );
  }

  /** Write several keys and the one platform audit row together. */
  async writeMany(
    entries: ReadonlyArray<readonly [string, string]>,
    audit: PlatformAuditInput,
  ): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        for (const [key, value] of entries) {
          await tx.query(SETTINGS_SQL.write, [key, value, audit.actorUserId]);
        }
        await insertPlatformAudit(tx, audit);
      },
    );
  }

  /** How many organizations exist, and how many carry their own billing mode (0243, PA-07). */
  async organizationCounts(
    correlationId: string,
  ): Promise<{ total: number; billingOverrides: number | null }> {
    return this.database.bootstrapRead(
      { correlationId, reason: SETTINGS_COUNTS_REASON, tables: ['organizations'] },
      async (db) => {
        const [total] = await db.query<Row[]>(SETTINGS_SQL.organizationCount);
        let overrides: number | null = null;
        try {
          const [row] = await db.query<Row[]>(SETTINGS_SQL.billingOverrides);
          overrides = num(row?.['total']);
        } catch {
          // Before 0243 (`organizations.billing_mode_override`) is applied there is no override.
          overrides = null;
        }
        return { total: num(total?.['total']), billingOverrides: overrides };
      },
    );
  }

  /** Connected organizations, last success and last error per integration provider. */
  async integrationCounts(correlationId: string): Promise<IntegrationCounts> {
    return this.database.bootstrapRead(
      {
        correlationId,
        reason: SETTINGS_COUNTS_REASON,
        tables: ['storage_connections', 'calendar_connections', 'oauth_grants'],
      },
      async (db) => {
        const storage: Record<string, ConnectionCount> = {};
        for (const row of await db.query<Row[]>(SETTINGS_SQL.storageCounts)) {
          const provider = String(row['provider']);
          const lastErrorAt = date(row['last_error_at']);
          const [error] = lastErrorAt
            ? await db.query<Row[]>(SETTINGS_SQL.storageLastError, [provider])
            : [];
          storage[provider] = {
            connected: num(row['connected']),
            lastSuccessAt: date(row['last_success']),
            lastErrorAt,
            lastErrorCode: text(error?.['code']),
          };
        }
        const calendar: Record<string, ConnectionCount> = {};
        for (const row of await db.query<Row[]>(SETTINGS_SQL.calendarCounts)) {
          const provider = String(row['provider']);
          const lastErrorAt = date(row['last_error_at']);
          const [error] = lastErrorAt
            ? await db.query<Row[]>(SETTINGS_SQL.calendarLastError, [provider])
            : [];
          calendar[provider] = {
            connected: num(row['connected']),
            lastSuccessAt: date(row['last_success']),
            lastErrorAt,
            lastErrorCode: text(error?.['code']),
          };
        }
        const [grants] = await db.query<Row[]>(SETTINGS_SQL.grantCounts);
        return {
          storage,
          calendar,
          grants: {
            connected: num(grants?.['connected']),
            lastSuccessAt: date(grants?.['last_success']),
            lastErrorAt: null,
            lastErrorCode: null,
          },
        };
      },
    );
  }
}
