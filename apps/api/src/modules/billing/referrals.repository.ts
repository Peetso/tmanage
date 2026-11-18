import type { RowDataPacket } from 'mysql2';
import { uuidv7 } from '@tmanage/domain';
import type {
  BootstrapQueryRunner,
  IdentityQueryRunner,
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { REFERRAL_LIST_MAX, isReferralOutcome, isTeamRole } from './referrals.rules.js';
import type { ReferralOutcome } from './referrals.rules.js';

/**
 * 57-08 REFERRAL — every statement over the four tables of migration 0376.
 *
 * - Tenant path (`referral_codes`, `referral_signups`): each statement names the context's
 *   `organization_id`. The owner's list reads only `counted` rows and only the name snapshot and
 *   the date — no address, no person, no other tenant's row.
 * - Bootstrap path: resolving a code to its workspace at sign-up (before that workspace's context
 *   exists) and the Platform admin totals. Read-only, over declared tables, at most 500 rows.
 * - Identity path: the inviting team's addresses (`users`) for the abuse rules, and the platform
 *   tables `referral_partners` / `referral_partner_signups`.
 */

export const REFERRAL_RESOLVE_REASON =
  'referral sign-up (57-08): resolve an invite code to the inviting workspace and its team, to ' +
  'record the new workspace against it and apply the self-referral rule';

export const REFERRAL_RESOLVE_TABLES = ['referral_codes', 'memberships'] as const;

export const REFERRAL_PLATFORM_REASON =
  'platform referrals (57-08): the TManage operator reads invite-link totals by outcome, never a ' +
  'workspace name or a person';

export const REFERRAL_PLATFORM_TABLES = ['referral_signups'] as const;

export const PARTNER_TABLES = ['referral_partners', 'referral_partner_signups'] as const;

/** At most this many team members are read for the self and same-domain rules. */
const TEAM_READ_MAX = 500;

/** Partner sign-ups listed per partner on the Platform admin page. */
export const PARTNER_SIGNUPS_MAX = 200;

/** MariaDB/MySQL duplicate-key error. */
const ER_DUP_ENTRY = 1062;

export function isDuplicateKey(error: unknown): boolean {
  const marks = (candidate: unknown) =>
    typeof candidate === 'object' &&
    candidate !== null &&
    ((candidate as { errno?: number }).errno === ER_DUP_ENTRY ||
      (candidate as { code?: string }).code === 'ER_DUP_ENTRY');
  return (
    marks(error) ||
    (typeof error === 'object' && error !== null && marks((error as { cause?: unknown }).cause))
  );
}

type Row = RowDataPacket & Record<string, unknown>;

function date(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

export interface ReferralCodeRecord {
  readonly id: string;
  readonly code: string;
}

export interface ReferredAgency {
  readonly name: string;
  readonly signedUpAt: Date;
}

export interface WorkspaceCodeTarget {
  readonly organizationId: string;
  readonly codeId: string;
  readonly teamUserIds: readonly string[];
}

export interface PartnerRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface PartnerSignupRecord {
  readonly partnerId: string;
  readonly name: string;
  readonly outcome: ReferralOutcome;
  readonly signedUpAt: Date;
}

export interface NewReferralSignup {
  readonly referralCodeId: string;
  readonly referredOrganizationId: string;
  readonly referredName: string;
  readonly outcome: ReferralOutcome;
  readonly signedUpAt: Date;
}

export class ReferralsRepository {
  // ── Tenant path ────────────────────────────────────────────────────────────

  async readCode(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<ReferralCodeRecord | null> {
    const rows = await runner.execute<QueryRows>(
      'select rc.id as id, rc.code as code from referral_codes rc where rc.organization_id = ? limit 1',
      [context.organizationId],
    );
    const row = rows[0];
    return row === undefined ? null : { id: String(row['id']), code: String(row['code']) };
  }

  /** The workspace's web link, the readable start of its code. */
  async readSlug(runner: TenantQueryRunner, context: TenantContext): Promise<string> {
    const rows = await runner.execute<QueryRows>(
      'select o.slug as slug from organizations o where o.id = ? limit 1',
      [context.organizationId],
    );
    return String(rows[0]?.['slug'] ?? 'workspace');
  }

  /** One code per workspace; a racing second insert fails on `uq_referral_codes_org`. */
  async insertCode(
    runner: TenantQueryRunner,
    context: TenantContext,
    code: string,
    createdAt: Date,
  ): Promise<void> {
    await runner.execute(
      `insert into referral_codes (id, organization_id, code, created_by_membership_id, created_at)
       values (?, ?, ?, ?, ?)`,
      [uuidv7(), context.organizationId, code, context.membershipId, createdAt],
    );
  }

  /** The owner's list: counted sign-ups only, name and date only, newest first. */
  async listCounted(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<{ readonly total: number; readonly agencies: readonly ReferredAgency[] }> {
    const totals = await runner.execute<QueryRows>(
      `select count(*) as total from referral_signups rs
        where rs.organization_id = ? and rs.outcome = 'counted'`,
      [context.organizationId],
    );
    const rows = await runner.execute<QueryRows>(
      `select rs.referred_name as referred_name, rs.signed_up_at as signed_up_at
         from referral_signups rs
        where rs.organization_id = ? and rs.outcome = 'counted'
        order by rs.signed_up_at desc
        limit ${String(REFERRAL_LIST_MAX)}`,
      [context.organizationId],
    );
    return {
      total: Number(totals[0]?.['total'] ?? 0),
      agencies: rows.map((row) => ({
        name: String(row['referred_name']),
        signedUpAt: date(row['signed_up_at']),
      })),
    };
  }

  /** Counted rows with a recorded reward (shown only outside the beta). */
  async countRecordedRewards(runner: TenantQueryRunner, context: TenantContext): Promise<number> {
    const rows = await runner.execute<QueryRows>(
      `select count(*) as total from referral_signups rs
        where rs.organization_id = ? and rs.reward_state = 'recorded'`,
      [context.organizationId],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  async countCountedSince(
    runner: TenantQueryRunner,
    context: TenantContext,
    since: Date,
  ): Promise<number> {
    const rows = await runner.execute<QueryRows>(
      `select count(*) as total from referral_signups rs
        where rs.organization_id = ? and rs.outcome = 'counted' and rs.signed_up_at >= ?`,
      [context.organizationId, since],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  async insertSignup(
    runner: TenantQueryRunner,
    context: TenantContext,
    signup: NewReferralSignup,
  ): Promise<void> {
    const counted = signup.outcome === 'counted';
    await runner.execute(
      `insert into referral_signups
         (id, organization_id, referral_code_id, referred_organization_id, referred_name, outcome,
          reward_kind, reward_state, signed_up_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv7(),
        context.organizationId,
        signup.referralCodeId,
        signup.referredOrganizationId,
        signup.referredName,
        signup.outcome,
        counted ? 'account_credit' : null,
        counted ? 'recorded' : null,
        signup.signedUpAt,
      ],
    );
  }

  // ── Bootstrap path ─────────────────────────────────────────────────────────

  async resolveWorkspaceCode(
    runner: BootstrapQueryRunner,
    code: string,
  ): Promise<WorkspaceCodeTarget | null> {
    const codes = await runner.query<Row[]>(
      'select rc.id as id, rc.organization_id as organization_id from referral_codes rc where rc.code = ? limit 1',
      [code],
    );
    const found = codes[0];
    if (found === undefined) return null;
    const organizationId = String(found['organization_id']);
    const members = await runner.query<Row[]>(
      `select m.user_id as user_id, m.role as role from memberships m
        where m.organization_id = ? and m.status = 'active'
        limit ${String(TEAM_READ_MAX)}`,
      [organizationId],
    );
    return {
      organizationId,
      codeId: String(found['id']),
      teamUserIds: members
        .filter((row) => isTeamRole(String(row['role'])))
        .map((row) => String(row['user_id'])),
    };
  }

  /** Platform totals by outcome, across workspaces. No name, no person. */
  async workspaceTotals(
    runner: BootstrapQueryRunner,
  ): Promise<Readonly<Record<ReferralOutcome, number>>> {
    const rows = await runner.query<Row[]>(
      'select rs.outcome as outcome, count(*) as total from referral_signups rs group by rs.outcome',
    );
    const totals: Record<ReferralOutcome, number> = {
      counted: 0,
      self: 0,
      same_domain: 0,
      rate_limited: 0,
    };
    for (const row of rows) {
      if (isReferralOutcome(row['outcome'])) totals[row['outcome']] = Number(row['total'] ?? 0);
    }
    return totals;
  }

  // ── Identity path ──────────────────────────────────────────────────────────

  async emailsOf(runner: IdentityQueryRunner, userIds: readonly string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await runner.query<Row[]>(
      `select u.email as email from users u where u.id in (${userIds.map(() => '?').join(', ')})`,
      [...userIds],
    );
    return rows.map((row) => String(row['email']));
  }

  async findPartner(runner: IdentityQueryRunner, code: string): Promise<PartnerRecord | null> {
    const rows = await runner.query<Row[]>(
      `select p.id as id, p.code as code, p.name as name, p.created_at as created_at
         from referral_partners p where p.code = ? limit 1`,
      [code],
    );
    const row = rows[0];
    return row === undefined ? null : partnerOf(row);
  }

  async countPartnerCountedSince(
    runner: IdentityQueryRunner,
    partnerId: string,
    since: Date,
  ): Promise<number> {
    const rows = await runner.query<Row[]>(
      `select count(*) as total from referral_partner_signups ps
        where ps.partner_id = ? and ps.outcome = 'counted' and ps.signed_up_at >= ?`,
      [partnerId, since],
    );
    return Number(rows[0]?.['total'] ?? 0);
  }

  async insertPartnerSignup(
    runner: IdentityQueryRunner,
    signup: {
      readonly partnerId: string;
      readonly referredOrganizationId: string;
      readonly referredName: string;
      readonly outcome: ReferralOutcome;
      readonly signedUpAt: Date;
    },
  ): Promise<void> {
    await runner.query(
      `insert into referral_partner_signups
         (id, partner_id, referred_organization_id, referred_name, outcome, signed_up_at)
       values (?, ?, ?, ?, ?, ?)`,
      [
        uuidv7(),
        signup.partnerId,
        signup.referredOrganizationId,
        signup.referredName,
        signup.outcome,
        signup.signedUpAt,
      ],
    );
  }

  async insertPartner(
    runner: IdentityQueryRunner,
    partner: { readonly id: string; readonly code: string; readonly name: string },
    createdByUserId: string,
    createdAt: Date,
  ): Promise<void> {
    await runner.query(
      `insert into referral_partners (id, code, name, created_by_user_id, created_at)
       values (?, ?, ?, ?, ?)`,
      [partner.id, partner.code, partner.name, createdByUserId, createdAt],
    );
  }

  async listPartners(runner: IdentityQueryRunner): Promise<readonly PartnerRecord[]> {
    const rows = await runner.query<Row[]>(
      `select p.id as id, p.code as code, p.name as name, p.created_at as created_at
         from referral_partners p order by p.created_at desc limit 200`,
    );
    return rows.map(partnerOf);
  }

  async listPartnerSignups(runner: IdentityQueryRunner): Promise<readonly PartnerSignupRecord[]> {
    const rows = await runner.query<Row[]>(
      `select ps.partner_id as partner_id, ps.referred_name as referred_name, ps.outcome as outcome,
              ps.signed_up_at as signed_up_at
         from referral_partner_signups ps
        order by ps.signed_up_at desc
        limit ${String(PARTNER_SIGNUPS_MAX * 10)}`,
    );
    return rows.flatMap((row) =>
      isReferralOutcome(row['outcome'])
        ? [
            {
              partnerId: String(row['partner_id']),
              name: String(row['referred_name']),
              outcome: row['outcome'],
              signedUpAt: date(row['signed_up_at']),
            },
          ]
        : [],
    );
  }
}

function partnerOf(row: Row): PartnerRecord {
  return {
    id: String(row['id']),
    code: String(row['code']),
    name: String(row['name']),
    createdAt: date(row['created_at']),
  };
}
