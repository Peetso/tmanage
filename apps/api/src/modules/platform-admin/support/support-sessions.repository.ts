import { PLATFORM_SUPPORT_ROLE, uuidv7 } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2';
import type {
  SqlParameter,
  TenantDatabase,
  TenantQueryRunner,
} from '../../../common/database/tenant-context.js';
import type { ExistingMembership, SupportEndReason } from './hidden-membership.js';

/**
 * Support sessions (platform-admin v2 · PA-05, 0240) — `platform_support_sessions` and the hidden
 * `memberships` row each one opens.
 *
 * Two paths, as everywhere in the Platform admin:
 * - **writes** run on the tenant path, inside ONE transaction bound to the one organization being
 *   entered (a service context the caller builds): the session row (a global table), the
 *   membership row, the `policy_version` bumps and both audit rows commit together or not at all;
 * - **reads** for the platform screens run on the bootstrap path declared over `organizations`
 *   only (its name and slug) — the session and the admin's address live in global tables.
 *
 * No DELETE anywhere: a session ends by `ended_at`, a hidden row by `status = 'offboarded'`.
 */

type Row = RowDataPacket & Record<string, unknown>;

export const SUPPORT_SESSIONS_READ_REASON =
  'platform admin support sessions: the TManage operator lists support visits (who, which ' +
  'organization, when, how many actions) across tenants — metadata only, never content';

const SESSION_COLUMNS = `s.id as id, s.admin_user_id as admin_user_id,
  s.browser_session_id as browser_session_id, s.organization_id as organization_id,
  s.membership_id as membership_id, s.reason as reason, s.started_at as started_at,
  s.expires_at as expires_at, s.ended_at as ended_at, s.ended_reason as ended_reason,
  s.actions_count as actions_count, s.previous_role as previous_role,
  s.previous_has_org_wide_scope as previous_has_org_wide_scope`;

export const SUPPORT_SQL = {
  now: 'select current_timestamp(3) as now',
  lockOrganization: `select id, slug, name, suspended_at from organizations
    where id = ? limit 1 for update`,
  membershipFor: `select id, role, status, has_org_wide_scope from memberships
    where organization_id = ? and user_id = ? limit 1 for update`,
  liveFor: `select ${SESSION_COLUMNS} from platform_support_sessions s
    where s.admin_user_id = ? and s.organization_id = ? and s.ended_at is null
      and s.expires_at > current_timestamp(3)
    order by s.started_at desc limit 1`,
  rebindSession: `update platform_support_sessions set browser_session_id = ?
    where id = ? and ended_at is null`,
  insertSession: `insert into platform_support_sessions
      (id, admin_user_id, browser_session_id, organization_id, membership_id, reason,
       started_at, expires_at, actions_count, previous_role, previous_has_org_wide_scope)
    values (?, ?, ?, ?, null, ?, current_timestamp(3),
       date_add(current_timestamp(3), interval ? minute), 0, null, null)`,
  insertHiddenMembership: `insert into memberships
      (id, organization_id, user_id, role, status, has_org_wide_scope, workspace_scope_id,
       platform_support_session_id, version, policy_version, created_at, updated_at)
    values (?, ?, ?, '${PLATFORM_SUPPORT_ROLE}', 'active', 1, null, ?, 1, 1,
       current_timestamp(3), current_timestamp(3))`,
  /** Reactivate an old hidden row, or upgrade the admin's real row, for this session. */
  enterMembership: `update memberships
    set role = '${PLATFORM_SUPPORT_ROLE}', status = 'active', has_org_wide_scope = 1,
        platform_support_session_id = ?, version = version + 1,
        policy_version = policy_version + 1, updated_at = current_timestamp(3)
    where organization_id = ? and id = ?`,
  linkSession: `update platform_support_sessions
    set membership_id = ?, previous_role = ?, previous_has_org_wide_scope = ?
    where id = ?`,
  bumpOrganization: `update organizations set policy_version = policy_version + 1 where id = ?`,
  lockSession: `select ${SESSION_COLUMNS}, current_timestamp(3) as db_now
    from platform_support_sessions s where s.id = ? limit 1 for update`,
  endSession: `update platform_support_sessions
    set ended_at = current_timestamp(3), ended_reason = ?
    where id = ? and ended_at is null`,
  extendSession: `update platform_support_sessions set expires_at = ?
    where id = ? and ended_at is null`,
  offboardMembership: `update memberships
    set status = 'offboarded', version = version + 1, policy_version = policy_version + 1,
        updated_at = current_timestamp(3)
    where organization_id = ? and id = ? and role = '${PLATFORM_SUPPORT_ROLE}'
      and platform_support_session_id = ?`,
  restoreMembership: `update memberships
    set role = ?, status = ?, has_org_wide_scope = ?, platform_support_session_id = null,
        version = version + 1, policy_version = policy_version + 1,
        updated_at = current_timestamp(3)
    where organization_id = ? and id = ? and platform_support_session_id = ?`,
  openForBrowserSession: `select s.id as id, s.organization_id as organization_id
    from platform_support_sessions s
    where s.admin_user_id = ? and s.browser_session_id = ? and s.ended_at is null`,
  recentActions: `select action from audit_events
    where organization_id = ? and platform_support_session_id = ? and result = 'allowed'
    order by created_at desc, id desc limit ?`,
  list: (where: string) => `select ${SESSION_COLUMNS}, o.name as organization_name,
      o.slug as organization_slug, u.email as admin_email,
      current_timestamp(3) as db_now
    from platform_support_sessions s
    join organizations o on o.id = s.organization_id
    join users u on u.id = s.admin_user_id
    ${where}
    order by s.started_at desc, s.id desc limit ?`,
  adminEmail: `select email from users where id = ? limit 1`,
} as const;

