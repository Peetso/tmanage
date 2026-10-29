import type { RowDataPacket } from 'mysql2';
import { createServiceContext } from '../../../common/database/tenant-context.js';
import type {
  BootstrapQueryRunner,
  IdentityQueryRunner,
  TenantDatabase,
} from '../../../common/database/tenant-context.js';
import { unwrapQueryError } from '../../../common/database/query-error.js';
import { revokeAllBearerCredentialsForUser } from '../../identity/bearer-credentials.js';
import type { CredentialsRepository } from '../../identity/credentials.repository.js';
import { EMAIL_CHANGED_ACTION } from '../../identity/credential-change/email-change-notice.js';
import { likeContains } from '../platform-admin.access.js';
import {
  PLATFORM_METADATA_REASON,
  PLATFORM_METADATA_TABLES,
  PLATFORM_SIGN_OUT_REASON,
  insertPlatformAudit,
} from '../platform-admin.repository.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';

/**
 * Platform admin v2 · People (PA-06, SPEC §4 B1–B4, §5.3) — every statement the People screens
 * issue, on the narrowest path that answers each question:
 *
 * - **Metadata path** (`bootstrapRead`, the platform reason) for the cross-organization reads: the
 *   people list with its filters, a person's memberships, their actions across organizations
 *   (`audit_events` metadata only: action, object type, result, time — never `metadata_json`).
 *   The table list is `PLATFORM_METADATA_TABLES` plus SPEC P2's `audit_events` and
 *   `custom_roles`; no content table is named.
 * - **Identity path** for the person's own global rows: the account, sessions, factors, recovery
 *   codes, sign-in events, and every write (profile, disable/enable, two-step, end a session),
 *   each with its platform audit row in the same transaction.
 * - **Tenant path**, one organization at a time, for the overrides count of one membership.
 */

/** SPEC P2: the metadata tables People reads beyond the shared list. Content stays out. */
export const PEOPLE_METADATA_TABLES: readonly string[] = [
  ...new Set<string>([...PLATFORM_METADATA_TABLES, 'audit_events', 'custom_roles']),
];

/** Bearer counts (tokens, AI app grants) are read with the bearer cutoff's own declared tables. */
const BEARER_COUNT_REASON =
  'platform admin people: counting the personal access tokens and AI app grants one person ' +
  'holds across organizations (metadata only, never the token)';
const BEARER_TABLES = ['personal_access_tokens', 'oauth_grants'] as const;

const ACCOUNT_TABLES = [
  'users',
  'sessions',
  'user_mfa_factors',
  'user_recovery_codes',
  'user_passwords',
  'authentication_events',
  'platform_admin_step_ups',
  'platform_admin_audit_events',
] as const;
const WRITE_TABLES = [
  'users',
  'sessions',
  'user_mfa_factors',
  'user_recovery_codes',
  'authentication_events',
  'credential_change_notices',
  'platform_admin_audit_events',
] as const;

/** `sessions.revoked_reason` values the People screens write. */
export const PEOPLE_REVOCATION_REASONS = {
  disabled: 'platform_admin_disabled',
  emailChanged: 'platform_admin_email_changed',
  endOne: 'platform_admin_end_session',
  signOut: PLATFORM_SIGN_OUT_REASON,
} as const;

export const PEOPLE_PAGE_SIZE = 25;
export const PEOPLE_RECENT_LIMIT = 10;
export const PEOPLE_ACCESS_LIMIT = 100;
export const PEOPLE_ACTIONS_PAGE_SIZE = 50;

type Row = RowDataPacket & Record<string, unknown>;

export interface PeopleFilter {
  readonly q: string | null;
  readonly status: 'active' | 'disabled' | null;
  readonly verified: boolean | null;
  readonly mfa: boolean | null;
  readonly locale: string | null;
  readonly organizationId: string | null;
  readonly role: string | null;
  readonly signInFrom: Date | null;
  readonly signInTo: Date | null;
  readonly hasSessions: boolean | null;
  /** Keyset: the last id of the previous page (ids are UUIDv7, time-ordered). */
  readonly cursor: string | null;
  readonly limit: number;
}

