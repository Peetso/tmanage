import type { RowDataPacket } from 'mysql2';
import { createServiceContext } from '../../../common/database/tenant-context.js';
import type {
  BootstrapQueryRunner,
  SqlParameter,
  TenantDatabase,
  TenantQueryRunner,
} from '../../../common/database/tenant-context.js';
import {
  PLATFORM_METADATA_REASON,
  PLATFORM_METADATA_TABLES,
} from '../platform-admin.repository.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import { insertPlatformAudit } from '../platform-admin.repository.js';
import type {
  ActionFilter,
  Cursor,
  PlatformActionFilter,
  SessionFilter,
  SignInFilter,
} from './activity-query.repository.js';
import {
  actionsWhere,
  keyset,
  platformActionsWhere,
  sessionsWhere,
  signInsWhere,
} from './activity-query.repository.js';

/**
 * Platform admin · Activity & access — every statement (platform-admin v2 · PA-09, SPEC §5.5).
 *
 * Three paths, the narrowest that answers each question (SPEC P2):
 *
 * - **Metadata path** (`bootstrapRead` over `PLATFORM_METADATA_TABLES`) for the cross-organization
 *   action log: `audit_events` ids, names, results and origin — never `metadata_json`, never
 *   `audit_event_changes`;
 * - **Tenant path** (a service context bound to ONE organization) for an event's detail: its
 *   before → after rows, its safe metadata, the same-request events — and for the action log
 *   filtered by "has changes", which needs `audit_event_changes`;
 * - **Identity path** for the global tables: sign-ins, sessions, step-ups, the platform log.
 */

type Row = RowDataPacket & Record<string, unknown>;

const ACTION_COLUMNS = `e.id as id, e.organization_id as organization_id,
  o.name as organization_name, o.slug as organization_slug,
  e.actor_user_id as actor_user_id, ua.email as actor_email, ua.display_name as actor_name,
  e.effective_actor_id as effective_actor_id, ue.email as effective_actor_email,
  ue.display_name as effective_actor_name, e.action as action, e.object_type as object_type,
  e.object_id as object_id, e.result as result, e.correlation_id as correlation_id,
  e.platform_support_session_id as platform_support_session_id, e.ip as ip,
  e.user_agent as user_agent, e.created_at as created_at`;

const ACTION_JOINS = `from audit_events e
  join organizations o on o.id = e.organization_id
  left join users ua on ua.id = e.actor_user_id
  left join users ue on ue.id = e.effective_actor_id`;

/**
 * The tenant-path twin: the same columns with the organization's name and slug bound as
 * parameters (read once beforehand), so no statement joins `organizations` without its own key.
 */
const TENANT_ACTION_COLUMNS = ACTION_COLUMNS.replace(
  'o.name as organization_name, o.slug as organization_slug',
  '? as organization_name, ? as organization_slug',
);
const TENANT_ACTION_JOINS = `from audit_events e
  left join users ua on ua.id = e.actor_user_id
  left join users ue on ue.id = e.effective_actor_id`;

