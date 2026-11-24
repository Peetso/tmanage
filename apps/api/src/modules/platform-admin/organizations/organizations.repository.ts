import { isAiEmployeeEmail, uuidv7 } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2';
import { createServiceContext } from '../../../common/database/tenant-context.js';
import type {
  BootstrapQueryRunner,
  SqlParameter,
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../../common/database/tenant-context.js';
import { likeContains } from '../platform-admin.access.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import {
  insertPlatformAudit,
  PLATFORM_METADATA_REASON,
  PLATFORM_METADATA_TABLES,
} from '../platform-admin.repository.js';

/**
 * platform-admin v2 · PA-07 — every statement Platform admin · Organizations (A1–A7, A9) issues.
 *
 * The same three paths as `platform-admin.repository.ts`, each the narrowest that answers:
 *
 * 1. **Bootstrap read** across organizations — the list, the filters, the status counts, the
 *    deleted list and the overview tiles — limited to `PLATFORM_METADATA_TABLES` (no content
 *    table; `organizations.repository.test.ts` holds every cross-org statement here to it).
 * 2. **Identity path** for the global tables: `platform_settings` (the reader behind
 *    `billingMode()` and the retention window), `platform_support_sessions`, `users` (the owner
 *    an operator provisions an organization for), and the platform audit log.
 * 3. **Tenant path**, bound to ONE organization through a service context, for everything that
 *    belongs to it: its profile, plan and limits, storage, members and invitations, lifecycle.
 *    Each write carries its platform audit row in the same transaction.
 */

export const ORG_LIST_PAGE = 50;
export const ORG_AUDIT_ROWS = 10;
export const MAX_DELETED = 200;
export const MAX_MEMBERS = 500;
export const FAILED_RUN_WINDOW_DAYS = 7;

type Row = RowDataPacket & Record<string, unknown>;

/** The columns every list/detail read selects. `?` is the failed-runs window start. */
const ORG_COLUMNS = `
  o.id as id, o.slug as slug, o.name as name, o.created_at as created_at,
  o.default_locale as default_locale, o.timezone as timezone,
  o.suspended_at as suspended_at, o.archived_at as archived_at,
  o.deleted_at as deleted_at, o.purge_after as purge_after,
  o.deleted_by_user_id as deleted_by_user_id,
  o.billing_mode_override as billing_mode_override, o.operator_notes as operator_notes,
  (select u.email from memberships m join users u on u.id = m.user_id
     where m.organization_id = o.id and m.role = 'owner' and m.status = 'active'
     order by m.created_at asc limit 1) as owner_email,
  (select count(*) from memberships m
     where m.organization_id = o.id and m.status = 'active'
       and m.role <> 'platform_support' and m.kind = 'human') as people,
  (select count(*) from client_organizations c
     where c.organization_id = o.id and c.archived_at is null) as clients,
  (select count(*) from projects p
     where p.organization_id = o.id and p.archived_at is null) as projects,
  (select s.plan_id from subscriptions s where s.organization_id = o.id limit 1) as plan_id,
  (select coalesce(sum(uc.used_value), 0) from usage_counters uc
     where uc.organization_id = o.id and uc.metric_key = 'storage.bytes') as storage_bytes,
  (select l.people_limit from organization_limits l where l.organization_id = o.id) as people_limit,
  (select l.active_projects_limit from organization_limits l
     where l.organization_id = o.id) as active_projects_limit,
  (select l.storage_bytes_limit from organization_limits l
     where l.organization_id = o.id) as storage_bytes_limit,
  (select count(*) from workflow_runs w
     where w.organization_id = o.id and w.status = 'failed' and w.started_at >= ?) as failed_runs,
  (select max(coalesce(se.rotated_at, se.created_at)) from memberships m
     join sessions se on se.user_id = m.user_id
     where m.organization_id = o.id and m.status = 'active') as last_active_at`;

export type OrgStatusFilter = 'active' | 'suspended' | 'deleted' | 'archived';

export interface OrgListFilters {
  readonly q: string | null;
  readonly status: OrgStatusFilter | null;
  readonly plan: string | null;
  readonly createdFrom: Date | null;
  readonly createdTo: Date | null;
  readonly activeFrom: Date | null;
  readonly activeTo: Date | null;
  readonly cursor: { readonly createdAt: Date; readonly id: string } | null;
  readonly limit: number;
}