export interface PersonRow {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
  readonly timezone: string;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
  readonly lastSignInAt: Date | null;
  readonly lastSignInUserAgent: string | null;
  readonly mfaEnabled: boolean;
  readonly liveSessions: number;
  readonly disabledAt: Date | null;
  readonly disabledReason: string | null;
  readonly disabledByEmail: string | null;
  readonly twoStepRequiredAt: Date | null;
}

export interface MembershipRow {
  readonly userId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly organizationSuspendedAt: Date | null;
  readonly organizationArchivedAt: Date | null;
  readonly audience: 'internal' | 'client';
  readonly role: string;
  readonly customRoleName: string | null;
  readonly status: string;
  readonly orgWide: boolean;
  readonly clientOrganizationName: string | null;
  readonly createdAt: Date;
}

export interface SecurityFacts {
  readonly factorKind: string | null;
  readonly factorConfirmedAt: Date | null;
  readonly recoveryCodesLeft: number;
  readonly passwordSetAt: Date | null;
}

export interface BearerCounts {
  readonly personalAccessTokens: number;
  readonly aiAppGrants: number;
  readonly aiAppNames: readonly string[];
}

export interface SessionRowView {
  readonly id: string;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly lastActiveAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
  readonly ipFirst: string | null;
  readonly ipLast: string | null;
  readonly expired: boolean;
}

export interface AccessRow {
  readonly id: string;
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly occurredAt: Date;
}

export interface StepUpRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly mfaVerified: boolean;
}

export interface ActionRow {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly action: string;
  readonly objectType: string;
  readonly result: string;
  readonly occurredAt: Date;
  readonly viaSupport: boolean;
}

export interface OverrideCounts {
  readonly allow: number;
  readonly deny: number;
  readonly projects: number;
}

export interface ProfileChange {
  readonly displayName?: string;
  readonly email?: string;
  readonly locale?: string;
  readonly timezone?: string;
}

/** Raised for a taken email: the service answers 409. */
export class EmailTakenError extends Error {
  constructor() {
    super('email_taken');
    this.name = 'EmailTakenError';
  }
}

// ── SQL ─────────────────────────────────────────────────────────────────────

