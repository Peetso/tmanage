import {
  isPlatformPreset,
  normalizePlatformPermissions,
  platformPermissionsFor,
  uuidv7,
} from '@tmanage/domain';
import type { PlatformNamedPreset, PlatformPermission, PlatformPreset } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2';
import type {
  IdentityQueryRunner,
  SqlParameter,
  TenantDatabase,
} from '../../common/database/tenant-context.js';
import type { PlatformAuditInput } from './platform-admin.repository.js';
import { insertPlatformAudit } from './platform-audit.service.js';

/**
 * The platform admin team (0239) — `platform_admins` and `platform_permission_presets`.
 *
 * Both tables are global (`NON_TENANT_TABLES`) and every statement here runs on the identity
 * path. Every write commits together with its `platform_admin_audit_events` row. There is no
 * DELETE anywhere (the app has no DELETE grant): removing an admin disables the row, which stays
 * as evidence of who held access when.
 */

export type PlatformAdminStatus = 'active' | 'disabled';

/** One `platform_admins` row with the permissions its preset (or list) resolves to. */
export interface PlatformAdminRecord {
  readonly id: string;
  readonly userId: string;
  readonly preset: PlatformPreset;
  /** The stored list, for `custom`; `null` for a named preset. */
  readonly customPermissions: readonly PlatformPermission[] | null;
  /** What the admin actually holds, resolved against the stored preset mapping. */
  readonly permissions: readonly PlatformPermission[];
  readonly status: PlatformAdminStatus;
}

export interface PlatformTeamRow extends PlatformAdminRecord {
  readonly email: string;
  readonly displayName: string;
  readonly createdBy: string | null;
  readonly createdByEmail: string | null;
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
  readonly disabledReason: string | null;
  readonly lastStepUpAt: Date | null;
}

export interface PlatformUserRow {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
  readonly verifiedAt: Date | null;
  readonly lastStepUpAt: Date | null;
}

export interface PlatformLiveSupportSessionRow {
  readonly id: string;
  readonly organizationId: string;
  readonly expiresAt: Date;
}

const ADMIN_TABLES = ['platform_admins', 'platform_permission_presets'] as const;
const TEAM_READ_TABLES = [
  'platform_admins',
  'platform_permission_presets',
  'users',
  'platform_admin_step_ups',
] as const;
const WRITE_TABLES = [
  'platform_admins',
  'platform_permission_presets',
  'platform_admin_audit_events',
] as const;

export const ADMINS_SQL = {
  forUser: `select id, user_id, preset, permissions_json, status from platform_admins
    where user_id = ? limit 1`,
  anyActive: `select id from platform_admins where status = 'active' limit 1`,
  presets: `select preset, permissions_json from platform_permission_presets`,
  team: `select a.id as id, a.user_id as user_id, a.preset as preset,
      a.permissions_json as permissions_json, a.status as status, a.created_by as created_by,
      a.created_at as created_at, a.disabled_at as disabled_at,
      a.disabled_reason as disabled_reason,
      u.email as email, u.display_name as display_name, cb.email as created_by_email,
      (select max(s.created_at) from platform_admin_step_ups s where s.user_id = a.user_id)
        as last_step_up_at
    from platform_admins a
    join users u on u.id = a.user_id
    left join users cb on cb.id = a.created_by
    order by a.created_at asc, a.id asc`,
  byId: `select id, user_id, preset, permissions_json, status from platform_admins
    where id = ? limit 1`,
  userByEmail: `select u.id as id, u.email as email, u.display_name as display_name,
      u.email_verified_at as email_verified_at,
      (select max(s.created_at) from platform_admin_step_ups s where s.user_id = u.id)
        as last_step_up_at
    from users u where u.email = ? limit 1`,
  userById: `select u.id as id, u.email as email, u.display_name as display_name,
      u.email_verified_at as email_verified_at,
      (select max(s.created_at) from platform_admin_step_ups s where s.user_id = u.id)
        as last_step_up_at
    from users u where u.id = ? limit 1`,
  usersByEmails: (n: number) => `select u.id as id, u.email as email,
      u.display_name as display_name, u.email_verified_at as email_verified_at,
      (select max(s.created_at) from platform_admin_step_ups s where s.user_id = u.id)
        as last_step_up_at
    from users u where u.email in (${Array.from({ length: n }, () => '?').join(', ')})`,
  insert: `insert into platform_admins
      (id, user_id, preset, permissions_json, status, created_by, created_at, updated_at)
    values (?, ?, ?, ?, 'active', ?, current_timestamp(3), current_timestamp(3))`,
  update: `update platform_admins
    set preset = ?, permissions_json = ?, status = ?,
        disabled_at = case when ? = 'disabled'
          then coalesce(disabled_at, current_timestamp(3)) else null end,
        disabled_reason = case when ? = 'disabled' then ? else null end,
        updated_at = current_timestamp(3)
    where id = ?`,
  writePreset: `insert into platform_permission_presets
      (preset, permissions_json, updated_by, updated_at)
    values (?, ?, ?, current_timestamp(3))
    on duplicate key update permissions_json = values(permissions_json),
      updated_by = values(updated_by), updated_at = current_timestamp(3)`,
  liveSupportSessions: `select id, organization_id, expires_at from platform_support_sessions
    where admin_user_id = ? and ended_at is null and expires_at > now(3)
    order by expires_at asc limit 20`,
} as const;

