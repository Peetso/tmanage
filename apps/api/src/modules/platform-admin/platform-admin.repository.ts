import { uuidv7 } from '@tmanage/domain';
import type { RowDataPacket } from 'mysql2';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type {
  BootstrapQueryRunner,
  IdentityQueryRunner,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { likeContains, type PlatformBootstrapAccount } from './platform-admin.access.js';
import { revokeAllBearerCredentialsForUser } from '../identity/bearer-credentials.js';
import { PlatformAdminsRepository } from './platform-admins.repository.js';
import type { PlatformAdminRecord } from './platform-admins.repository.js';

/**
 * Platform admin — every statement the operator surface issues, and the limits on them.
 *
 * Three database paths, each the narrowest one that answers its question:
 *
 * 1. **Identity path** (`identityRead` / `identityTransaction`) for the global tables: the
 *    admin's own account, their step-up, the platform audit log, platform settings, and
 *    ending a person's sessions. These tables carry no `organization_id` and are registered
 *    in `NON_TENANT_TABLES`.
 * 2. **Bootstrap read** for the cross-company metadata — the only reads here that span
 *    tenants. It is read-only, audited with {@link PLATFORM_METADATA_REASON}, and limited to
 *    {@link PLATFORM_METADATA_TABLES}: organizations, memberships, client records, projects
 *    (counted, never their names), the plan, and usage/health counters. No content table —
 *    work items, messages, documents, files — is in the list, so the guard refuses any
 *    statement that reaches one (`platform-admin.repository.test.ts` holds every statement
 *    in this file to that list).
 * 3. **Tenant path** with a service context bound to ONE company, for the two things that
 *    belong to it: its admin/security audit events (metadata only — no `metadata_json`) and
 *    its suspension flag.
 */

export const PLATFORM_METADATA_REASON =
  'platform admin metadata: the TManage operator reads company counts, roles and dates across ' +
  'tenants (29-ENVIRONMENTS §12 support access) and never their work content';

/** The tenant-owned tables a cross-company read may name. Content tables are deliberately absent. */
export const PLATFORM_METADATA_TABLES = [
  'organizations',
  'memberships',
  'client_memberships',
  'client_organizations',
  'projects',
  'subscriptions',
  'usage_counters',
  'workflow_runs',
  'outbox_events',
  // ---- platform-admin v2 · append-only, limited to SPEC P2's list ----
  // ---- platform-admin v2 · PA-07 ----
  'organization_limits',
  // ---- platform-admin v2 · PA-09 ----
  // The rest of SPEC P2's list: the action log over `audit_events` (ids, action names, results,
  // IP/device — never `metadata_json` content; `audit_event_changes` is NOT here, the C2 detail
  // opens one organization through the tenant path) and the role/membership/flag metadata the
  // filters name. `authentication_events` is global and needs no entry.
  'audit_events',
  'custom_roles',
  'org_feature_flags',
  'project_memberships',
  'member_profiles',
] as const;

/** Global tables the identity path reaches. All registered in `NON_TENANT_TABLES`. */
const ACCOUNT_TABLES = ['users', 'user_mfa_factors', 'sessions'] as const;
const STEP_UP_TABLES = ['platform_admin_step_ups', 'platform_admin_audit_events'] as const;
const AUDIT_TABLES = ['platform_admin_audit_events'] as const;
const SETTINGS_TABLES = ['platform_settings', 'platform_admin_audit_events'] as const;
const SIGN_OUT_TABLES = ['sessions', 'platform_admin_audit_events'] as const;

/** Recorded on `sessions.revoked_reason` for a platform-forced sign-out. */
export const PLATFORM_SIGN_OUT_REASON = 'platform_admin_sign_out';

/**
 * The audit actions a company's detail page shows: administration and security only. Work,
 * chat, docs and file events are not listed — their action names alone say what was worked on.
 */
export const ADMIN_SECURITY_ACTION_PREFIXES = [
  'organization.',
  'membership.',
  'invitation.',
  'role.',
  'custom_role.',
  'security',
  'ip_allowlist',
  'policy',
  'org_policy',
  'org_settings',
  'session',
  'feature_flag',
  'audit',
  'billing',
  'subscription',
  'personal_access_token',
  'offboarding',
  'admin',
] as const;

export const MAX_COMPANIES = 200;
export const MAX_PEOPLE = 25;
export const MAX_COMPANY_AUDIT = 25;
export const MAX_PLATFORM_AUDIT = 200;

export interface PlatformAdminAccount {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
  readonly mfaEnabled: boolean;
}

export interface PlatformStepUp {
  readonly expiresAt: Date;
  readonly mfaVerified: boolean;
}

export interface PlatformAuditInput {
  readonly actorUserId: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetType:
    | 'platform'
    | 'organization'
    | 'user'
    | 'setting'
    | 'platform_admin'
    | 'platform_preset'
    | 'support_session'
    | 'content'
    | 'export';
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  /** Required on the destructive list, optional elsewhere (0239 made the column nullable). */
  readonly reason: string | null;
  readonly correlationId: string;
  /** Platform admin v2 (0239): where, what changed (redacted JSON), from where. */
  readonly organizationId?: string | null;
  readonly supportSessionId?: string | null;
  readonly beforeJson?: string | null;
  readonly afterJson?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface PlatformAuditEventRow {
  readonly id: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface PlatformOverviewRow {
  readonly companies: number;
  readonly suspendedCompanies: number;
  readonly people: number;
  readonly signups7d: number;
  readonly signups30d: number;
  readonly activeToday: number;
  readonly storageBytesUsed: number;
  readonly failedAutomationRuns7d: number;
  readonly outboxErrors: number;
  /** ADTRACK. Organizations created in the last 90 days, counted by their sign-up `utm_*`. */
  readonly signupSources: readonly PlatformSignupSourceRow[];
}

/** One sign-up source: a distinct `utm_*` combination and how many organizations it brought. */
export interface PlatformSignupSourceRow {
  readonly source: string | null;
  readonly medium: string | null;
  readonly campaign: string | null;
  readonly content: string | null;
  /** SEOD (B11). The referring site's host (`chatgpt.com`), when the browser sent one. */
  readonly referrerHost: string | null;
  readonly signups: number;
}

/** How far back "Where sign-ups came from" counts, and how many sources it lists. */
export const SIGNUP_SOURCE_WINDOW_DAYS = 90;
const SIGNUP_SOURCE_LIMIT = 50;

export interface PlatformCompanyRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly ownerEmail: string | null;
  readonly people: number;
  readonly clients: number;
  readonly projects: number;
  readonly planId: string | null;
  readonly createdAt: Date;
  readonly lastActiveAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly archivedAt: Date | null;
}

export interface PlatformCompanyAuditRow {
  readonly id: string;
  readonly action: string;
  readonly objectType: string;
  readonly result: string;
  readonly createdAt: Date;
}

export interface PlatformPersonRow {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
  readonly createdAt: Date;
  readonly lastSignInAt: Date | null;
  readonly mfaEnabled: boolean;
}

export interface PlatformPersonMembershipRow {
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly audience: 'internal' | 'client';
  readonly role: string;
  readonly status: string;
}

/** The company columns every list and detail read selects, as one fragment. */
const COMPANY_COLUMNS = `
  o.id as id, o.slug as slug, o.name as name, o.created_at as created_at,
  o.suspended_at as suspended_at, o.archived_at as archived_at,
  (select u.email from memberships m join users u on u.id = m.user_id
     where m.organization_id = o.id and m.role = 'owner' and m.status = 'active'
     order by m.created_at asc limit 1) as owner_email,
  (select count(*) from memberships m
     where m.organization_id = o.id and m.status = 'active'
       and m.role <> 'platform_support') as people,
  (select count(*) from client_organizations c
     where c.organization_id = o.id and c.archived_at is null) as clients,
  (select count(*) from projects p
     where p.organization_id = o.id and p.archived_at is null) as projects,
  (select s.plan_id from subscriptions s where s.organization_id = o.id limit 1) as plan_id,
  (select max(coalesce(se.rotated_at, se.created_at)) from memberships m
     join sessions se on se.user_id = m.user_id
     where m.organization_id = o.id and m.status = 'active') as last_active_at`;

export const SQL = {
  account: `select u.id as id, u.email as email, u.display_name as display_name,
      u.email_verified_at as email_verified_at,
      (select count(*) from user_mfa_factors f
         where f.user_id = u.id and f.confirmed_at is not null and f.disabled_at is null) as factors
    from users u where u.id = ? limit 1`,
  bootstrapAccounts: (count: number) => `select u.email_verified_at as email_verified_at,
      (select count(*) from user_mfa_factors f
         where f.user_id = u.id and f.confirmed_at is not null and f.disabled_at is null) as factors
    from users u where lower(u.email) in (${Array.from({ length: count }, () => '?').join(', ')})`,
  liveStepUp: `select expires_at, mfa_verified from platform_admin_step_ups
    where user_id = ? and session_id = ? and expires_at > now(3)
    order by expires_at desc limit 1`,
  insertStepUp: `insert into platform_admin_step_ups
      (id, user_id, session_id, mfa_verified, expires_at, created_at)
    values (?, ?, ?, ?, date_add(now(3), interval ? minute), current_timestamp(3))`,
  insertAudit: `insert into platform_admin_audit_events
      (id, actor_user_id, actor_email, action, target_type, target_id, target_label, reason,
       correlation_id, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, current_timestamp(3))`,
  listAudit: `select id, actor_email, action, target_type, target_id, target_label, reason, created_at
    from platform_admin_audit_events order by created_at desc, id desc limit ?`,
  overview: `select
      (select count(*) from organizations where archived_at is null) as companies,
      (select count(*) from organizations
         where archived_at is null and suspended_at is not null) as suspended_companies,
      (select count(distinct user_id) from memberships where status = 'active') as people,
      (select count(*) from organizations where created_at >= ?) as signups_7d,
      (select count(*) from organizations where created_at >= ?) as signups_30d,
      (select count(distinct user_id) from sessions
         where coalesce(rotated_at, created_at) >= ?) as active_today,
      (select coalesce(sum(used_value), 0) from usage_counters
         where metric_key = 'storage.bytes') as storage_bytes,
      (select count(*) from workflow_runs
         where status = 'failed' and started_at >= ?) as failed_runs_7d,
      (select count(*) from outbox_events
         where published_at is null and last_error is not null) as outbox_errors`,
  signupSources: `select signup_utm_source as source, signup_utm_medium as medium,
      signup_utm_campaign as campaign, signup_utm_content as content,
      signup_referrer_host as referrer_host, count(*) as signups
    from organizations
    where created_at >= ? and (signup_utm_source is not null or signup_utm_medium is not null
      or signup_utm_campaign is not null or signup_utm_content is not null
      or signup_referrer_host is not null)
    group by signup_utm_source, signup_utm_medium, signup_utm_campaign, signup_utm_content,
      signup_referrer_host
    order by signups desc, source, campaign, content, referrer_host limit ?`,
  listCompanies: `select ${COMPANY_COLUMNS} from organizations o
    order by o.created_at desc, o.id desc limit ?`,
  searchCompanies: `select ${COMPANY_COLUMNS} from organizations o
    where (o.name like ? or o.slug like ?)
    order by o.created_at desc, o.id desc limit ?`,
  company: `select ${COMPANY_COLUMNS} from organizations o where o.id = ? limit 1`,
  companyAudit: (prefixes: number) => `select id, action, object_type, result, created_at
    from audit_events where organization_id = ? and (${Array.from(
      { length: prefixes },
      () => 'action like ?',
    ).join(' or ')}) order by created_at desc, id desc limit ?`,
  setSuspended: (suspend: boolean) => `update organizations
    set suspended_at = ${suspend ? 'current_timestamp(3)' : 'null'},
        policy_version = policy_version + 1
    where id = ?`,
  people: `select u.id as id, u.email as email, u.display_name as display_name,
      u.email_verified_at as email_verified_at, u.created_at as created_at,
      (select max(se.created_at) from sessions se where se.user_id = u.id) as last_sign_in_at,
      (select count(*) from user_mfa_factors f
         where f.user_id = u.id and f.confirmed_at is not null and f.disabled_at is null) as factors
    from users u where u.email like ? order by u.email asc limit ?`,
  internalMemberships: (ids: number) => `select m.user_id as user_id, o.id as organization_id,
      o.name as organization_name, o.slug as organization_slug, m.role as role, m.status as status
    from memberships m join organizations o on o.id = m.organization_id
    where m.user_id in (${Array.from({ length: ids }, () => '?').join(', ')})
    order by o.name asc`,
  clientMemberships: (ids: number) => `select cm.user_id as user_id, o.id as organization_id,
      o.name as organization_name, o.slug as organization_slug, cm.role as role, cm.status as status
    from client_memberships cm join organizations o on o.id = cm.organization_id
    where cm.user_id in (${Array.from({ length: ids }, () => '?').join(', ')})
    order by o.name asc`,
  revokeSessions: `update sessions set revoked_at = current_timestamp(3), revoked_reason = ?
    where user_id = ? and revoked_at is null`,
  readSetting: `select setting_value from platform_settings where setting_key = ? limit 1`,
  organizationSlugs: (ids: number) => `select o.id as id, o.slug as slug from organizations o
    where o.id in (${Array.from({ length: ids }, () => '?').join(', ')})`,
  writeSetting: `insert into platform_settings (setting_key, setting_value, updated_by_user_id, updated_at)
    values (?, ?, ?, current_timestamp(3))
    on duplicate key update setting_value = values(setting_value),
      updated_by_user_id = values(updated_by_user_id), updated_at = current_timestamp(3)`,
} as const;

type Row = RowDataPacket & Record<string, unknown>;

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

function toCompany(row: Row): PlatformCompanyRow {
  return {
    id: String(row['id']),
    slug: String(row['slug']),
    name: String(row['name']),
    ownerEmail: text(row['owner_email']),
    people: num(row['people']),
    clients: num(row['clients']),
    projects: num(row['projects']),
    planId: text(row['plan_id']),
    createdAt: date(row['created_at']) ?? new Date(0),
    lastActiveAt: date(row['last_active_at']),
    suspendedAt: date(row['suspended_at']),
    archivedAt: date(row['archived_at']),
  };
}

export class PlatformAdminRepository {
  /** The team table (0239), shared with the team service and `me`. */
  readonly admins: PlatformAdminsRepository;

  constructor(private readonly database: TenantDatabase) {
    this.admins = new PlatformAdminsRepository(database);
  }

  // ── Platform admin v2 (PA-02): the DB half of the guard's lookup ─────────

  /** The person's `platform_admins` row with its resolved permissions, or `null`. */
  findPlatformAdmin(userId: string, correlationId: string): Promise<PlatformAdminRecord | null> {
    return this.admins.findForUser(userId, correlationId);
  }

  /** Whether any `platform_admins` row is active — the feature is on with an empty env list. */
  hasActivePlatformAdmins(correlationId: string): Promise<boolean> {
    return this.admins.anyActive(correlationId);
  }

  /** `id → slug` for a handful of organizations (metadata path). */
  async organizationSlugs(
    ids: readonly string[],
    correlationId: string,
  ): Promise<ReadonlyMap<string, string>> {
    if (ids.length === 0) return new Map();
    return this.metadata(correlationId, async (db) => {
      const rows = await db.query<Row[]>(SQL.organizationSlugs(ids.length), [...ids]);
      return new Map(rows.map((row) => [String(row['id']), String(row['slug'])]));
    });
  }

  // ── Identity path ────────────────────────────────────────────────────────

  async findAccount(userId: string, correlationId: string): Promise<PlatformAdminAccount | null> {
    return this.database.identityRead(
      { correlationId, tables: [...ACCOUNT_TABLES] },
      async (db) => {
        const rows = await db.query<Row[]>(SQL.account, [userId]);
        const row = rows[0];
        if (!row) return null;
        return {
          userId: String(row['id']),
          email: String(row['email']),
          displayName: String(row['display_name']),
          emailVerified:
            row['email_verified_at'] !== null && row['email_verified_at'] !== undefined,
          mfaEnabled: num(row['factors']) > 0,
        };
      },
    );
  }

  /**
   * PLATFORMFIX: the confirmed / two-step state of the accounts on the server list, for the one
   * start-up line (`platformBootstrapLine`). Lower-cased addresses in, no address out.
   */
  async bootstrapAccounts(
    emails: readonly string[],
    correlationId: string,
  ): Promise<readonly PlatformBootstrapAccount[]> {
    if (emails.length === 0) return [];
    return this.database.identityRead(
      { correlationId, tables: [...ACCOUNT_TABLES] },
      async (db) => {
        const rows = await db.query<Row[]>(SQL.bootstrapAccounts(emails.length), [...emails]);
        return rows.map((row) => ({
          emailVerified:
            row['email_verified_at'] !== null && row['email_verified_at'] !== undefined,
          mfaEnabled: num(row['factors']) > 0,
        }));
      },
    );
  }

  async findLiveStepUp(
    userId: string,
    sessionId: string,
    correlationId: string,
  ): Promise<PlatformStepUp | null> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_admin_step_ups'] },
      async (db) => {
        const rows = await db.query<Row[]>(SQL.liveStepUp, [userId, sessionId]);
        const row = rows[0];
        const expiresAt = row ? date(row['expires_at']) : null;
        return row && expiresAt ? { expiresAt, mfaVerified: num(row['mfa_verified']) === 1 } : null;
      },
    );
  }

  /** Record a step-up and its audit row in one transaction; returns the server-stamped expiry. */
  async recordStepUp(input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly mfaVerified: boolean;
    readonly minutes: number;
    readonly audit: PlatformAuditInput;
  }): Promise<Date> {
    const id = uuidv7();
    return this.database.identityTransaction(
      { correlationId: input.audit.correlationId, tables: [...STEP_UP_TABLES] },
      async (tx) => {
        await tx.query(SQL.insertStepUp, [
          id,
          input.userId,
          input.sessionId,
          input.mfaVerified ? 1 : 0,
          input.minutes,
        ]);
        await insertAudit(tx, input.audit);
        const rows = await tx.query<Row[]>(
          'select expires_at from platform_admin_step_ups where id = ? limit 1',
          [id],
        );
        return date(rows[0]?.['expires_at']) ?? new Date(Date.now() + input.minutes * 60_000);
      },
    );
  }

  async recordAudit(audit: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...AUDIT_TABLES] },
      (tx) => insertAudit(tx, audit),
    );
  }

  async listAudit(limit: number, correlationId: string): Promise<readonly PlatformAuditEventRow[]> {
    return this.database.identityRead({ correlationId, tables: [...AUDIT_TABLES] }, async (db) => {
      const rows = await db.query<Row[]>(SQL.listAudit, [limit]);
      return rows.map((row) => ({
        id: String(row['id']),
        actorEmail: String(row['actor_email']),
        action: String(row['action']),
        targetType: String(row['target_type']),
        targetId: text(row['target_id']),
        targetLabel: text(row['target_label']),
        reason: text(row['reason']),
        createdAt: date(row['created_at']) ?? new Date(0),
      }));
    });
  }

  /**
   * End every live session the person holds, with the audit row, atomically. F19 (wave 9): and
   * every personal access token and AI app grant they hold, in every organization - before the
   * session cutoff (a failure refuses the whole action) and again after it. Those rows are
   * tenant-owned, so they cannot join the identity transaction; see `bearer-credentials.ts`.
   */
  async signOutEverywhere(userId: string, audit: PlatformAuditInput): Promise<number> {
    await revokeAllBearerCredentialsForUser(this.database, userId, audit.correlationId);
    const ended = await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...SIGN_OUT_TABLES] },
      async (tx) => {
        await insertAudit(tx, audit);
        const result = await tx.query<RowDataPacket[]>(SQL.revokeSessions, [
          PLATFORM_SIGN_OUT_REASON,
          userId,
        ]);
        return num((result as unknown as { affectedRows?: number }).affectedRows);
      },
    );
    await revokeAllBearerCredentialsForUser(this.database, userId, audit.correlationId);
    return ended;
  }

  async readSetting(key: string, correlationId: string): Promise<string | null> {
    return this.database.identityRead(
      { correlationId, tables: ['platform_settings'] },
      async (db) => {
        const rows = await db.query<Row[]>(SQL.readSetting, [key]);
        return text(rows[0]?.['setting_value']);
      },
    );
  }

  async writeSetting(key: string, value: string, audit: PlatformAuditInput): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...SETTINGS_TABLES] },
      async (tx) => {
        await tx.query(SQL.writeSetting, [key, value, audit.actorUserId]);
        await insertAudit(tx, audit);
      },
    );
  }

  // ── Cross-company metadata (bootstrap read) ──────────────────────────────

  async overview(now: Date, correlationId: string): Promise<PlatformOverviewRow> {
    const day = 24 * 60 * 60 * 1000;
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    return this.metadata(correlationId, async (db) => {
      const rows = await db.query<Row[]>(SQL.overview, [
        new Date(now.getTime() - 7 * day),
        new Date(now.getTime() - 30 * day),
        startOfToday,
        new Date(now.getTime() - 7 * day),
      ]);
      const row = rows[0] ?? ({} as Row);
      const sources = await db.query<Row[]>(SQL.signupSources, [
        new Date(now.getTime() - SIGNUP_SOURCE_WINDOW_DAYS * day),
        SIGNUP_SOURCE_LIMIT,
      ]);
      return {
        companies: num(row['companies']),
        suspendedCompanies: num(row['suspended_companies']),
        people: num(row['people']),
        signups7d: num(row['signups_7d']),
        signups30d: num(row['signups_30d']),
        activeToday: num(row['active_today']),
        storageBytesUsed: num(row['storage_bytes']),
        failedAutomationRuns7d: num(row['failed_runs_7d']),
        outboxErrors: num(row['outbox_errors']),
        signupSources: sources.map((source) => ({
          source: text(source['source']),
          medium: text(source['medium']),
          campaign: text(source['campaign']),
          content: text(source['content']),
          referrerHost: text(source['referrer_host']),
          signups: num(source['signups']),
        })),
      };
    });
  }

  async listCompanies(
    search: string | null,
    correlationId: string,
  ): Promise<readonly PlatformCompanyRow[]> {
    return this.metadata(correlationId, async (db) => {
      const rows =
        search === null
          ? await db.query<Row[]>(SQL.listCompanies, [MAX_COMPANIES])
          : await db.query<Row[]>(SQL.searchCompanies, [
              likeContains(search),
              likeContains(search),
              MAX_COMPANIES,
            ]);
      return rows.map(toCompany);
    });
  }

  async findCompany(
    organizationId: string,
    correlationId: string,
  ): Promise<PlatformCompanyRow | null> {
    return this.metadata(correlationId, async (db) => {
      const rows = await db.query<Row[]>(SQL.company, [organizationId]);
      return rows[0] ? toCompany(rows[0]) : null;
    });
  }

  async searchPeople(
    fragment: string,
    correlationId: string,
  ): Promise<{
    readonly people: readonly PlatformPersonRow[];
    readonly memberships: readonly PlatformPersonMembershipRow[];
  }> {
    return this.metadata(correlationId, async (db) => {
      const rows = await db.query<Row[]>(SQL.people, [likeContains(fragment), MAX_PEOPLE]);
      const people = rows.map((row) => ({
        userId: String(row['id']),
        email: String(row['email']),
        displayName: String(row['display_name']),
        emailVerified: row['email_verified_at'] !== null && row['email_verified_at'] !== undefined,
        createdAt: date(row['created_at']) ?? new Date(0),
        lastSignInAt: date(row['last_sign_in_at']),
        mfaEnabled: num(row['factors']) > 0,
      }));
      if (people.length === 0) return { people, memberships: [] };
      const ids = people.map((person) => person.userId);
      const internal = await db.query<Row[]>(SQL.internalMemberships(ids.length), ids);
      const client = await db.query<Row[]>(SQL.clientMemberships(ids.length), ids);
      const memberships = [
        ...internal.map((row) => toMembership(row, 'internal')),
        ...client.map((row) => toMembership(row, 'client')),
      ];
      return { people, memberships };
    });
  }

  /** The one person a sign-out or reset names — looked up by id, never by a typed address. */
  async findPerson(userId: string, correlationId: string): Promise<PlatformAdminAccount | null> {
    return this.findAccount(userId, correlationId);
  }

  // ── One company (tenant path, service context) ───────────────────────────

  async listCompanyAudit(
    organizationId: string,
    correlationId: string,
  ): Promise<readonly PlatformCompanyAuditRow[]> {
    const context = platformContext(organizationId, correlationId);
    return this.database.read(context, async (db) => {
      const rows = await db.query<Row[]>(SQL.companyAudit(ADMIN_SECURITY_ACTION_PREFIXES.length), [
        organizationId,
        ...ADMIN_SECURITY_ACTION_PREFIXES.map((prefix) => `${prefix}%`),
        MAX_COMPANY_AUDIT,
      ]);
      return rows.map((row) => ({
        id: String(row['id']),
        action: String(row['action']),
        objectType: String(row['object_type']),
        result: String(row['result']),
        createdAt: date(row['created_at']) ?? new Date(0),
      }));
    });
  }

  /**
   * Suspend or reactivate one company, with the platform audit row, in one transaction. The
   * policy version moves so a context minted before the change cannot outlive it.
   */
  async setSuspended(
    organizationId: string,
    suspend: boolean,
    audit: PlatformAuditInput,
  ): Promise<void> {
    const context = platformContext(organizationId, audit.correlationId);
    await this.database.transaction(context, async (tx) => {
      await tx.query(SQL.setSuspended(suspend), [organizationId]);
      await insertAudit(tx, audit);
    });
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

function toMembership(row: Row, audience: 'internal' | 'client'): PlatformPersonMembershipRow {
  return {
    userId: String(row['user_id']),
    organizationId: String(row['organization_id']),
    organizationName: String(row['organization_name']),
    organizationSlug: String(row['organization_slug']),
    audience,
    role: String(row['role']),
    status: String(row['status']),
  };
}

function platformContext(organizationId: string, correlationId: string) {
  return createServiceContext({ organizationId, correlationId, policyVersion: 'platform-admin' });
}

async function insertAudit(
  tx: IdentityQueryRunner | TenantQueryRunner,
  audit: PlatformAuditInput,
): Promise<void> {
  // Platform admin v2 (0239): the full row — organization, support session, before/after, IP and
  // device ride along when the caller set them.
  await insertPlatformAudit(tx, audit);
}

/** The full insert. The 0206 nine-column `SQL.insertAudit` stays for older writers (maintenance). */
export const PLATFORM_AUDIT_INSERT_SQL = `insert into platform_admin_audit_events
    (id, actor_user_id, actor_email, action, target_type, target_id, target_label,
     organization_id, reason, correlation_id, created_at, support_session_id, before_json,
     after_json, ip, user_agent)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, current_timestamp(3), ?, ?, ?, ?, ?)`;

/** Write one platform audit row on a runner the caller holds (identity or tenant transaction). */
export async function insertPlatformAudit(
  tx: IdentityQueryRunner | TenantQueryRunner,
  audit: PlatformAuditInput,
): Promise<void> {
  await tx.query(PLATFORM_AUDIT_INSERT_SQL, [
    uuidv7(),
    audit.actorUserId,
    audit.actorEmail,
    audit.action,
    audit.targetType,
    audit.targetId,
    audit.targetLabel,
    audit.organizationId ?? null,
    audit.reason,
    audit.correlationId,
    audit.supportSessionId ?? null,
    audit.beforeJson ?? null,
    audit.afterJson ?? null,
    audit.ip ?? null,
    audit.userAgent ?? null,
  ]);
}
