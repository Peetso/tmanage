import type { RowDataPacket } from 'mysql2';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { insertPlatformAudit } from '../platform-admin.repository.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';

/**
 * 56-21b — the statements behind the monthly platform access review (identity path, global
 * tables, read-only but for the one audit row a recorded review writes). The team itself comes
 * from `PlatformAdminsRepository`; this adds what the month did: step-ups (`platform.step_up`, the
 * platform sign-in), support sessions, organizations entered, last activity, and the people's
 * current two-step state.
 */

type Row = RowDataPacket & Record<string, unknown>;

export interface MonthActivityRow {
  readonly userId: string;
  readonly email: string;
  readonly signIns: number;
  readonly lastActionAt: Date | null;
}

export interface MonthSupportRow {
  readonly userId: string;
  readonly sessions: number;
  readonly organizations: number;
  readonly lastStartedAt: Date | null;
}

export interface ReviewUserRow {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly twoStep: boolean;
}

export interface AccessReviewStore {
  monthActivity(from: Date, to: Date, correlationId: string): Promise<readonly MonthActivityRow[]>;
  monthSupport(from: Date, to: Date, correlationId: string): Promise<readonly MonthSupportRow[]>;
  users(userIds: readonly string[], correlationId: string): Promise<readonly ReviewUserRow[]>;
  recordReview(audit: PlatformAuditInput, correlationId: string): Promise<void>;
}

const LIMIT = 500;

const SQL = {
  activity: `select e.actor_user_id as user_id, max(e.actor_email) as email,
      sum(case when e.action = 'platform.step_up' then 1 else 0 end) as sign_ins,
      max(e.created_at) as last_at
    from platform_admin_audit_events e
    where e.created_at >= ? and e.created_at < ?
    group by e.actor_user_id limit ${String(LIMIT)}`,
  support: `select s.admin_user_id as user_id, count(*) as sessions,
      count(distinct s.organization_id) as organizations, max(s.started_at) as last_at
    from platform_support_sessions s
    where s.started_at >= ? and s.started_at < ?
    group by s.admin_user_id limit ${String(LIMIT)}`,
  users: (n: number) => `select u.id as id, u.email as email, u.display_name as display_name,
      exists (select 1 from user_mfa_factors f where f.user_id = u.id
        and f.confirmed_at is not null and f.disabled_at is null) as two_step
    from users u where u.id in (${Array.from({ length: n }, () => '?').join(', ')})`,
} as const;

const num = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const date = (value: unknown): Date | null =>
  value instanceof Date
    ? value
    : typeof value === 'string' && value !== ''
      ? new Date(value)
      : null;

export class AccessReviewRepository implements AccessReviewStore {
  constructor(private readonly database: TenantDatabase) {}

  async monthActivity(from: Date, to: Date, correlationId: string) {
    return this.database.identityRead(
      { correlationId, tables: ['platform_admin_audit_events'] },
      async (db) =>
        (await db.query<Row[]>(SQL.activity, [from, to])).map((row) => ({
          userId: String(row['user_id']),
          email: String(row['email'] ?? ''),
          signIns: num(row['sign_ins']),
          lastActionAt: date(row['last_at']),
        })),
    );
  }

  async monthSupport(from: Date, to: Date, correlationId: string) {
    return this.database.identityRead(
      { correlationId, tables: ['platform_support_sessions'] },
      async (db) =>
        (await db.query<Row[]>(SQL.support, [from, to])).map((row) => ({
          userId: String(row['user_id']),
          sessions: num(row['sessions']),
          organizations: num(row['organizations']),
          lastStartedAt: date(row['last_at']),
        })),
    );
  }

  async users(userIds: readonly string[], correlationId: string) {
    if (userIds.length === 0) return [];
    return this.database.identityRead(
      { correlationId, tables: ['users', 'user_mfa_factors'] },
      async (db) =>
        (await db.query<Row[]>(SQL.users(userIds.length), [...userIds])).map((row) => ({
          userId: String(row['id']),
          email: String(row['email']),
          displayName: String(row['display_name'] ?? ''),
          twoStep: num(row['two_step']) === 1,
        })),
    );
  }

  async recordReview(audit: PlatformAuditInput, correlationId: string): Promise<void> {
    await this.database.identityTransaction(
      { correlationId, tables: ['platform_admin_audit_events'] },
      async (tx) => {
        await insertPlatformAudit(tx, audit);
      },
    );
  }
}