type Row = RowDataPacket & Record<string, unknown>;

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseList(raw: unknown): PlatformPermission[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    return normalizePlatformPermissions(JSON.parse(String(raw)));
  } catch {
    return [];
  }
}

export type StoredPresets = Partial<Record<PlatformNamedPreset, readonly PlatformPermission[]>>;

function toRecord(row: Row, presets: StoredPresets): PlatformAdminRecord {
  const stored = String(row['preset']);
  // An unknown preset value fails closed to an empty custom list.
  const preset: PlatformPreset = isPlatformPreset(stored) ? stored : 'custom';
  const custom = preset === 'custom' ? (parseList(row['permissions_json']) ?? []) : null;
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    preset,
    customPermissions: custom,
    permissions: platformPermissionsFor(preset, custom, presets),
    status: String(row['status']) === 'active' ? 'active' : 'disabled',
  };
}

function toUser(row: Row): PlatformUserRow {
  const verifiedAt = date(row['email_verified_at']);
  return {
    userId: String(row['id']),
    email: String(row['email']),
    displayName: String(row['display_name']),
    emailVerified: verifiedAt !== null,
    verifiedAt,
    lastStepUpAt: date(row['last_step_up_at']),
  };
}

async function readPresets(db: IdentityQueryRunner): Promise<StoredPresets> {
  const rows = await db.query<Row[]>(ADMINS_SQL.presets);
  const out: Record<string, readonly PlatformPermission[]> = {};
  for (const row of rows) {
    const preset = String(row['preset']);
    if (preset === 'support' || preset === 'auditor') {
      out[preset] = parseList(row['permissions_json']) ?? [];
    }
  }
  return out as StoredPresets;
}

export class PlatformAdminsRepository {
  constructor(private readonly database: TenantDatabase) {}

  async findForUser(userId: string, correlationId: string): Promise<PlatformAdminRecord | null> {
    return this.database.identityRead({ correlationId, tables: [...ADMIN_TABLES] }, async (db) => {
      const rows = await db.query<Row[]>(ADMINS_SQL.forUser, [userId]);
      const row = rows[0];
      if (!row) return null;
      return toRecord(row, await readPresets(db));
    });
  }

  async findById(adminId: string, correlationId: string): Promise<PlatformAdminRecord | null> {
    return this.database.identityRead({ correlationId, tables: [...ADMIN_TABLES] }, async (db) => {
      const rows = await db.query<Row[]>(ADMINS_SQL.byId, [adminId]);
      const row = rows[0];
      if (!row) return null;
      return toRecord(row, await readPresets(db));
    });
  }