const PERSON_COLUMNS = `u.id as id, u.email as email, u.display_name as display_name,
  u.locale as locale, u.timezone as timezone, u.email_verified_at as email_verified_at,
  u.created_at as created_at, u.disabled_at as disabled_at, u.disabled_reason as disabled_reason,
  u.two_step_required_at as two_step_required_at,
  (select max(se.created_at) from sessions se where se.user_id = u.id) as last_sign_in_at,
  (select se.user_agent from sessions se where se.user_id = u.id
     order by se.created_at desc limit 1) as last_sign_in_user_agent,
  (select count(*) from user_mfa_factors f
     where f.user_id = u.id and f.confirmed_at is not null and f.disabled_at is null) as factors,
  (select count(*) from sessions se
     where se.user_id = u.id and se.revoked_at is null and se.expires_at > now(3)) as live_sessions,
  (select pa.actor_email from platform_admin_audit_events pa
     where pa.target_type = 'user' and pa.target_id = u.id and pa.action = 'platform.user_disabled'
     order by pa.created_at desc limit 1) as disabled_by_email`;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export function peopleWhere(filter: PeopleFilter): {
  readonly sql: string;
  readonly params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.q !== null) {
    clauses.push('(u.email like ? or u.display_name like ? or u.id = ?)');
    const pattern = likeContains(filter.q.toLowerCase());
    params.push(pattern, likeContains(filter.q), filter.q);
  }
  if (filter.status === 'active') clauses.push('u.disabled_at is null');
  if (filter.status === 'disabled') clauses.push('u.disabled_at is not null');
  if (filter.verified === true) clauses.push('u.email_verified_at is not null');
  if (filter.verified === false) clauses.push('u.email_verified_at is null');
  const factorExists = `exists (select 1 from user_mfa_factors f where f.user_id = u.id
      and f.confirmed_at is not null and f.disabled_at is null)`;
  if (filter.mfa === true) clauses.push(factorExists);
  if (filter.mfa === false) clauses.push(`not ${factorExists}`);
  if (filter.locale !== null) {
    clauses.push('u.locale = ?');
    params.push(filter.locale);
  }
  if (filter.organizationId !== null || filter.role !== null) {
    const internal: string[] = ['m.user_id = u.id'];
    const client: string[] = ['cm.user_id = u.id'];
    const internalParams: unknown[] = [];
    const clientParams: unknown[] = [];
    if (filter.organizationId !== null) {
      internal.push('m.organization_id = ?');
      internalParams.push(filter.organizationId);
      client.push('cm.organization_id = ?');
      clientParams.push(filter.organizationId);
    }
    if (filter.role !== null) {
      internal.push('m.role = ?');
      internalParams.push(filter.role);
      client.push('cm.role = ?');
      clientParams.push(filter.role);
    }
    clauses.push(`(exists (select 1 from memberships m where ${internal.join(' and ')})
      or exists (select 1 from client_memberships cm where ${client.join(' and ')}))`);
    params.push(...internalParams, ...clientParams);
  }
  const lastSignIn = '(select max(se.created_at) from sessions se where se.user_id = u.id)';
  if (filter.signInFrom !== null) {
    clauses.push(`${lastSignIn} >= ?`);
    params.push(filter.signInFrom);
  }
  if (filter.signInTo !== null) {
    clauses.push(`${lastSignIn} <= ?`);
    params.push(filter.signInTo);
  }
  const liveSession = `exists (select 1 from sessions se where se.user_id = u.id
      and se.revoked_at is null and se.expires_at > now(3))`;
  if (filter.hasSessions === true) clauses.push(liveSession);
  if (filter.hasSessions === false) clauses.push(`not ${liveSession}`);
  return { sql: clauses.length === 0 ? '' : clauses.join(' and '), params };
}