/** The status predicate per chip. Deleted wins over archived wins over suspended. */
const STATUS_PREDICATE: Record<OrgStatusFilter, string> = {
  active: 'o.deleted_at is null and o.archived_at is null and o.suspended_at is null',
  suspended: 'o.deleted_at is null and o.archived_at is null and o.suspended_at is not null',
  deleted: 'o.deleted_at is not null',
  archived: 'o.deleted_at is null and o.archived_at is not null',
};

export const ORG_SQL = {
  list(filters: OrgListFilters): { sql: string; params: SqlParameter[] } {
    const where: string[] = [];
    const params: SqlParameter[] = [];
    if (filters.q !== null) {
      where.push(`(o.name like ? or o.slug like ? or o.id = ? or exists (
        select 1 from memberships m join users u on u.id = m.user_id
        where m.organization_id = o.id and m.role = 'owner' and u.email like ?))`);
      const like = likeContains(filters.q);
      params.push(like, like, filters.q, like);
    }
    if (filters.status !== null) where.push(STATUS_PREDICATE[filters.status]);
    if (filters.plan !== null) {
      where.push(
        'exists (select 1 from subscriptions s where s.organization_id = o.id and s.plan_id = ?)',
      );
      params.push(filters.plan);
    }
    if (filters.createdFrom !== null) {
      where.push('o.created_at >= ?');
      params.push(filters.createdFrom);
    }
    if (filters.createdTo !== null) {
      where.push('o.created_at < ?');
      params.push(filters.createdTo);
    }
    if (filters.cursor !== null) {
      where.push('(o.created_at < ? or (o.created_at = ? and o.id < ?))');
      params.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id);
    }
    const having: string[] = [];
    const havingParams: SqlParameter[] = [];
    if (filters.activeFrom !== null) {
      having.push('last_active_at >= ?');
      havingParams.push(filters.activeFrom);
    }
    if (filters.activeTo !== null) {
      having.push('last_active_at < ?');
      havingParams.push(filters.activeTo);
    }
    const sql = `select ${ORG_COLUMNS} from organizations o
      ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
      ${having.length > 0 ? `having ${having.join(' and ')}` : ''}
      order by o.created_at desc, o.id desc limit ?`;
    return { sql, params: [...params, ...havingParams, filters.limit] };
  },
  statusCounts: `select count(*) as total,
      coalesce(sum(case when ${STATUS_PREDICATE.active} then 1 else 0 end), 0) as active,
      coalesce(sum(case when ${STATUS_PREDICATE.suspended} then 1 else 0 end), 0) as suspended,
      coalesce(sum(case when ${STATUS_PREDICATE.deleted} then 1 else 0 end), 0) as deleted,
      coalesce(sum(case when ${STATUS_PREDICATE.archived} then 1 else 0 end), 0) as archived,
      min(case when o.deleted_at is not null then o.purge_after end) as first_purge_at
    from organizations o`,
  one: `select ${ORG_COLUMNS} from organizations o where o.id = ? limit 1`,
  deleted: `select ${ORG_COLUMNS},
      (select u.email from users u where u.id = o.deleted_by_user_id) as deleted_by_email
    from organizations o where o.deleted_at is not null
    order by o.purge_after asc, o.id asc limit ?`,
  search: `select o.id as id, o.name as name, o.slug as slug from organizations o
    where o.name like ? or o.slug like ? or o.id = ?
    order by o.name asc limit 8`,
  slugOwner: `select o.id as id from organizations o where o.slug = ? limit 1`,
  userByEmail: `select u.id as id, u.email as email, u.display_name as display_name
    from users u where u.email = ? limit 1`,
  readSetting: `select setting_value from platform_settings where setting_key = ? limit 1`,
  openSupportSessions: `select count(*) as open_sessions, min(expires_at) as first_expiry
    from platform_support_sessions where ended_at is null and expires_at > ?`,
  orgSupportSessions: `select s.id as id, s.admin_user_id as admin_user_id, u.email as admin_email,
      u.display_name as admin_name, s.started_at as started_at, s.expires_at as expires_at,
      s.reason as reason, s.actions_count as actions_count
    from platform_support_sessions s left join users u on u.id = s.admin_user_id
    where s.organization_id = ? and s.ended_at is null and s.expires_at > ?
    order by s.started_at desc limit 10`,
  platformAuditForOrg: `select id, actor_email, action, target_type, target_label, reason, created_at
    from platform_admin_audit_events where organization_id = ?
    order by created_at desc, id desc limit ?`,
  recentPlatformActions: `select id, actor_email, action, target_type, target_label, organization_id,
      created_at
    from platform_admin_audit_events order by created_at desc, id desc limit 6`,
  // ── Tenant path: one organization ─────────────────────────────────────────
  orgAudit: `select a.id as id, a.action as action, a.object_type as object_type, a.result as result,
      a.created_at as created_at, u.email as actor_email
    from audit_events a left join users u on u.id = a.actor_user_id
    where a.organization_id = ? order by a.created_at desc, a.id desc limit ?`,
  invitedCount: `select count(*) as n from invitations i
    where i.organization_id = ? and i.status = 'pending'`,
  openApprovalsCount: `select count(*) as n from approvals ap
    where ap.organization_id = ? and ap.state in ('requested', 'viewed')`,
  failedRunsCount: `select count(*) as n from workflow_runs w
    where w.organization_id = ? and w.status = 'failed' and w.started_at >= ?`,
  overrideCounts: `select po.membership_id as membership_id, count(*) as n
    from membership_permission_overrides po
    where po.organization_id = ? and po.revoked_at is null group by po.membership_id`,
  connections: `select sc.id as id, sc.provider as provider, sc.status as status,
      sc.account_email as account_email, sc.location_name as location_name,
      sc.shared_drive_name as shared_drive_name, sc.onedrive_drive_name as onedrive_drive_name,
      sc.connected_at as connected_at, sc.updated_at as updated_at, u.email as connected_by_email
    from storage_connections sc left join users u on u.id = sc.connected_by_user_id
    where sc.organization_id = ? order by sc.provider asc`,
  disconnect: `update storage_connections
    set status = 'disconnected', refresh_token_enc = null,
        disconnected_at = current_timestamp(3), updated_at = current_timestamp(3)
    where organization_id = ? and id = ? and status <> 'disconnected'`,
  // 57-13a: only bytes on TManage's own store count; a version in Drive/OneDrive is the customer's.
  storageSum: `select coalesce(sum(size_bytes), 0) as bytes from file_versions
    where organization_id = ? and storage_backend = 'local'`,
  storageCounterUpdate: `update usage_counters
    set used_value = ?, reconciled_at = current_timestamp(3), version = version + 1
    where organization_id = ? and metric_key = 'storage.bytes'`,
  storageCounterInsert: `insert into usage_counters
      (id, organization_id, metric_key, used_value, reserved_value, version, reconciled_at)
    values (?, ?, 'storage.bytes', ?, 0, 1, current_timestamp(3))`,
  subscription: `select plan_id, status, current_period_end from subscriptions
    where organization_id = ? limit 1`,
  updatePlan: `update subscriptions set plan_id = ?, updated_at = current_timestamp(3)
    where organization_id = ?`,
  insertSubscription: `insert into subscriptions
      (id, organization_id, plan_id, status, created_at, updated_at)
    values (?, ?, ?, 'active', current_timestamp(3), current_timestamp(3))`,
  updateBillingOverride: `update organizations set billing_mode_override = ?,
      updated_at = current_timestamp(3) where id = ?`,
  upsertLimits: `insert into organization_limits
      (id, organization_id, people_limit, active_projects_limit, storage_bytes_limit, updated_by,
       created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, current_timestamp(3), current_timestamp(3))
    on duplicate key update people_limit = values(people_limit),
      active_projects_limit = values(active_projects_limit),
      storage_bytes_limit = values(storage_bytes_limit), updated_by = values(updated_by),
      updated_at = current_timestamp(3)`,
  updateProfile: `update organizations set name = ?, slug = ?, default_locale = ?, timezone = ?,
      operator_notes = ?, updated_at = current_timestamp(3) where id = ?`,
  members: `select m.id as id, m.user_id as user_id, m.role as role, m.status as status,
      m.version as version, m.created_at as created_at,
      u.email as email, u.display_name as display_name,
      (select max(se.created_at) from sessions se where se.user_id = m.user_id) as last_sign_in_at,
      (select count(*) from user_mfa_factors f where f.user_id = m.user_id
         and f.confirmed_at is not null and f.disabled_at is null) as factors
    from memberships m join users u on u.id = m.user_id
    where m.organization_id = ? and m.role <> 'platform_support' and m.status <> 'offboarded'
    order by (m.role = 'owner') desc, u.display_name asc limit ?`,
  clientMembers: `select cm.id as id, cm.user_id as user_id, cm.role as role, cm.status as status,
      u.email as email, u.display_name as display_name, c.name as client_name
    from client_memberships cm join users u on u.id = cm.user_id
    left join client_organizations c
      on c.organization_id = cm.organization_id and c.id = cm.client_organization_id
    where cm.organization_id = ? and cm.status <> 'offboarded'
    order by u.display_name asc limit ?`,
  invitations: `select i.id as id, i.email as email, i.role as role, i.status as status,
      i.expires_at as expires_at, i.created_at as created_at, u.email as invited_by_email
    from invitations i left join users u on u.id = i.invited_by_user_id
    where i.organization_id = ? and i.status = 'pending'
    order by i.created_at desc limit 200`,
  insertMembership: `insert into memberships
      (id, organization_id, user_id, role, status, has_org_wide_scope, version, created_at,
       updated_at)
    values (?, ?, ?, ?, 'active', ?, 1, current_timestamp(3), current_timestamp(3))`,
  softDelete: `update organizations set deleted_at = current_timestamp(3),
      purge_after = date_add(current_timestamp(3), interval ? day), deleted_by_user_id = ?,
      policy_version = policy_version + 1, updated_at = current_timestamp(3)
    where id = ? and deleted_at is null`,
  restore: `update organizations set deleted_at = null, purge_after = null,
      deleted_by_user_id = null, policy_version = policy_version + 1,
      updated_at = current_timestamp(3)
    where id = ? and deleted_at is not null and archived_at is null`,
  purgeNow: `update organizations set purge_after = current_timestamp(3),
      updated_at = current_timestamp(3) where id = ? and deleted_at is not null`,
  archive: `update organizations set archived_at = current_timestamp(3),
      policy_version = policy_version + 1, updated_at = current_timestamp(3)
    where id = ? and archived_at is null and deleted_at is null`,
  unarchive: `update organizations set archived_at = null,
      policy_version = policy_version + 1, updated_at = current_timestamp(3)
    where id = ? and archived_at is not null and deleted_at is null
      and not exists (select 1 from privacy_deletion_requests p
        where p.organization_id = ? and p.kind = 'company' and p.status = 'executed')`,
  policyRefresh: `update organizations set policy_version = policy_version + 1,
      updated_at = current_timestamp(3) where id = ?`,
} as const;

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface OrgRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly defaultLocale: string;
  readonly timezone: string;
  readonly suspendedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly purgeAfter: Date | null;
  readonly deletedByUserId: string | null;
  readonly deletedByEmail: string | null;
  readonly billingModeOverride: string | null;
  readonly operatorNotes: string | null;
  readonly ownerEmail: string | null;
  readonly people: number;
  readonly clients: number;
  readonly projects: number;
  readonly planId: string | null;
  readonly storageBytes: number;
  readonly peopleLimit: number | null;
  readonly activeProjectsLimit: number | null;
  readonly storageBytesLimit: number | null;
  readonly failedRuns: number;
  readonly lastActiveAt: Date | null;
}