export const ACTIVITY_SQL = {
  actions: (where: string) => `select ${ACTION_COLUMNS} ${ACTION_JOINS} ${where}
    order by e.created_at desc, e.id desc limit ?`,
  actionTotals: (where: string) => `select count(*) as total,
      coalesce(sum(case when e.platform_support_session_id is not null then 1 else 0 end), 0) as via_support,
      coalesce(sum(case when e.result = 'denied' then 1 else 0 end), 0) as denied,
      coalesce(sum(case when e.result = 'error' then 1 else 0 end), 0) as errors
    ${ACTION_JOINS} ${where}`,
  tenantActions: (where: string) => `select ${TENANT_ACTION_COLUMNS} ${TENANT_ACTION_JOINS}
    ${where} order by e.created_at desc, e.id desc limit ?`,
  tenantActionTotals: (where: string) => `select count(*) as total,
      coalesce(sum(case when e.platform_support_session_id is not null then 1 else 0 end), 0) as via_support,
      coalesce(sum(case when e.result = 'denied' then 1 else 0 end), 0) as denied,
      coalesce(sum(case when e.result = 'error' then 1 else 0 end), 0) as errors
    ${TENANT_ACTION_JOINS} ${where}`,
  organization: `select id, name, slug from organizations where id = ? limit 1`,
  action: `select ${TENANT_ACTION_COLUMNS}, e.metadata_json as metadata_json
    ${TENANT_ACTION_JOINS}
    where e.organization_id = ? and e.id = ? limit 1`,
  changes: `select field, before_value, after_value, redacted from audit_event_changes
    where organization_id = ? and audit_event_id = ? order by created_at asc, id asc limit 200`,
  sameCorrelation: `select id, action, result, created_at from audit_events
    where organization_id = ? and correlation_id = ? and id <> ?
    order by created_at asc, id asc limit 20`,
  actorRole: `select role from memberships where organization_id = ? and user_id = ? limit 1`,
  supportSession: `select s.id as id, s.reason as reason, s.started_at as started_at,
      u.email as admin_email
    from platform_support_sessions s join users u on u.id = s.admin_user_id
    where s.id = ? limit 1`,
  signIns: (where: string) => `select e.id as id, e.user_id as user_id, u.email as email,
      u.display_name as display_name, e.action as action, e.outcome as outcome,
      e.reason as reason, e.ip as ip, e.user_agent as user_agent,
      e.correlation_id as correlation_id, e.occurred_at as occurred_at
    from authentication_events e left join users u on u.id = e.user_id
    ${where} order by e.occurred_at desc, e.id desc limit ?`,
  sessions: (where: string) => `select s.id as id, s.user_id as user_id, u.email as email,
      u.display_name as display_name, s.user_agent as user_agent, s.ip_first as ip_first,
      s.ip_last as ip_last, s.created_at as created_at,
      coalesce(s.rotated_at, s.created_at) as last_active_at, s.expires_at as expires_at,
      s.revoked_at as revoked_at,
      case when s.revoked_at is null and s.expires_at > now(3) then 1 else 0 end as active,
      (select count(*) from platform_admins pa
         where pa.user_id = s.user_id and pa.status = 'active') as platform_admin
    from sessions s join users u on u.id = s.user_id
    ${where} order by s.created_at desc, s.id desc limit ?`,
  sessionOwner: `select s.user_id as user_id, u.email as email, u.display_name as display_name,
      s.user_agent as user_agent, s.revoked_at as revoked_at
    from sessions s join users u on u.id = s.user_id where s.id = ? limit 1 for update`,
  endSession: `update sessions set revoked_at = current_timestamp(3), revoked_reason = ?
    where id = ? and revoked_at is null`,
  platformStepUps: (where: string) => `select su.id as id, su.user_id as user_id,
      u.email as email, u.display_name as display_name, su.mfa_verified as mfa_verified,
      su.created_at as occurred_at, su.expires_at as expires_at
    from platform_admin_step_ups su join users u on u.id = su.user_id
    ${where} order by su.created_at desc, su.id desc limit ?`,
  memberStepUps: (where: string) => `select e.id as id, e.user_id as user_id, u.email as email,
      u.display_name as display_name, e.outcome as outcome, e.ip as ip,
      e.user_agent as user_agent, e.occurred_at as occurred_at
    from authentication_events e left join users u on u.id = e.user_id
    ${where} order by e.occurred_at desc, e.id desc limit ?`,
  failures: `select e.ip as ip, e.user_id as user_id, u.email as email, e.outcome as outcome,
      e.reason as reason, e.occurred_at as occurred_at
    from authentication_events e left join users u on u.id = e.user_id
    where e.outcome <> 'succeeded' and e.occurred_at >= ?
    order by e.occurred_at desc, e.id desc limit ?`,
  platformActions: (where: string) => `select p.id as id, p.actor_user_id as actor_user_id,
      p.actor_email as actor_email, p.action as action, p.target_type as target_type,
      p.target_id as target_id, p.target_label as target_label,
      p.organization_id as organization_id, p.reason as reason,
      p.support_session_id as support_session_id, p.correlation_id as correlation_id,
      p.before_json as before_json, p.after_json as after_json, p.ip as ip,
      p.user_agent as user_agent, p.created_at as created_at
    from platform_admin_audit_events p ${where}
    order by p.created_at desc, p.id desc limit ?`,
  platformActionsCount: (where: string) =>
    `select count(*) as total from platform_admin_audit_events p ${where}`,
  organizationNames: (ids: number) => `select o.id as id, o.name as name from organizations o
    where o.id in (${Array.from({ length: ids }, () => '?').join(', ')})`,
} as const;

/** Recorded on `sessions.revoked_reason` when an operator ends one session from C3. */
export const ACTIVITY_END_SESSION_REASON = 'platform_admin_end_session';