export const PEOPLE_SQL = {
  list: (where: string, paged: boolean) => `select ${PERSON_COLUMNS} from users u
    where ${[where, paged ? 'u.id < ?' : ''].filter((part) => part !== '').join(' and ') || '1 = 1'}
    order by u.id desc limit ?`,
  count: (where: string) => `select count(*) as total from users u where ${where || '1 = 1'}`,
  person: `select ${PERSON_COLUMNS} from users u where u.id = ? limit 1`,
  internalMemberships: (ids: number) => `select m.id as membership_id, m.user_id as user_id,
      o.id as organization_id, o.name as organization_name, o.slug as organization_slug,
      o.suspended_at as suspended_at, o.archived_at as archived_at,
      m.role as role, m.status as status, m.has_org_wide_scope as org_wide,
      m.created_at as created_at,
      (select cr.name from custom_roles cr
         where cr.organization_id = m.organization_id and cr.id = m.role limit 1) as custom_role_name
    from memberships m join organizations o on o.id = m.organization_id
    where m.user_id in (${placeholders(ids)}) and m.platform_support_session_id is null
    order by o.name asc`,
  clientMemberships: (ids: number) => `select cm.id as membership_id, cm.user_id as user_id,
      o.id as organization_id, o.name as organization_name, o.slug as organization_slug,
      o.suspended_at as suspended_at, o.archived_at as archived_at,
      cm.role as role, cm.status as status, cm.created_at as created_at,
      co.name as client_organization_name
    from client_memberships cm
      join organizations o on o.id = cm.organization_id
      left join client_organizations co
        on co.organization_id = cm.organization_id and co.id = cm.client_organization_id
    where cm.user_id in (${placeholders(ids)})
    order by o.name asc`,
  actions: (paged: boolean) => `select a.id as id, a.organization_id as organization_id,
      o.name as organization_name, a.action as action, a.object_type as object_type,
      a.result as result, a.created_at as created_at,
      a.platform_support_session_id as platform_support_session_id
    from audit_events a join organizations o on o.id = a.organization_id
    where (a.actor_user_id = ? or a.effective_actor_id = ?)
      ${paged ? 'and (a.created_at < ? or (a.created_at = ? and a.id < ?))' : ''}
      ${'and a.created_at >= ? and a.created_at <= ?'}
    order by a.created_at desc, a.id desc limit ?`,
  security: `select
      (select f.kind from user_mfa_factors f where f.user_id = ? and f.confirmed_at is not null
         and f.disabled_at is null order by f.confirmed_at desc limit 1) as factor_kind,
      (select f.confirmed_at from user_mfa_factors f where f.user_id = ?
         and f.confirmed_at is not null and f.disabled_at is null
         order by f.confirmed_at desc limit 1) as factor_confirmed_at,
      (select count(*) from user_recovery_codes rc where rc.user_id = ? and rc.used_at is null
         and rc.revoked_at is null) as recovery_left,
      (select p.set_at from user_passwords p where p.user_id = ? limit 1) as password_set_at`,
  sessions: `select s.id as id, s.user_agent as user_agent, s.created_at as created_at,
      coalesce(s.rotated_at, s.created_at) as last_active_at, s.expires_at as expires_at,
      s.revoked_at as revoked_at, s.revoked_reason as revoked_reason, s.ip_first as ip_first,
      s.ip_last as ip_last, case when s.expires_at <= now(3) then 1 else 0 end as expired
    from sessions s
    where s.user_id = ?
      and ((s.revoked_at is null and s.expires_at > now(3))
        or coalesce(s.revoked_at, s.expires_at) >= date_sub(now(3), interval 30 day))
    order by (s.revoked_at is null and s.expires_at > now(3)) desc, s.created_at desc
    limit 100`,
  access: (outcome: boolean) => `select e.id as id, e.action as action, e.outcome as outcome,
      e.reason as reason, e.ip as ip, e.user_agent as user_agent, e.occurred_at as occurred_at
    from authentication_events e
    where e.user_id = ? and e.occurred_at >= ? and e.occurred_at <= ?
      ${outcome ? 'and e.outcome = ?' : ''}
    order by e.occurred_at desc, e.id desc limit ?`,
  stepUps: `select id, created_at, expires_at, mfa_verified from platform_admin_step_ups
    where user_id = ? and created_at >= ? order by created_at desc limit 20`,
  bearer: `select
      (select count(*) from personal_access_tokens t where t.user_id = ? and t.revoked_at is null
         and (t.expires_at is null or t.expires_at > now(3))) as tokens,
      (select count(*) from oauth_grants g where g.user_id = ? and g.revoked_at is null) as grants`,
  emailOwner: `select id from users where email = ? and id <> ? limit 1`,
  overrides: `select effect, count(*) as total from membership_permission_overrides
    where organization_id = ? and membership_id = ? and revoked_at is null
      and (expires_at is null or expires_at > now(3))
    group by effect`,
  projects: `select count(*) as total from project_memberships
    where organization_id = ? and user_id = ?`,
  disable: `update users set disabled_at = current_timestamp(3), disabled_reason = ?,
      updated_at = current_timestamp(3)
    where id = ? and disabled_at is null`,
  enable: `update users set disabled_at = null, disabled_reason = null,
      updated_at = current_timestamp(3)
    where id = ? and disabled_at is not null`,
  setTwoStepRequired: (required: boolean) => `update users
    set two_step_required_at = ${required ? 'coalesce(two_step_required_at, current_timestamp(3))' : 'null'},
      updated_at = current_timestamp(3)
    where id = ?`,
  disableFactors: `update user_mfa_factors set disabled_at = current_timestamp(3)
    where user_id = ? and disabled_at is null`,
  revokeRecoveryCodes: `update user_recovery_codes set revoked_at = current_timestamp(3)
    where user_id = ? and used_at is null and revoked_at is null`,
  revokeSessions: `update sessions set revoked_at = current_timestamp(3), revoked_reason = ?
    where user_id = ? and revoked_at is null`,
  revokeOne: `update sessions set revoked_at = current_timestamp(3), revoked_reason = ?
    where id = ? and user_id = ? and revoked_at is null`,
} as const;