export interface OrgStatusCounts {
  readonly total: number;
  readonly active: number;
  readonly suspended: number;
  readonly deleted: number;
  readonly archived: number;
  readonly firstPurgeAt: Date | null;
}

export interface OrgAuditRow {
  readonly id: string;
  readonly action: string;
  readonly objectType: string;
  readonly result: string;
  readonly actorEmail: string | null;
  readonly createdAt: Date;
}

export interface PlatformActionRow {
  readonly id: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetLabel: string | null;
  readonly organizationId: string | null;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface SupportSessionRow {
  readonly id: string;
  readonly adminEmail: string | null;
  readonly adminName: string | null;
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly reason: string | null;
  readonly actionsCount: number;
}

export interface ConnectionRow {
  readonly id: string;
  readonly provider: string;
  readonly status: string;
  readonly accountEmail: string | null;
  readonly location: string | null;
  readonly connectedByEmail: string | null;
  readonly lastSyncAt: Date | null;
}

export interface MemberRow {
  readonly id: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly version: number;
  readonly email: string;
  readonly displayName: string;
  readonly lastSignInAt: Date | null;
  readonly mfaEnabled: boolean;
  readonly overrides: number;
}

export interface ClientMemberRow {
  readonly id: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly email: string;
  readonly displayName: string;
  readonly clientName: string | null;
}

export interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly invitedByEmail: string | null;
}