/** One `platform_support_sessions` row. */
export interface SupportSessionRecord {
  readonly id: string;
  readonly adminUserId: string;
  readonly browserSessionId: string;
  readonly organizationId: string;
  readonly membershipId: string | null;
  readonly reason: string | null;
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly endedAt: Date | null;
  readonly endedReason: string | null;
  readonly actionsCount: number;
  readonly previousRole: string | null;
  readonly previousHasOrgWideScope: boolean | null;
}

/** The record with what the platform screens show beside it. */
export interface SupportSessionListRecord extends SupportSessionRecord {
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly adminEmail: string;
  /** The database clock when the row was read — "live" is judged on the server's time. */
  readonly now: Date;
}

export interface SupportSessionFilter {
  readonly state: 'open' | 'all';
  readonly adminUserId?: string | null;
  readonly organizationId?: string | null;
  readonly sessionId?: string | null;
  readonly limit: number;
}

export interface LockedOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly suspended: boolean;
}

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRecord(row: Row): SupportSessionRecord {
  const previousScope = row['previous_has_org_wide_scope'];
  return {
    id: String(row['id']),
    adminUserId: String(row['admin_user_id']),
    browserSessionId: String(row['browser_session_id']),
    organizationId: String(row['organization_id']),
    membershipId: text(row['membership_id']),
    reason: text(row['reason']),
    startedAt: date(row['started_at']) ?? new Date(0),
    expiresAt: date(row['expires_at']) ?? new Date(0),
    endedAt: date(row['ended_at']),
    endedReason: text(row['ended_reason']),
    actionsCount: Number(row['actions_count'] ?? 0),
    previousRole: text(row['previous_role']),
    previousHasOrgWideScope:
      previousScope === null || previousScope === undefined ? null : Boolean(Number(previousScope)),
  };
}

export class SupportSessionsRepository {
  constructor(private readonly database: TenantDatabase) {}

  // ── Inside the caller's one-organization transaction ─────────────────────────────────────────

  async now(tx: TenantQueryRunner): Promise<Date> {
    const rows = await tx.query<Row[]>(SUPPORT_SQL.now);
    return date(rows[0]?.['now']) ?? new Date();
  }