// ── Row mapping ─────────────────────────────────────────────────────────────

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

function toPerson(row: Row): PersonRow {
  return {
    userId: String(row['id']),
    email: String(row['email']),
    displayName: String(row['display_name']),
    locale: String(row['locale'] ?? 'en'),
    timezone: String(row['timezone'] ?? 'UTC'),
    emailVerifiedAt: date(row['email_verified_at']),
    createdAt: date(row['created_at']) ?? new Date(0),
    lastSignInAt: date(row['last_sign_in_at']),
    lastSignInUserAgent: text(row['last_sign_in_user_agent']),
    mfaEnabled: num(row['factors']) > 0,
    liveSessions: num(row['live_sessions']),
    disabledAt: date(row['disabled_at']),
    disabledReason: text(row['disabled_reason']),
    disabledByEmail: text(row['disabled_by_email']),
    twoStepRequiredAt: date(row['two_step_required_at']),
  };
}

function toMembership(row: Row, audience: 'internal' | 'client'): MembershipRow {
  return {
    userId: String(row['user_id']),
    membershipId: String(row['membership_id']),
    organizationId: String(row['organization_id']),
    organizationName: String(row['organization_name']),
    organizationSlug: String(row['organization_slug']),
    organizationSuspendedAt: date(row['suspended_at']),
    organizationArchivedAt: date(row['archived_at']),
    audience,
    role: String(row['role']),
    customRoleName: text(row['custom_role_name']),
    status: String(row['status']),
    orgWide: audience === 'internal' ? num(row['org_wide']) === 1 : false,
    clientOrganizationName: text(row['client_organization_name']),
    createdAt: date(row['created_at']) ?? new Date(0),
  };
}

function isDuplicate(error: unknown): boolean {
  const candidate = unwrapQueryError(error) as { errno?: number; code?: string } | null;
  return candidate?.errno === 1062 || candidate?.code === 'ER_DUP_ENTRY';
}

function affected(result: unknown): number {
  return num((result as { affectedRows?: number } | null)?.affectedRows);
}

// ── Repository ──────────────────────────────────────────────────────────────

