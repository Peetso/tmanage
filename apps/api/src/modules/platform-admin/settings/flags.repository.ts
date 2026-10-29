import { uuidv7 } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import {
  FLAG_ROLLOUTS,
  isOptionalModuleFlag,
  parseFlagLocks,
} from '../../admin/feature-flags.service.js';
import type {
  FlagRollout,
  OptionalModuleFlag,
  PlatformFlagContext,
  PlatformFlagLayer,
} from '../../admin/feature-flags.service.js';
import { likeContains } from '../platform-admin.access.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import { insertPlatformAudit } from '../platform-audit.service.js';

/**
 * Platform feature flags (0244) — every statement of D2 and the platform half of the org-side
 * flag read.
 *
 * `platform_feature_flags` and `platform_org_flag_overrides` are global and run on the identity
 * path. The per-organization side (`org_feature_flags`, `organizations`) spans tenants, so it runs
 * on the audited, read-only bootstrap path: ids, names, slugs and the flag rows — no content.
 */

export const FLAGS_METADATA_REASON =
  'platform feature flags: which organizations a flag reaches (organization names and flag rows)';

const FLAG_TABLES = ['platform_feature_flags', 'platform_org_flag_overrides', 'users'] as const;
const LAYER_TABLES = ['platform_feature_flags', 'platform_org_flag_overrides'] as const;
const WRITE_TABLES = [
  'platform_feature_flags',
  'platform_org_flag_overrides',
  'platform_admin_audit_events',
] as const;

/** The most organizations a flag read folds in one pass. */
export const MAX_FLAG_ORGANIZATIONS = 5000;
/** The most organizations a search returns. */
export const MAX_FLAG_SEARCH = 20;

export const FLAGS_SQL = {
  flags: `select f.flag_key as flag_key, f.enabled as enabled, f.rollout as rollout,
      f.percentage as percentage, f.allowlist_org_ids_json as allowlist,
      f.updated_at as updated_at, u.display_name as updated_by_name
    from platform_feature_flags f left join users u on u.id = f.updated_by`,
  flagLayers: `select f.flag_key as flag_key, f.enabled as enabled, f.rollout as rollout,
      f.percentage as percentage, f.allowlist_org_ids_json as allowlist
    from platform_feature_flags f`,
  overrides: `select o.flag_key as flag_key, o.organization_id as organization_id,
      o.enabled as enabled
    from platform_org_flag_overrides o where o.removed_at is null`,
  overridesForOrg: `select o.flag_key as flag_key, o.enabled as enabled
    from platform_org_flag_overrides o where o.organization_id = ? and o.removed_at is null`,
  upsertFlag: `insert into platform_feature_flags
      (flag_key, enabled, rollout, percentage, allowlist_org_ids_json, updated_by, updated_at)
    values (?, ?, ?, ?, ?, ?, current_timestamp(3))
    on duplicate key update enabled = values(enabled), rollout = values(rollout),
      percentage = values(percentage), allowlist_org_ids_json = values(allowlist_org_ids_json),
      updated_by = values(updated_by), updated_at = current_timestamp(3)`,
  forceOverride: `insert into platform_org_flag_overrides
      (id, flag_key, organization_id, enabled, removed_at, updated_by, updated_at)
    values (?, ?, ?, ?, null, ?, current_timestamp(3))
    on duplicate key update enabled = values(enabled), removed_at = null,
      updated_by = values(updated_by), updated_at = current_timestamp(3)`,
  removeOverride: `update platform_org_flag_overrides
    set removed_at = current_timestamp(3), updated_by = ?, updated_at = current_timestamp(3)
    where flag_key = ? and organization_id = ? and removed_at is null`,
  organizations: `select o.id as id, o.name as name, o.slug as slug from organizations o
    order by o.name asc limit ${MAX_FLAG_ORGANIZATIONS}`,
  searchOrganizations: `select o.id as id, o.name as name, o.slug as slug from organizations o
    where (o.name like ? or o.slug like ?)
    order by o.name asc limit ${MAX_FLAG_SEARCH}`,
  organizationsById: (ids: number) => `select o.id as id, o.name as name, o.slug as slug
    from organizations o where o.id in (${Array.from({ length: ids }, () => '?').join(', ')})`,
  orgFlagRows: `select ff.organization_id as organization_id, ff.flag_key as flag_key,
      ff.enabled as enabled
    from org_feature_flags ff limit ${MAX_FLAG_ORGANIZATIONS * 16}`,
} as const;

type Row = RowDataPacket & Record<string, unknown>;

export interface StoredFlag extends PlatformFlagLayer {
  readonly key: OptionalModuleFlag;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

export interface FlagOverrideRow {
  readonly key: OptionalModuleFlag;
  readonly organizationId: string;
  readonly enabled: boolean;
}

export interface FlagOrganizationRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface OrgFlagRow {
  readonly organizationId: string;
  readonly key: OptionalModuleFlag;
  readonly enabled: boolean;
}

export interface FlagWrite {
  readonly key: OptionalModuleFlag;
  readonly layer: PlatformFlagLayer;
  /** Organization id → forced on (`true`), forced off (`false`), or removed (`null`). */
  readonly overrides: ReadonlyMap<string, boolean | null>;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A stored JSON id list; anything unreadable is the empty list. */
export function parseIdList(raw: unknown): readonly string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function rollout(value: unknown): FlagRollout {
  return (FLAG_ROLLOUTS as readonly unknown[]).includes(value)
    ? (value as FlagRollout)
    : 'everyone';
}

function toLayer(row: Row): PlatformFlagLayer {
  const percentage = row['percentage'] === null ? null : Number(row['percentage']);
  return {
    enabled: bool(row['enabled']),
    rollout: rollout(row['rollout']),
    percentage: percentage === null || !Number.isFinite(percentage) ? null : percentage,
    allowlist: parseIdList(row['allowlist']),
  };
}

export class PlatformFlagsRepository {
  constructor(private readonly database: TenantDatabase) {}