  async lockOrganization(
    tx: TenantQueryRunner,
    organizationId: string,
  ): Promise<LockedOrganization | null> {
    const rows = await tx.query<Row[]>(SUPPORT_SQL.lockOrganization, [organizationId]);
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row['id']),
      slug: String(row['slug']),
      name: String(row['name']),
      suspended: row['suspended_at'] !== null && row['suspended_at'] !== undefined,
    };
  }

  async membershipFor(
    tx: TenantQueryRunner,
    organizationId: string,
    userId: string,
  ): Promise<ExistingMembership | null> {
    const rows = await tx.query<Row[]>(SUPPORT_SQL.membershipFor, [organizationId, userId]);
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row['id']),
      role: String(row['role']),
      status: String(row['status']),
      hasOrgWideScope: Boolean(Number(row['has_org_wide_scope'] ?? 0)),
    };
  }

  async liveFor(
    tx: TenantQueryRunner,
    adminUserId: string,
    organizationId: string,
  ): Promise<SupportSessionRecord | null> {
    const rows = await tx.query<Row[]>(SUPPORT_SQL.liveFor, [adminUserId, organizationId]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Move a live visit to the admin's current browser session (a re-entry from a new sign-in). */
  async rebindBrowserSession(
    tx: TenantQueryRunner,
    sessionId: string,
    browserSessionId: string,
  ): Promise<void> {
    await tx.query(SUPPORT_SQL.rebindSession, [browserSessionId, sessionId]);
  }

  /** Insert the session row. Returns its id. */
  async insertSession(
    tx: TenantQueryRunner,
    input: {
      readonly adminUserId: string;
      readonly browserSessionId: string;
      readonly organizationId: string;
      readonly reason: string | null;
      readonly minutes: number;
    },
  ): Promise<string> {
    const id = uuidv7();
    await tx.query(SUPPORT_SQL.insertSession, [
      id,
      input.adminUserId,
      input.browserSessionId,
      input.organizationId,
      input.reason,
      input.minutes,
    ]);
    return id;
  }

  async insertHiddenMembership(
    tx: TenantQueryRunner,
    organizationId: string,
    userId: string,
    sessionId: string,
  ): Promise<string> {
    const id = uuidv7();
    await tx.query(SUPPORT_SQL.insertHiddenMembership, [id, organizationId, userId, sessionId]);
    return id;
  }

  async enterMembership(
    tx: TenantQueryRunner,
    organizationId: string,
    membershipId: string,
    sessionId: string,
  ): Promise<void> {
    await tx.query(SUPPORT_SQL.enterMembership, [sessionId, organizationId, membershipId]);
  }

  async linkSession(
    tx: TenantQueryRunner,
    sessionId: string,
    membershipId: string,
    previousRole: string | null,
    previousHasOrgWideScope: boolean | null,
  ): Promise<void> {
    await tx.query(SUPPORT_SQL.linkSession, [
      membershipId,
      previousRole,
      previousHasOrgWideScope === null ? null : previousHasOrgWideScope ? 1 : 0,
      sessionId,
    ]);
  }

  /** Kill every cached context of the organization (SPEC §3.2: on enter and on exit). */
  async bumpOrganization(tx: TenantQueryRunner, organizationId: string): Promise<void> {
    await tx.query(SUPPORT_SQL.bumpOrganization, [organizationId]);
  }

  /** The session row, locked, with the database clock. */
  async lockSession(
    tx: TenantQueryRunner,
    sessionId: string,
  ): Promise<{ readonly session: SupportSessionRecord; readonly now: Date } | null> {
    const rows = await tx.query<Row[]>(SUPPORT_SQL.lockSession, [sessionId]);
    const row = rows[0];
    if (!row) return null;
    return { session: toRecord(row), now: date(row['db_now']) ?? new Date() };
  }

  async endSession(
    tx: TenantQueryRunner,
    sessionId: string,
    reason: SupportEndReason,
  ): Promise<boolean> {
    const result = await tx.query<RowDataPacket[]>(SUPPORT_SQL.endSession, [reason, sessionId]);
    return affected(result) > 0;
  }

  async extendSession(tx: TenantQueryRunner, sessionId: string, expiresAt: Date): Promise<void> {
    await tx.query(SUPPORT_SQL.extendSession, [expiresAt, sessionId]);
  }

  async offboardMembership(
    tx: TenantQueryRunner,
    organizationId: string,
    membershipId: string,
    sessionId: string,
  ): Promise<void> {
    await tx.query(SUPPORT_SQL.offboardMembership, [organizationId, membershipId, sessionId]);
  }

  async restoreMembership(
    tx: TenantQueryRunner,
    input: {
      readonly organizationId: string;
      readonly membershipId: string;
      readonly sessionId: string;
      readonly role: string;
      readonly status: string;
      readonly hasOrgWideScope: boolean;
    },
  ): Promise<void> {
    await tx.query(SUPPORT_SQL.restoreMembership, [
      input.role,
      input.status,
      input.hasOrgWideScope ? 1 : 0,
      input.organizationId,
      input.membershipId,
      input.sessionId,
    ]);
  }

  async adminEmail(tx: TenantQueryRunner, userId: string): Promise<string | null> {
    const rows = await tx.query<Row[]>(SUPPORT_SQL.adminEmail, [userId]);
    return text(rows[0]?.['email']);
  }

  /** The last few actions taken inside the session, newest first (the exit dialog's list). */
  async recentActions(
    tx: TenantQueryRunner,
    organizationId: string,
    sessionId: string,
    limit: number,
  ): Promise<readonly string[]> {
    const rows = await tx.query<Row[]>(SUPPORT_SQL.recentActions, [
      organizationId,
      sessionId,
      limit,
    ]);
    return rows.map((row) => String(row['action']));
  }

  // ── Reads that run before (or without) a tenant context ──────────────────────────────────────

  async list(
    filter: SupportSessionFilter,
    correlationId: string,
  ): Promise<readonly SupportSessionListRecord[]> {
    const where: string[] = [];
    const params: SqlParameter[] = [];
    if (filter.state === 'open') {
      where.push('s.ended_at is null and s.expires_at > current_timestamp(3)');
    }
    if (filter.sessionId) {
      where.push('s.id = ?');
      params.push(filter.sessionId);
    }
    if (filter.adminUserId) {
      where.push('s.admin_user_id = ?');
      params.push(filter.adminUserId);
    }
    if (filter.organizationId) {
      where.push('s.organization_id = ?');
      params.push(filter.organizationId);
    }
    params.push(filter.limit);
    const sql = SUPPORT_SQL.list(where.length === 0 ? '' : `where ${where.join(' and ')}`);
    return this.database.bootstrapRead(
      { correlationId, reason: SUPPORT_SESSIONS_READ_REASON, tables: ['organizations'] },
      async (db) => {
        const rows = (await db.query(sql, params)) as unknown as Row[];
        return rows.map((row) => ({
          ...toRecord(row),
          organizationName: String(row['organization_name'] ?? ''),
          organizationSlug: String(row['organization_slug'] ?? ''),
          adminEmail: String(row['admin_email'] ?? ''),
          now: date(row['db_now']) ?? new Date(),
        }));
      },
    );
  }

  async findById(
    sessionId: string,
    correlationId: string,
  ): Promise<SupportSessionListRecord | null> {
    const rows = await this.list({ state: 'all', sessionId, limit: 1 }, correlationId);
    return rows[0] ?? null;
  }

  /** The sessions a browser session still holds open (sign-out ends them). */
  async openForBrowserSession(
    adminUserId: string,
    browserSessionId: string,
    correlationId: string,
  ): Promise<readonly { readonly id: string; readonly organizationId: string }[]> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_support_sessions'] },
      async (db) => {
        const rows = (await db.query(SUPPORT_SQL.openForBrowserSession, [
          adminUserId,
          browserSessionId,
        ])) as unknown as Row[];
        return rows.map((row) => ({
          id: String(row['id']),
          organizationId: String(row['organization_id']),
        }));
      },
    );
  }
}

function affected(result: unknown): number {
  const value = (result as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof value === 'number' ? value : 0;
}