export interface ProfileWrite {
  readonly name: string;
  readonly slug: string;
  readonly defaultLocale: string;
  readonly timezone: string;
  readonly operatorNotes: string | null;
}

export interface LimitsWrite {
  readonly people: number | null;
  readonly activeProjects: number | null;
  readonly storageBytes: number | null;
}

// ── Converters ───────────────────────────────────────────────────────────────

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function toOrgRow(row: Row): OrgRow {
  return {
    id: String(row['id']),
    slug: String(row['slug']),
    name: String(row['name']),
    createdAt: date(row['created_at']) ?? new Date(0),
    defaultLocale: text(row['default_locale']) ?? 'en',
    timezone: text(row['timezone']) ?? 'UTC',
    suspendedAt: date(row['suspended_at']),
    archivedAt: date(row['archived_at']),
    deletedAt: date(row['deleted_at']),
    purgeAfter: date(row['purge_after']),
    deletedByUserId: text(row['deleted_by_user_id']),
    deletedByEmail: text(row['deleted_by_email']),
    billingModeOverride: text(row['billing_mode_override']),
    operatorNotes: text(row['operator_notes']),
    ownerEmail: text(row['owner_email']),
    people: num(row['people']),
    clients: num(row['clients']),
    projects: num(row['projects']),
    planId: text(row['plan_id']),
    storageBytes: num(row['storage_bytes']),
    peopleLimit: numOrNull(row['people_limit']),
    activeProjectsLimit: numOrNull(row['active_projects_limit']),
    storageBytesLimit: numOrNull(row['storage_bytes_limit']),
    failedRuns: num(row['failed_runs']),
    lastActiveAt: date(row['last_active_at']),
  };
}