  async flags(correlationId: string): Promise<readonly StoredFlag[]> {
    return this.database.identityRead({ correlationId, tables: [...FLAG_TABLES] }, async (db) => {
      const rows = await db.query<Row[]>(FLAGS_SQL.flags);
      const out: StoredFlag[] = [];
      for (const row of rows) {
        const key = String(row['flag_key']);
        if (!isOptionalModuleFlag(key)) continue;
        out.push({
          key,
          ...toLayer(row),
          updatedAt: date(row['updated_at']),
          updatedBy: row['updated_by_name'] == null ? null : String(row['updated_by_name']),
        });
      }
      return out;
    });
  }

  async overrides(correlationId: string): Promise<readonly FlagOverrideRow[]> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_org_flag_overrides'] },
      async (db) => {
        const rows = await db.query<Row[]>(FLAGS_SQL.overrides);
        const out: FlagOverrideRow[] = [];
        for (const row of rows) {
          const key = String(row['flag_key']);
          if (!isOptionalModuleFlag(key)) continue;
          out.push({
            key,
            organizationId: String(row['organization_id']),
            enabled: bool(row['enabled']),
          });
        }
        return out;
      },
    );
  }

  /** The platform half of one organization's flag read (`feature-flags.service.ts`). */
  async contextFor(
    organizationId: string,
    correlationId: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<PlatformFlagContext> {
    return this.database.identityRead({ correlationId, tables: [...LAYER_TABLES] }, async (db) => {
      const flags: Partial<Record<OptionalModuleFlag, PlatformFlagLayer>> = {};
      for (const row of await db.query<Row[]>(FLAGS_SQL.flagLayers)) {
        const key = String(row['flag_key']);
        if (isOptionalModuleFlag(key)) flags[key] = toLayer(row);
      }
      const overrides: Partial<Record<OptionalModuleFlag, boolean>> = {};
      for (const row of await db.query<Row[]>(FLAGS_SQL.overridesForOrg, [organizationId])) {
        const key = String(row['flag_key']);
        if (isOptionalModuleFlag(key)) overrides[key] = bool(row['enabled']);
      }
      return {
        organizationId,
        flags,
        overrides,
        locks: parseFlagLocks(env['TMANAGE_FLAG_LOCKS']),
      };
    });
  }

  /** Every organization (bounded) and every org-side flag row, for the "used by N" counts. */
  async organizationsWithRows(correlationId: string): Promise<{
    organizations: readonly FlagOrganizationRow[];
    orgRows: readonly OrgFlagRow[];
  }> {
    return this.database.bootstrapRead(
      {
        correlationId,
        reason: FLAGS_METADATA_REASON,
        tables: ['organizations', 'org_feature_flags'],
      },
      async (db) => {
        const organizations = (await db.query<Row[]>(FLAGS_SQL.organizations)).map(toOrganization);
        const orgRows: OrgFlagRow[] = [];
        for (const row of await db.query<Row[]>(FLAGS_SQL.orgFlagRows)) {
          const key = String(row['flag_key']);
          if (!isOptionalModuleFlag(key)) continue;
          orgRows.push({
            organizationId: String(row['organization_id']),
            key,
            enabled: bool(row['enabled']),
          });
        }
        return { organizations, orgRows };
      },
    );
  }

  async searchOrganizations(
    fragment: string,
    correlationId: string,
  ): Promise<readonly FlagOrganizationRow[]> {
    const like = likeContains(fragment);
    return this.database.bootstrapRead(
      { correlationId, reason: FLAGS_METADATA_REASON, tables: ['organizations'] },
      async (db) =>
        (await db.query<Row[]>(FLAGS_SQL.searchOrganizations, [like, like])).map(toOrganization),
    );
  }

  async organizationsById(
    ids: readonly string[],
    correlationId: string,
  ): Promise<readonly FlagOrganizationRow[]> {
    if (ids.length === 0) return [];
    return this.database.bootstrapRead(
      { correlationId, reason: FLAGS_METADATA_REASON, tables: ['organizations'] },
      async (db) =>
        (await db.query<Row[]>(FLAGS_SQL.organizationsById(ids.length), [...ids])).map(
          toOrganization,
        ),
    );
  }

  /** The flag row, its overrides and the platform audit row, together. */
  async write(change: FlagWrite, audit: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        await tx.query(FLAGS_SQL.upsertFlag, [
          change.key,
          change.layer.enabled ? 1 : 0,
          change.layer.rollout,
          change.layer.percentage,
          change.layer.allowlist.length > 0 ? JSON.stringify(change.layer.allowlist) : null,
          audit.actorUserId,
        ]);
        for (const [organizationId, enabled] of change.overrides) {
          if (enabled === null) {
            await tx.query(FLAGS_SQL.removeOverride, [
              audit.actorUserId,
              change.key,
              organizationId,
            ]);
          } else {
            await tx.query(FLAGS_SQL.forceOverride, [
              uuidv7(),
              change.key,
              organizationId,
              enabled ? 1 : 0,
              audit.actorUserId,
            ]);
          }
        }
        await insertPlatformAudit(tx, audit);
      },
    );
  }
}

function toOrganization(row: Row): FlagOrganizationRow {
  return { id: String(row['id']), name: String(row['name']), slug: String(row['slug']) };
}