  async anyActive(correlationId: string): Promise<boolean> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_admins'] },
      async (db) => (await db.query<Row[]>(ADMINS_SQL.anyActive)).length > 0,
    );
  }

  async storedPresets(correlationId: string): Promise<StoredPresets> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_permission_presets'] },
      readPresets,
    );
  }

  async listTeam(correlationId: string): Promise<readonly PlatformTeamRow[]> {
    return this.database.identityRead(
      { correlationId, tables: [...TEAM_READ_TABLES] },
      async (db) => {
        const presets = await readPresets(db);
        const rows = await db.query<Row[]>(ADMINS_SQL.team);
        return rows.map((row) => ({
          ...toRecord(row, presets),
          email: String(row['email']),
          displayName: String(row['display_name']),
          createdBy: text(row['created_by']),
          createdByEmail: text(row['created_by_email']),
          createdAt: date(row['created_at']) ?? new Date(0),
          disabledAt: date(row['disabled_at']),
          disabledReason: text(row['disabled_reason']),
          lastStepUpAt: date(row['last_step_up_at']),
        }));
      },
    );
  }

  async findUserByEmail(email: string, correlationId: string): Promise<PlatformUserRow | null> {
    return this.users(correlationId, ADMINS_SQL.userByEmail, [email.trim().toLowerCase()]);
  }

  async findUserById(userId: string, correlationId: string): Promise<PlatformUserRow | null> {
    return this.users(correlationId, ADMINS_SQL.userById, [userId]);
  }

  async findUsersByEmails(
    emails: readonly string[],
    correlationId: string,
  ): Promise<readonly PlatformUserRow[]> {
    if (emails.length === 0) return [];
    return this.database.identityRead(
      { correlationId, tables: ['users', 'platform_admin_step_ups'] },
      async (db) => {
        const rows = await db.query<Row[]>(ADMINS_SQL.usersByEmails(emails.length), [...emails]);
        return rows.map(toUser);
      },
    );
  }

  async liveSupportSessions(
    adminUserId: string,
    correlationId: string,
  ): Promise<readonly PlatformLiveSupportSessionRow[]> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_support_sessions'] },
      async (db) => {
        const rows = await db.query<Row[]>(ADMINS_SQL.liveSupportSessions, [adminUserId]);
        return rows.map((row) => ({
          id: String(row['id']),
          organizationId: String(row['organization_id']),
          expiresAt: date(row['expires_at']) ?? new Date(0),
        }));
      },
    );
  }

  /** Add a person to the team with their audit row. Returns the new admin id. */
  async insert(
    input: {
      readonly userId: string;
      readonly preset: PlatformPreset;
      readonly customPermissions: readonly PlatformPermission[] | null;
      readonly createdBy: string;
    },
    audit: PlatformAuditInput,
  ): Promise<string> {
    const id = uuidv7();
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        await tx.query(ADMINS_SQL.insert, [
          id,
          input.userId,
          input.preset,
          input.customPermissions === null ? null : JSON.stringify(input.customPermissions),
          input.createdBy,
        ]);
        await insertPlatformAudit(tx, { ...audit, targetId: id });
      },
    );
    return id;
  }

  /** Change preset, list or status, with the audit row, atomically. */
  async update(
    adminId: string,
    input: {
      readonly preset: PlatformPreset;
      readonly customPermissions: readonly PlatformPermission[] | null;
      readonly status: PlatformAdminStatus;
      readonly disabledReason: string | null;
    },
    audit: PlatformAuditInput,
  ): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        await tx.query(ADMINS_SQL.update, [
          input.preset,
          input.customPermissions === null ? null : JSON.stringify(input.customPermissions),
          input.status,
          input.status,
          input.status,
          input.disabledReason,
          adminId,
        ]);
        await insertPlatformAudit(tx, audit);
      },
    );
  }

  async writePreset(
    preset: PlatformNamedPreset,
    permissions: readonly PlatformPermission[],
    audit: PlatformAuditInput,
  ): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        await tx.query(ADMINS_SQL.writePreset, [
          preset,
          JSON.stringify(permissions),
          audit.actorUserId,
        ]);
        await insertPlatformAudit(tx, audit);
      },
    );
  }

  private async users(
    correlationId: string,
    sql: string,
    params: readonly SqlParameter[],
  ): Promise<PlatformUserRow | null> {
    return this.database.identityRead(
      { correlationId, tables: ['users', 'platform_admin_step_ups'] },
      async (db) => {
        const rows = await db.query<Row[]>(sql, [...params]);
        return rows[0] ? toUser(rows[0]) : null;
      },
    );
  }
}