function toAction(row: Row): PlatformActionRow {
  return {
    id: String(row['id']),
    actorEmail: String(row['actor_email']),
    action: String(row['action']),
    targetType: String(row['target_type']),
    targetLabel: text(row['target_label']),
    organizationId: text(row['organization_id']),
    reason: text(row['reason']),
    createdAt: date(row['created_at']) ?? new Date(0),
  };
}

/** A duplicate-slug insert or update (the unique key on `organizations.slug`). */
export function isDuplicateSlug(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? '');
  return code === 'ER_DUP_ENTRY' && message.includes('uq_organizations_slug');
}

/** The service context a platform write runs under, bound to one organization. */
export function platformOrgContext(organizationId: string, correlationId: string): TenantContext {
  return createServiceContext({ organizationId, correlationId, policyVersion: 'platform-admin' });
}

export class PlatformOrganizationsRepository {
  constructor(private readonly database: TenantDatabase) {}

  // ── Global: settings, users, support sessions, platform audit ─────────────

  async readSetting(key: string, correlationId: string): Promise<string | null> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_settings'] },
      async (db) => {
        const rows = await db.query<Row[]>(ORG_SQL.readSetting, [key]);
        return rows[0] ? text(rows[0]['setting_value']) : null;
      },
    );
  }

  async findUserByEmail(
    email: string,
    correlationId: string,
  ): Promise<{ readonly id: string; readonly email: string; readonly displayName: string } | null> {
    // 60-04 door: the platform never adds an AI employee's user to a company (as a member or an
    // owner); to the platform screens that address has no account.
    if (isAiEmployeeEmail(email.trim().toLowerCase())) return null;
    return this.database.identityRead({ correlationId, tables: ['users'] }, async (db) => {
      const rows = await db.query<Row[]>(ORG_SQL.userByEmail, [email]);
      const row = rows[0];
      return row
        ? {
            id: String(row['id']),
            email: String(row['email']),
            displayName: String(row['display_name']),
          }
        : null;
    });
  }

  async openSupportSessions(
    now: Date,
    correlationId: string,
  ): Promise<{ readonly open: number; readonly firstExpiry: Date | null }> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_support_sessions'] },
      async (db) => {
        const rows = await db.query<Row[]>(ORG_SQL.openSupportSessions, [now]);
        return {
          open: num(rows[0]?.['open_sessions']),
          firstExpiry: date(rows[0]?.['first_expiry']),
        };
      },
    );
  }

  async supportSessionsFor(
    organizationId: string,
    now: Date,
    correlationId: string,
  ): Promise<readonly SupportSessionRow[]> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_support_sessions', 'users'] },
      async (db) => {
        const rows = await db.query<Row[]>(ORG_SQL.orgSupportSessions, [organizationId, now]);
        return rows.map((row) => ({
          id: String(row['id']),
          adminEmail: text(row['admin_email']),
          adminName: text(row['admin_name']),
          startedAt: date(row['started_at']) ?? new Date(0),
          expiresAt: date(row['expires_at']) ?? new Date(0),
          reason: text(row['reason']),
          actionsCount: num(row['actions_count']),
        }));
      },
    );
  }

  async platformActionsFor(
    organizationId: string,
    limit: number,
    correlationId: string,
  ): Promise<readonly PlatformActionRow[]> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_admin_audit_events'] },
      async (db) => {
        const rows = await db.query<Row[]>(ORG_SQL.platformAuditForOrg, [organizationId, limit]);
        return rows.map((row) => toAction({ ...row, organization_id: organizationId } as Row));
      },
    );
  }

  async recentPlatformActions(correlationId: string): Promise<readonly PlatformActionRow[]> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_admin_audit_events'] },
      async (db) => (await db.query<Row[]>(ORG_SQL.recentPlatformActions, [])).map(toAction),
    );
  }

  /** One platform audit row in a transaction of its own (a refused or no-op act still leaves one). */
  async recordAudit(audit: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: ['platform_admin_audit_events'] },
      (tx) => insertPlatformAudit(tx, audit),
    );
  }

  // ── Cross-organization metadata (bootstrap read) ─────────────────────────

  async list(
    filters: OrgListFilters,
    now: Date,
    correlationId: string,
  ): Promise<readonly OrgRow[]> {
    const { sql, params } = ORG_SQL.list(filters);
    return this.metadata(correlationId, async (db) =>
      (await db.query<Row[]>(sql, [failedWindow(now), ...params])).map(toOrgRow),
    );
  }

  async statusCounts(correlationId: string): Promise<OrgStatusCounts> {
    return this.metadata(correlationId, async (db) => {
      const row = (await db.query<Row[]>(ORG_SQL.statusCounts, []))[0] ?? ({} as Row);
      return {
        total: num(row['total']),
        active: num(row['active']),
        suspended: num(row['suspended']),
        deleted: num(row['deleted']),
        archived: num(row['archived']),
        firstPurgeAt: date(row['first_purge_at']),
      };
    });
  }

  async find(organizationId: string, now: Date, correlationId: string): Promise<OrgRow | null> {
    return this.metadata(correlationId, async (db) => {
      const rows = await db.query<Row[]>(ORG_SQL.one, [failedWindow(now), organizationId]);
      return rows[0] ? toOrgRow(rows[0]) : null;
    });
  }

  async deleted(now: Date, correlationId: string): Promise<readonly OrgRow[]> {
    return this.metadata(correlationId, async (db) =>
      (await db.query<Row[]>(ORG_SQL.deleted, [failedWindow(now), MAX_DELETED])).map(toOrgRow),
    );
  }

  async search(
    q: string,
    correlationId: string,
  ): Promise<readonly { readonly id: string; readonly name: string; readonly slug: string }[]> {
    return this.metadata(correlationId, async (db) => {
      const like = likeContains(q);
      const rows = await db.query<Row[]>(ORG_SQL.search, [like, like, q]);
      return rows.map((row) => ({
        id: String(row['id']),
        name: String(row['name']),
        slug: String(row['slug']),
      }));
    });
  }

  /** The organization holding `slug`, or `null` when it is free. */
  async slugOwner(slug: string, correlationId: string): Promise<string | null> {
    return this.metadata(correlationId, async (db) => {
      const rows = await db.query<Row[]>(ORG_SQL.slugOwner, [slug]);
      return rows[0] ? String(rows[0]['id']) : null;
    });
  }

  // ── One organization (tenant path) ───────────────────────────────────────

  async detailCounts(
    organizationId: string,
    now: Date,
    correlationId: string,
  ): Promise<{
    readonly invited: number;
    readonly openApprovals: number;
    readonly failedRuns: number;
  }> {
    return this.read(organizationId, correlationId, async (db) => {
      const count = async (sql: string, params: SqlParameter[]) =>
        num((await db.query<Row[]>(sql, params))[0]?.['n']);
      return {
        invited: await count(ORG_SQL.invitedCount, [organizationId]),
        openApprovals: await count(ORG_SQL.openApprovalsCount, [organizationId]),
        failedRuns: await count(ORG_SQL.failedRunsCount, [organizationId, failedWindow(now)]),
      };
    });
  }

  async orgAudit(
    organizationId: string,
    limit: number,
    correlationId: string,
  ): Promise<readonly OrgAuditRow[]> {
    return this.read(organizationId, correlationId, async (db) => {
      const rows = await db.query<Row[]>(ORG_SQL.orgAudit, [organizationId, limit]);
      return rows.map((row) => ({
        id: String(row['id']),
        action: String(row['action']),
        objectType: String(row['object_type']),
        result: String(row['result']),
        actorEmail: text(row['actor_email']),
        createdAt: date(row['created_at']) ?? new Date(0),
      }));
    });
  }

  async connections(
    organizationId: string,
    correlationId: string,
  ): Promise<readonly ConnectionRow[]> {
    return this.read(organizationId, correlationId, async (db) => {
      const rows = await db.query<Row[]>(ORG_SQL.connections, [organizationId]);
      return rows.map((row) => ({
        id: String(row['id']),
        provider: String(row['provider']),
        status: String(row['status']),
        accountEmail: text(row['account_email']),
        location:
          text(row['location_name']) ??
          text(row['shared_drive_name']) ??
          text(row['onedrive_drive_name']),
        connectedByEmail: text(row['connected_by_email']),
        lastSyncAt: date(row['updated_at']) ?? date(row['connected_at']),
      }));
    });
  }

  async subscription(
    organizationId: string,
    correlationId: string,
  ): Promise<{
    readonly planId: string;
    readonly status: string;
    readonly currentPeriodEnd: Date | null;
  } | null> {
    return this.read(organizationId, correlationId, async (db) => {
      const row = (await db.query<Row[]>(ORG_SQL.subscription, [organizationId]))[0];
      return row
        ? {
            planId: String(row['plan_id']),
            status: String(row['status']),
            currentPeriodEnd: date(row['current_period_end']),
          }
        : null;
    });
  }

  async members(
    organizationId: string,
    correlationId: string,
  ): Promise<{
    readonly internal: readonly MemberRow[];
    readonly clients: readonly ClientMemberRow[];
    readonly invitations: readonly InvitationRow[];
  }> {
    return this.read(organizationId, correlationId, async (db) => {
      const internal = await db.query<Row[]>(ORG_SQL.members, [organizationId, MAX_MEMBERS]);
      const clients = await db.query<Row[]>(ORG_SQL.clientMembers, [organizationId, MAX_MEMBERS]);
      const invitations = await db.query<Row[]>(ORG_SQL.invitations, [organizationId]);
      const overrides = new Map(
        (await db.query<Row[]>(ORG_SQL.overrideCounts, [organizationId])).map((row) => [
          String(row['membership_id']),
          num(row['n']),
        ]),
      );
      return {
        internal: internal.map((row) => ({
          id: String(row['id']),
          userId: String(row['user_id']),
          role: String(row['role']),
          status: String(row['status']),
          version: num(row['version']),
          email: String(row['email']),
          displayName: String(row['display_name']),
          lastSignInAt: date(row['last_sign_in_at']),
          mfaEnabled: num(row['factors']) > 0,
          overrides: overrides.get(String(row['id'])) ?? 0,
        })),
        clients: clients.map((row) => ({
          id: String(row['id']),
          userId: String(row['user_id']),
          role: String(row['role']),
          status: String(row['status']),
          email: String(row['email']),
          displayName: String(row['display_name']),
          clientName: text(row['client_name']),
        })),
        invitations: invitations.map((row) => ({
          id: String(row['id']),
          email: String(row['email']),
          role: String(row['role']),
          status: String(row['status']),
          expiresAt: date(row['expires_at']) ?? new Date(0),
          createdAt: date(row['created_at']) ?? new Date(0),
          invitedByEmail: text(row['invited_by_email']),
        })),
      };
    });
  }

  /** Run `work` and its platform audit row in ONE tenant transaction bound to the organization. */
  async write<T>(
    organizationId: string,
    audit: PlatformAuditInput,
    work: (tx: TenantQueryRunner, context: TenantContext) => Promise<T>,
    context: TenantContext = platformOrgContext(organizationId, audit.correlationId),
  ): Promise<T> {
    return this.database.transaction(context, async (tx) => {
      const result = await work(tx, context);
      await insertPlatformAudit(tx, audit);
      return result;
    });
  }

  // Statement helpers a `write` callback calls on its transaction.

  static async updateProfile(
    tx: TenantQueryRunner,
    id: string,
    write: ProfileWrite,
  ): Promise<void> {
    await tx.query(ORG_SQL.updateProfile, [
      write.name,
      write.slug,
      write.defaultLocale,
      write.timezone,
      write.operatorNotes,
      id,
    ]);
  }

  static async setPlan(
    tx: TenantQueryRunner,
    id: string,
    planId: string | null,
    override: string | null,
  ): Promise<void> {
    if (planId !== null) {
      const result = await tx.query(ORG_SQL.updatePlan, [planId, id]);
      if (affected(result) === 0)
        await tx.query(ORG_SQL.insertSubscription, [uuidv7(), id, planId]);
    }
    await tx.query(ORG_SQL.updateBillingOverride, [override, id]);
  }

  static async setLimits(
    tx: TenantQueryRunner,
    id: string,
    limits: LimitsWrite,
    by: string,
  ): Promise<void> {
    await tx.query(ORG_SQL.upsertLimits, [
      uuidv7(),
      id,
      limits.people,
      limits.activeProjects,
      limits.storageBytes,
      by,
    ]);
  }

  static async recount(tx: TenantQueryRunner, id: string): Promise<number> {
    const rows = await tx.query<Row[]>(ORG_SQL.storageSum, [id]);
    const bytes = num(rows[0]?.['bytes']);
    const result = await tx.query(ORG_SQL.storageCounterUpdate, [bytes, id]);
    if (affected(result) === 0) await tx.query(ORG_SQL.storageCounterInsert, [uuidv7(), id, bytes]);
    return bytes;
  }

  static async disconnect(
    tx: TenantQueryRunner,
    id: string,
    connectionId: string,
  ): Promise<boolean> {
    return affected(await tx.query(ORG_SQL.disconnect, [id, connectionId])) > 0;
  }

  static async addMember(
    tx: TenantQueryRunner,
    id: string,
    userId: string,
    role: string,
    orgWide: boolean,
  ): Promise<string> {
    const membershipId = uuidv7();
    await tx.query(ORG_SQL.insertMembership, [membershipId, id, userId, role, orgWide]);
    return membershipId;
  }

  static async softDelete(
    tx: TenantQueryRunner,
    id: string,
    days: number,
    by: string,
  ): Promise<boolean> {
    return affected(await tx.query(ORG_SQL.softDelete, [days, by, id])) > 0;
  }

  static async restore(tx: TenantQueryRunner, id: string): Promise<boolean> {
    return affected(await tx.query(ORG_SQL.restore, [id])) > 0;
  }

  static async purgeNow(tx: TenantQueryRunner, id: string): Promise<boolean> {
    return affected(await tx.query(ORG_SQL.purgeNow, [id])) > 0;
  }

  static async archive(tx: TenantQueryRunner, id: string, on: boolean): Promise<boolean> {
    return (
      affected(await tx.query(on ? ORG_SQL.archive : ORG_SQL.unarchive, on ? [id] : [id, id])) > 0
    );
  }

  static async policyRefresh(tx: TenantQueryRunner, id: string): Promise<void> {
    await tx.query(ORG_SQL.policyRefresh, [id]);
  }

  private read<T>(
    organizationId: string,
    correlationId: string,
    work: (db: TenantQueryRunner) => Promise<T>,
  ): Promise<T> {
    return this.database.read(platformOrgContext(organizationId, correlationId), work);
  }

  private metadata<T>(
    correlationId: string,
    work: (db: BootstrapQueryRunner) => Promise<T>,
  ): Promise<T> {
    return this.database.bootstrapRead(
      { correlationId, reason: PLATFORM_METADATA_REASON, tables: [...PLATFORM_METADATA_TABLES] },
      work,
    );
  }
}

function failedWindow(now: Date): Date {
  return new Date(now.getTime() - FAILED_RUN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

function affected(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  const rows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}