export class PlatformPeopleRepository {
  constructor(
    private readonly database: TenantDatabase,
    private readonly credentials: Pick<CredentialsRepository, 'recordCredentialChange'>,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  async listPeople(
    filter: PeopleFilter,
    correlationId: string,
  ): Promise<{
    readonly people: readonly PersonRow[];
    readonly memberships: readonly MembershipRow[];
    readonly total: number;
    readonly hasMore: boolean;
  }> {
    const where = peopleWhere(filter);
    return this.metadata(correlationId, async (db) => {
      const paged = filter.cursor !== null;
      const rows = await db.query<Row[]>(PEOPLE_SQL.list(where.sql, paged), [
        ...where.params,
        ...(paged ? [filter.cursor] : []),
        filter.limit + 1,
      ] as never[]);
      const counted = await db.query<Row[]>(PEOPLE_SQL.count(where.sql), where.params as never[]);
      const hasMore = rows.length > filter.limit;
      const people = rows.slice(0, filter.limit).map(toPerson);
      const memberships = await this.membershipsOf(
        db,
        people.map((person) => person.userId),
      );
      return { people, memberships, total: num(counted[0]?.['total']), hasMore };
    });
  }

  async findPerson(userId: string, correlationId: string): Promise<PersonRow | null> {
    return this.database.identityRead(
      { correlationId, tables: [...ACCOUNT_TABLES] },
      async (db) => {
        const rows = await db.query<Row[]>(PEOPLE_SQL.person, [userId]);
        return rows[0] ? toPerson(rows[0]) : null;
      },
    );
  }

  async memberships(userId: string, correlationId: string): Promise<readonly MembershipRow[]> {
    return this.metadata(correlationId, (db) => this.membershipsOf(db, [userId]));
  }

  async securityFacts(userId: string, correlationId: string): Promise<SecurityFacts> {
    return this.database.identityRead(
      { correlationId, tables: [...ACCOUNT_TABLES] },
      async (db) => {
        const rows = await db.query<Row[]>(PEOPLE_SQL.security, [userId, userId, userId, userId]);
        const row = rows[0] ?? ({} as Row);
        return {
          factorKind: text(row['factor_kind']),
          factorConfirmedAt: date(row['factor_confirmed_at']),
          recoveryCodesLeft: num(row['recovery_left']),
          passwordSetAt: date(row['password_set_at']),
        };
      },
    );
  }

  async bearerCounts(userId: string, correlationId: string): Promise<BearerCounts> {
    return this.database.bootstrapRead(
      { correlationId, reason: BEARER_COUNT_REASON, tables: [...BEARER_TABLES] },
      async (db) => {
        const rows = await db.query<Row[]>(PEOPLE_SQL.bearer, [userId, userId]);
        const grants = num(rows[0]?.['grants']);
        return {
          personalAccessTokens: num(rows[0]?.['tokens']),
          aiAppGrants: grants,
          aiAppNames: [],
        };
      },
    );
  }

  async sessions(userId: string, correlationId: string): Promise<readonly SessionRowView[]> {
    return this.database.identityRead({ correlationId, tables: ['sessions'] }, async (db) => {
      const rows = await db.query<Row[]>(PEOPLE_SQL.sessions, [userId]);
      return rows.map((row) => ({
        id: String(row['id']),
        userAgent: text(row['user_agent']),
        createdAt: date(row['created_at']) ?? new Date(0),
        lastActiveAt: date(row['last_active_at']) ?? new Date(0),
        expiresAt: date(row['expires_at']) ?? new Date(0),
        revokedAt: date(row['revoked_at']),
        revokedReason: text(row['revoked_reason']),
        ipFirst: text(row['ip_first']),
        ipLast: text(row['ip_last']),
        expired: num(row['expired']) === 1,
      }));
    });
  }

  async access(
    userId: string,
    range: { readonly from: Date; readonly to: Date; readonly outcome: 'failed' | null },
    correlationId: string,
  ): Promise<{ readonly events: readonly AccessRow[]; readonly stepUps: readonly StepUpRow[] }> {
    return this.database.identityRead(
      { correlationId, tables: [...ACCOUNT_TABLES] },
      async (db) => {
        const rows = await db.query<Row[]>(PEOPLE_SQL.access(range.outcome !== null), [
          userId,
          range.from,
          range.to,
          ...(range.outcome !== null ? [range.outcome] : []),
          PEOPLE_ACCESS_LIMIT,
        ] as never[]);
        const steps = await db.query<Row[]>(PEOPLE_SQL.stepUps, [userId, range.from]);
        return {
          events: rows.map((row) => ({
            id: String(row['id']),
            action: String(row['action']),
            outcome: String(row['outcome']),
            reason: text(row['reason']),
            ip: text(row['ip']),
            userAgent: text(row['user_agent']),
            occurredAt: date(row['occurred_at']) ?? new Date(0),
          })),
          stepUps: steps.map((row) => ({
            id: String(row['id']),
            createdAt: date(row['created_at']) ?? new Date(0),
            expiresAt: date(row['expires_at']) ?? new Date(0),
            mfaVerified: num(row['mfa_verified']) === 1,
          })),
        };
      },
    );
  }

  async actions(
    userId: string,
    page: {
      readonly from: Date;
      readonly to: Date;
      readonly cursor: { readonly at: Date; readonly id: string } | null;
      readonly limit: number;
    },
    correlationId: string,
  ): Promise<{ readonly actions: readonly ActionRow[]; readonly hasMore: boolean }> {
    return this.metadata(correlationId, async (db) => {
      const rows = await db.query<Row[]>(PEOPLE_SQL.actions(page.cursor !== null), [
        userId,
        userId,
        ...(page.cursor !== null ? [page.cursor.at, page.cursor.at, page.cursor.id] : []),
        page.from,
        page.to,
        page.limit + 1,
      ] as never[]);
      return {
        hasMore: rows.length > page.limit,
        actions: rows.slice(0, page.limit).map((row) => ({
          id: String(row['id']),
          organizationId: String(row['organization_id']),
          organizationName: String(row['organization_name']),
          action: String(row['action']),
          objectType: String(row['object_type']),
          result: String(row['result']),
          occurredAt: date(row['created_at']) ?? new Date(0),
          viaSupport: row['platform_support_session_id'] != null,
        })),
      };
    });
  }

  /** One membership's live overrides and assigned projects, read inside its organization. */
  async overrideCounts(
    organizationId: string,
    membershipId: string,
    userId: string,
    correlationId: string,
  ): Promise<OverrideCounts> {
    const context = createServiceContext({
      organizationId,
      correlationId,
      policyVersion: 'platform-admin',
    });
    return this.database.read(context, async (db) => {
      const rows = await db.query<Row[]>(PEOPLE_SQL.overrides, [organizationId, membershipId]);
      const projects = await db.query<Row[]>(PEOPLE_SQL.projects, [organizationId, userId]);
      let allow = 0;
      let deny = 0;
      for (const row of rows) {
        if (row['effect'] === 'allow') allow += num(row['total']);
        else if (row['effect'] === 'deny') deny += num(row['total']);
      }
      return { allow, deny, projects: num(projects[0]?.['total']) };
    });
  }

  // ── Writes (each with its platform audit row, atomically) ────────────────

  /**
   * Edit the profile. A new email clears `email_verified_at`, ends every session and records the
   * `email_changed` credential change (its notice row). A taken email is {@link EmailTakenError}.
   */
  async updateProfile(
    userId: string,
    change: ProfileChange,
    emailChanged: boolean,
    audit: PlatformAuditInput,
  ): Promise<number> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (change.displayName !== undefined) {
      sets.push('display_name = ?');
      params.push(change.displayName);
    }
    if (change.locale !== undefined) {
      sets.push('locale = ?');
      params.push(change.locale);
    }
    if (change.timezone !== undefined) {
      sets.push('timezone = ?');
      params.push(change.timezone);
    }
    if (emailChanged && change.email !== undefined) {
      sets.push('email = ?', 'email_verified_at = null');
      params.push(change.email);
    }
    try {
      return await this.database.identityTransaction(
        { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
        async (tx) => {
          if (emailChanged && change.email !== undefined) {
            const owner = await tx.query<Row[]>(PEOPLE_SQL.emailOwner, [change.email, userId]);
            if (owner.length > 0) throw new EmailTakenError();
          }
          if (sets.length > 0) {
            await tx.query(
              `update users set ${sets.join(', ')}, updated_at = current_timestamp(3) where id = ?`,
              [...params, userId] as never[],
            );
          }
          let ended = 0;
          if (emailChanged) {
            ended = affected(
              await tx.query(PEOPLE_SQL.revokeSessions, [
                PEOPLE_REVOCATION_REASONS.emailChanged,
                userId,
              ]),
            );
            await this.credentials.recordCredentialChange(tx, {
              userId,
              action: EMAIL_CHANGED_ACTION,
              ip: audit.ip ?? null,
              userAgent: audit.userAgent ?? null,
              correlationId: audit.correlationId,
            });
          }
          await insertPlatformAudit(tx, audit);
          return ended;
        },
      );
    } catch (error) {
      if (isDuplicate(error)) throw new EmailTakenError();
      throw error;
    }
  }

  /** Disable: block sign-in, end every session, and cut every bearer credential (F19 order). */
  async disable(userId: string, reason: string, audit: PlatformAuditInput): Promise<number> {
    await revokeAllBearerCredentialsForUser(this.database, userId, audit.correlationId);
    const ended = await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        await tx.query(PEOPLE_SQL.disable, [reason, userId]);
        const result = await tx.query(PEOPLE_SQL.revokeSessions, [
          PEOPLE_REVOCATION_REASONS.disabled,
          userId,
        ]);
        await insertPlatformAudit(tx, audit);
        return affected(result);
      },
    );
    await revokeAllBearerCredentialsForUser(this.database, userId, audit.correlationId);
    return ended;
  }

  async enable(userId: string, audit: PlatformAuditInput): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        const result = await tx.query(PEOPLE_SQL.enable, [userId]);
        await insertPlatformAudit(tx, audit);
        return affected(result) > 0;
      },
    );
  }

  /**
   * Reset two-step: every factor disabled, every unused recovery code revoked, two-step required
   * at the next sign-in, and the owner's `mfa_factor_disabled` notice — one transaction.
   */
  async resetTwoStep(
    userId: string,
    signOut: boolean,
    audit: PlatformAuditInput,
  ): Promise<{ readonly factorsDisabled: number; readonly sessionsEnded: number }> {
    if (signOut) {
      await revokeAllBearerCredentialsForUser(this.database, userId, audit.correlationId);
    }
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        const factors = affected(await tx.query(PEOPLE_SQL.disableFactors, [userId]));
        await tx.query(PEOPLE_SQL.revokeRecoveryCodes, [userId]);
        await tx.query(PEOPLE_SQL.setTwoStepRequired(true), [userId]);
        let sessionsEnded = 0;
        if (signOut) {
          sessionsEnded = affected(
            await tx.query(PEOPLE_SQL.revokeSessions, [PEOPLE_REVOCATION_REASONS.signOut, userId]),
          );
        }
        await this.credentials.recordCredentialChange(tx, {
          userId,
          action: 'mfa_factor_disabled',
          ip: audit.ip ?? null,
          userAgent: audit.userAgent ?? null,
          correlationId: audit.correlationId,
        });
        await insertPlatformAudit(tx, audit);
        return { factorsDisabled: factors, sessionsEnded };
      },
    );
  }

  async setTwoStepRequired(
    userId: string,
    required: boolean,
    audit: PlatformAuditInput,
  ): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        await tx.query(PEOPLE_SQL.setTwoStepRequired(required), [userId]);
        await insertPlatformAudit(tx, audit);
      },
    );
  }

  /** End one session of this person. `false` when it is not theirs or already ended. */
  async endSession(userId: string, sessionId: string, audit: PlatformAuditInput): Promise<boolean> {
    return this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        const result = await tx.query(PEOPLE_SQL.revokeOne, [
          PEOPLE_REVOCATION_REASONS.endOne,
          sessionId,
          userId,
        ]);
        if (affected(result) === 0) return false;
        await insertPlatformAudit(tx, audit);
        return true;
      },
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async membershipsOf(
    db: BootstrapQueryRunner,
    ids: readonly string[],
  ): Promise<readonly MembershipRow[]> {
    if (ids.length === 0) return [];
    const internal = await db.query<Row[]>(PEOPLE_SQL.internalMemberships(ids.length), [...ids]);
    const client = await db.query<Row[]>(PEOPLE_SQL.clientMemberships(ids.length), [...ids]);
    return [
      ...internal.map((row) => toMembership(row, 'internal')),
      ...client.map((row) => toMembership(row, 'client')),
    ];
  }

  private metadata<T>(
    correlationId: string,
    work: (db: BootstrapQueryRunner) => Promise<T>,
  ): Promise<T> {
    return this.database.bootstrapRead(
      { correlationId, reason: PLATFORM_METADATA_REASON, tables: [...PEOPLE_METADATA_TABLES] },
      work,
    );
  }
}

/** Exposed for the unit test that holds every write to the identity path. */
export type PeopleIdentityRunner = IdentityQueryRunner;