/** The most failure rows the Suspicious tab folds into patterns. */
export const MAX_FAILURE_ROWS = 5000;

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface ActionRow {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly actorName: string | null;
  readonly effectiveActorUserId: string | null;
  readonly effectiveActorEmail: string | null;
  readonly effectiveActorName: string | null;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly result: 'allowed' | 'denied' | 'error';
  readonly correlationId: string;
  readonly supportSessionId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
}

export interface ActionTotals {
  readonly total: number;
  readonly viaSupport: number;
  readonly denied: number;
  readonly errors: number;
}

export interface ActionDetailRows {
  readonly action: ActionRow;
  readonly metadataJson: string | null;
  readonly actorRole: string | null;
  readonly changes: readonly {
    readonly field: string;
    readonly before: string | null;
    readonly after: string | null;
    readonly redacted: boolean;
  }[];
  readonly sameCorrelation: readonly {
    readonly id: string;
    readonly action: string;
    readonly result: 'allowed' | 'denied' | 'error';
    readonly createdAt: Date;
  }[];
}

export interface SupportSessionRow {
  readonly id: string;
  readonly reason: string | null;
  readonly startedAt: Date;
  readonly adminEmail: string;
}

export interface SignInRow {
  readonly id: string;
  readonly userId: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
}

export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly userAgent: string | null;
  readonly ipFirst: string | null;
  readonly ipLast: string | null;
  readonly createdAt: Date;
  readonly lastActiveAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly active: boolean;
  readonly platformAdmin: boolean;
}

export interface StepUpRow {
  readonly id: string;
  readonly kind: 'platform' | 'member';
  readonly userId: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly outcome: string;
  readonly mfaVerified: boolean;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly occurredAt: Date;
  readonly expiresAt: Date | null;
}

export interface FailureRow {
  readonly ip: string | null;
  readonly userId: string | null;
  readonly email: string | null;
  readonly outcome: string;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

export interface PlatformActionRow {
  readonly id: string;
  readonly actorUserId: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  readonly organizationId: string | null;
  readonly reason: string | null;
  readonly supportSessionId: string | null;
  readonly correlationId: string;
  readonly beforeJson: string | null;
  readonly afterJson: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
}

// ── Mapping ──────────────────────────────────────────────────────────────────

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

function result(value: unknown): 'allowed' | 'denied' | 'error' {
  const raw = String(value);
  return raw === 'denied' || raw === 'error' ? raw : 'allowed';
}

function toAction(row: Row): ActionRow {
  return {
    id: String(row['id']),
    organizationId: String(row['organization_id']),
    organizationName: String(row['organization_name'] ?? ''),
    organizationSlug: String(row['organization_slug'] ?? ''),
    actorUserId: text(row['actor_user_id']),
    actorEmail: text(row['actor_email']),
    actorName: text(row['actor_name']),
    effectiveActorUserId: text(row['effective_actor_id']),
    effectiveActorEmail: text(row['effective_actor_email']),
    effectiveActorName: text(row['effective_actor_name']),
    action: String(row['action']),
    objectType: String(row['object_type']),
    objectId: text(row['object_id']),
    result: result(row['result']),
    correlationId: String(row['correlation_id']),
    supportSessionId: text(row['platform_support_session_id']),
    ip: text(row['ip']),
    userAgent: text(row['user_agent']),
    createdAt: date(row['created_at']) ?? new Date(0),
  };
}

function toSignIn(row: Row): SignInRow {
  return {
    id: String(row['id']),
    userId: text(row['user_id']),
    email: text(row['email']),
    displayName: text(row['display_name']),
    action: String(row['action']),
    outcome: String(row['outcome']),
    reason: text(row['reason']),
    ip: text(row['ip']),
    userAgent: text(row['user_agent']),
    correlationId: text(row['correlation_id']),
    occurredAt: date(row['occurred_at']) ?? new Date(0),
  };
}

function toSession(row: Row): SessionRow {
  const created = date(row['created_at']) ?? new Date(0);
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    email: String(row['email'] ?? ''),
    displayName: String(row['display_name'] ?? ''),
    userAgent: text(row['user_agent']),
    ipFirst: text(row['ip_first']),
    ipLast: text(row['ip_last']),
    createdAt: created,
    lastActiveAt: date(row['last_active_at']) ?? created,
    expiresAt: date(row['expires_at']) ?? created,
    revokedAt: date(row['revoked_at']),
    active: num(row['active']) === 1,
    platformAdmin: num(row['platform_admin']) > 0,
  };
}

function toPlatformAction(row: Row): PlatformActionRow {
  return {
    id: String(row['id']),
    actorUserId: String(row['actor_user_id']),
    actorEmail: String(row['actor_email']),
    action: String(row['action']),
    targetType: String(row['target_type']),
    targetId: text(row['target_id']),
    targetLabel: text(row['target_label']),
    organizationId: text(row['organization_id']),
    reason: text(row['reason']),
    supportSessionId: text(row['support_session_id']),
    correlationId: String(row['correlation_id']),
    beforeJson: text(row['before_json']),
    afterJson: text(row['after_json']),
    ip: text(row['ip']),
    userAgent: text(row['user_agent']),
    createdAt: date(row['created_at']) ?? new Date(0),
  };
}

function affected(value: unknown): number {
  const rows = (value as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}

function platformContext(organizationId: string, correlationId: string) {
  return createServiceContext({ organizationId, correlationId, policyVersion: 'platform-admin' });
}

const SIGN_IN_TABLES = ['authentication_events', 'users'] as const;
const SESSION_TABLES = ['sessions', 'users', 'platform_admins'] as const;
const END_SESSION_TABLES = ['sessions', 'users', 'platform_admin_audit_events'] as const;
const STEP_UP_TABLES = ['platform_admin_step_ups', 'authentication_events', 'users'] as const;
const PLATFORM_LOG_TABLES = ['platform_admin_audit_events'] as const;
const SUPPORT_TABLES = ['platform_support_sessions', 'users'] as const;

export class ActivityRepository {
  constructor(private readonly database: TenantDatabase) {}

  // ── C1: the cross-organization action log (metadata path) ───────────────────

  /** One page (+1 row) of the action log. With "has changes", the one organization's tenant path. */
  async listActions(
    filter: ActionFilter,
    cursor: Cursor | null,
    limit: number,
    correlationId: string,
  ): Promise<readonly ActionRow[]> {
    const { where, params } = actionsWhere(filter, cursor);
    if (filter.hasChanges && filter.organizationId) {
      const organizationId = filter.organizationId;
      return this.database.read(platformContext(organizationId, correlationId), async (db) => {
        const org = await organizationOf(db, organizationId);
        if (!org) return [];
        const rows = await db.query<Row[]>(ACTIVITY_SQL.tenantActions(where), [
          org.name,
          org.slug,
          ...params,
          limit + 1,
        ]);
        return rows.map(toAction);
      });
    }
    return this.metadata(correlationId, async (db) => {
      const rows = await db.query<Row[]>(ACTIVITY_SQL.actions(where), [...params, limit + 1]);
      return rows.map(toAction);
    });
  }

  async actionTotals(filter: ActionFilter, correlationId: string): Promise<ActionTotals> {
    const { where, params } = actionsWhere(filter, null);
    if (filter.hasChanges && filter.organizationId) {
      return this.database.read(platformContext(filter.organizationId, correlationId), async (db) =>
        totalsOf(await db.query<Row[]>(ACTIVITY_SQL.tenantActionTotals(where), params)),
      );
    }
    return this.metadata(correlationId, async (db) =>
      totalsOf(await db.query<Row[]>(ACTIVITY_SQL.actionTotals(where), params)),
    );
  }

  // ── C2: one event, through ONE organization's tenant path ───────────────────

  async actionDetail(
    organizationId: string,
    eventId: string,
    correlationId: string,
  ): Promise<ActionDetailRows | null> {
    return this.database.read(platformContext(organizationId, correlationId), async (db) => {
      const org = await organizationOf(db, organizationId);
      if (!org) return null;
      const rows = await db.query<Row[]>(ACTIVITY_SQL.action, [
        org.name,
        org.slug,
        organizationId,
        eventId,
      ]);
      const row = rows[0];
      if (!row) return null;
      const action = toAction(row);
      const changes = await db.query<Row[]>(ACTIVITY_SQL.changes, [organizationId, eventId]);
      const related = await db.query<Row[]>(ACTIVITY_SQL.sameCorrelation, [
        organizationId,
        action.correlationId,
        eventId,
      ]);
      let actorRole: string | null = null;
      if (action.actorUserId !== null) {
        const roles = await db.query<Row[]>(ACTIVITY_SQL.actorRole, [
          organizationId,
          action.actorUserId,
        ]);
        actorRole = text(roles[0]?.['role']);
      }
      const metadata = row['metadata_json'];
      return {
        action,
        metadataJson:
          metadata === null || metadata === undefined
            ? null
            : typeof metadata === 'string'
              ? metadata
              : JSON.stringify(metadata),
        actorRole,
        changes: changes.map((change) => ({
          field: String(change['field']),
          before: text(change['before_value']),
          after: text(change['after_value']),
          redacted: num(change['redacted']) === 1,
        })),
        sameCorrelation: related.map((other) => ({
          id: String(other['id']),
          action: String(other['action']),
          result: result(other['result']),
          createdAt: date(other['created_at']) ?? new Date(0),
        })),
      };
    });
  }

  async supportSession(
    sessionId: string,
    correlationId: string,
  ): Promise<SupportSessionRow | null> {
    return this.database.identityRead(
      { correlationId, tables: [...SUPPORT_TABLES] },
      async (db) => {
        const rows = await db.query<Row[]>(ACTIVITY_SQL.supportSession, [sessionId]);
        const row = rows[0];
        if (!row) return null;
        return {
          id: String(row['id']),
          reason: text(row['reason']),
          startedAt: date(row['started_at']) ?? new Date(0),
          adminEmail: String(row['admin_email'] ?? ''),
        };
      },
    );
  }

  // ── C3: access (identity path) ──────────────────────────────────────────────

  async listSignIns(
    filter: SignInFilter,
    cursor: Cursor | null,
    limit: number,
    correlationId: string,
  ): Promise<readonly SignInRow[]> {
    const { where, params } = signInsWhere(filter, cursor);
    return this.database.identityRead(
      { correlationId, tables: [...SIGN_IN_TABLES] },
      async (db) => {
        const rows = await db.query<Row[]>(ACTIVITY_SQL.signIns(where), [...params, limit + 1]);
        return rows.map(toSignIn);
      },
    );
  }

  async listSessions(
    filter: SessionFilter,
    cursor: Cursor | null,
    limit: number,
    correlationId: string,
  ): Promise<readonly SessionRow[]> {
    const { where, params } = sessionsWhere(filter, cursor);
    return this.database.identityRead(
      { correlationId, tables: [...SESSION_TABLES] },
      async (db) => {
        const rows = await db.query<Row[]>(ACTIVITY_SQL.sessions(where), [...params, limit + 1]);
        return rows.map(toSession);
      },
    );
  }

  /**
   * End one session with its platform audit row, atomically. `null` when no such session; the
   * row with `ended: false` when it had already ended.
   */
  async endSession(
    sessionId: string,
    audit: (owner: {
      userId: string;
      email: string;
      userAgent: string | null;
    }) => PlatformAuditInput,
  ): Promise<{ readonly userId: string; readonly ended: boolean } | null> {
    const probe = audit({ userId: '', email: '', userAgent: null });
    return this.database.identityTransaction(
      { correlationId: probe.correlationId, tables: [...END_SESSION_TABLES] },
      async (tx) => {
        const rows = await tx.query<Row[]>(ACTIVITY_SQL.sessionOwner, [sessionId]);
        const row = rows[0];
        if (!row) return null;
        const owner = {
          userId: String(row['user_id']),
          email: String(row['email'] ?? ''),
          userAgent: text(row['user_agent']),
        };
        const updated = await tx.query(ACTIVITY_SQL.endSession, [
          ACTIVITY_END_SESSION_REASON,
          sessionId,
        ]);
        if (affected(updated) === 0) return { userId: owner.userId, ended: false };
        await insertPlatformAudit(tx, audit(owner));
        return { userId: owner.userId, ended: true };
      },
    );
  }

  async listStepUps(
    filter: { readonly userId: string | null; readonly kind: 'platform' | 'member' | null },
    cursor: Cursor | null,
    limit: number,
    correlationId: string,
  ): Promise<readonly StepUpRow[]> {
    return this.database.identityRead(
      { correlationId, tables: [...STEP_UP_TABLES] },
      async (db) => {
        const out: StepUpRow[] = [];
        if (filter.kind !== 'member') {
          const where = whereOf(
            filter.userId ? ['su.user_id = ?'] : [],
            filter.userId ? [filter.userId] : [],
            keyset(cursor, 'su.created_at', 'su.id'),
          );
          const rows = await db.query<Row[]>(ACTIVITY_SQL.platformStepUps(where.sql), [
            ...where.params,
            limit + 1,
          ]);
          for (const row of rows) {
            out.push({
              id: String(row['id']),
              kind: 'platform',
              userId: text(row['user_id']),
              email: text(row['email']),
              displayName: text(row['display_name']),
              outcome: 'succeeded',
              mfaVerified: num(row['mfa_verified']) === 1,
              ip: null,
              userAgent: null,
              occurredAt: date(row['occurred_at']) ?? new Date(0),
              expiresAt: date(row['expires_at']),
            });
          }
        }
        if (filter.kind !== 'platform') {
          const where = whereOf(
            ["e.action = 'reauthentication'", ...(filter.userId ? ['e.user_id = ?'] : [])],
            filter.userId ? [filter.userId] : [],
            keyset(cursor, 'e.occurred_at', 'e.id'),
          );
          const rows = await db.query<Row[]>(ACTIVITY_SQL.memberStepUps(where.sql), [
            ...where.params,
            limit + 1,
          ]);
          for (const row of rows) {
            out.push({
              id: String(row['id']),
              kind: 'member',
              userId: text(row['user_id']),
              email: text(row['email']),
              displayName: text(row['display_name']),
              outcome: String(row['outcome']),
              mfaVerified: false,
              ip: text(row['ip']),
              userAgent: text(row['user_agent']),
              occurredAt: date(row['occurred_at']) ?? new Date(0),
              expiresAt: null,
            });
          }
        }
        // Both halves are newest-first; merge on the same (time, id) key the cursor uses.
        out.sort((a, b) =>
          b.occurredAt.getTime() !== a.occurredAt.getTime()
            ? b.occurredAt.getTime() - a.occurredAt.getTime()
            : b.id.localeCompare(a.id),
        );
        return out.slice(0, limit + 1);
      },
    );
  }

  async listFailures(since: Date, correlationId: string): Promise<readonly FailureRow[]> {
    return this.database.identityRead(
      { correlationId, tables: [...SIGN_IN_TABLES] },
      async (db) => {
        const rows = await db.query<Row[]>(ACTIVITY_SQL.failures, [since, MAX_FAILURE_ROWS]);
        return rows.map((row) => ({
          ip: text(row['ip']),
          userId: text(row['user_id']),
          email: text(row['email']),
          outcome: String(row['outcome']),
          reason: text(row['reason']),
          occurredAt: date(row['occurred_at']) ?? new Date(0),
        }));
      },
    );
  }

  // ── C4: the platform admins' own log (identity path) ────────────────────────

  async listPlatformActions(
    filter: PlatformActionFilter,
    cursor: Cursor | null,
    limit: number,
    correlationId: string,
  ): Promise<{ readonly rows: readonly PlatformActionRow[]; readonly total: number }> {
    const page = platformActionsWhere(filter, cursor);
    const all = platformActionsWhere(filter, null);
    return this.database.identityRead(
      { correlationId, tables: [...PLATFORM_LOG_TABLES] },
      async (db) => {
        const rows = await db.query<Row[]>(ACTIVITY_SQL.platformActions(page.where), [
          ...page.params,
          limit + 1,
        ]);
        const count = await db.query<Row[]>(
          ACTIVITY_SQL.platformActionsCount(all.where),
          all.params,
        );
        return { rows: rows.map(toPlatformAction), total: num(count[0]?.['total']) };
      },
    );
  }

  /** `id → name` for the organizations a page of platform actions names (metadata path). */
  async organizationNames(
    ids: readonly string[],
    correlationId: string,
  ): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    return this.metadata(correlationId, async (db) => {
      const rows = await db.query<Row[]>(ACTIVITY_SQL.organizationNames(unique.length), unique);
      return new Map(rows.map((row) => [String(row['id']), String(row['name'])]));
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

function totalsOf(rows: readonly Row[]): ActionTotals {
  const row = rows[0] ?? ({} as Row);
  return {
    total: num(row['total']),
    viaSupport: num(row['via_support']),
    denied: num(row['denied']),
    errors: num(row['errors']),
  };
}

async function organizationOf(
  db: { query: TenantQueryRunner['query'] },
  organizationId: string,
): Promise<{ readonly name: string; readonly slug: string } | null> {
  const rows = await db.query<Row[]>(ACTIVITY_SQL.organization, [organizationId]);
  const row = rows[0];
  return row ? { name: String(row['name']), slug: String(row['slug']) } : null;
}

function whereOf(
  sql: readonly string[],
  params: readonly SqlParameter[],
  extra: { readonly sql: readonly string[]; readonly params: readonly SqlParameter[] },
): { sql: string; params: SqlParameter[] } {
  const parts = [...sql, ...extra.sql];
  return {
    sql: parts.length === 0 ? '' : `where ${parts.join(' and ')}`,
    params: [...params, ...extra.params],
  };
}
