import type { ResultSetHeader } from 'mysql2';
import type {
  BootstrapQueryRunner,
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { LivePack, PeriodCredits, PeriodDraw } from './ai-packs.js';

/**
 * 62-07 (plan 62 §5). Every statement on the credit packs, the packs ledger (`ai_credit_pack_moves`,
 * 0390), the owner's pack requests (`ai_credit_pack_requests`, 0390), the pack columns of
 * `ai_workspace_periods` and the platform's AI settings of a workspace (`ai_workspace_settings`,
 * 0383: test list and pool class).
 *
 * Billing owns the packs and requests; the budget service (copilot) owns the period counters and
 * reaches the pack moves only through `AiPacksService` as its `AiPackTopUp` port (AR-5).
 *
 * Every counter move is one conditional UPDATE whose `WHERE` is the rule and whose answer is "did
 * one row change" (the `ai-budget.repository.ts` shape, DA-1): a pack never goes below 0 or above its
 * size, and never moves once expired. Every tenant statement carries `organization_id = ?` bound to
 * the context (DA-12); the two platform reads are cross-tenant on a declared bootstrap runner. Times
 * are bound values, never the database clock (DA-10). No text is ever written: counts and ids.
 */

export type IsoDate = string;
export type AiPackRequestStatus = 'open' | 'granted' | 'declined';
export type AiPoolClass = 'customers' | 'testing';

export interface AiPackRequestRecord {
  readonly id: string;
  readonly status: AiPackRequestStatus;
  readonly requestedByMembershipId: string;
  readonly requestedAt: Date;
  readonly decidedAt: Date | null;
  readonly packId: string | null;
}

export interface AiWorkspacePlatformSettings {
  readonly onTestList: boolean;
  readonly testListAt: Date | null;
  readonly poolClass: AiPoolClass;
  readonly memberSharePercent: number;
}

export interface PeriodRow extends PeriodCredits {
  readonly periodStart: IsoDate;
}

/** One workspace on the test list, for the platform admin's table. */
export interface TestListRow {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly testListAt: Date;
  readonly poolClass: AiPoolClass;
}

/** One open pack request across workspaces, for the platform admin's queue. */
export interface OpenRequestRow {
  readonly id: string;
  readonly organizationId: string;
  readonly requestedAt: Date;
}

const SQL = {
  settings: `select test_list_at, pool_class, member_share_percent from ai_workspace_settings
    where organization_id = ? limit 1`,
  upsertPlatformSettings: `insert into ai_workspace_settings
    (id, organization_id, ai_enabled, write_scope, run_at_once, member_share_percent, test_list_at,
     pool_class, created_at, updated_at)
    values (?, ?, 0, 'read', 0, 50, ?, ?, ?, ?)
    on duplicate key update test_list_at = values(test_list_at), pool_class = values(pool_class),
      updated_at = values(updated_at)`,

  lockPeriod: `select period_start, allowance_credits, pack_credits, settled_credits, reserved_credits
    from ai_workspace_periods where organization_id = ? and period_start = ? for update`,
  readPeriod: `select period_start, allowance_credits, pack_credits, settled_credits, reserved_credits
    from ai_workspace_periods where organization_id = ? and period_start = ? limit 1`,
  addPackCredits: `update ai_workspace_periods set pack_credits = pack_credits + ?, updated_at = ?
    where organization_id = ? and period_start = ?`,
  closedPeriods: `select period_start, allowance_credits, pack_credits, settled_credits, reserved_credits
    from ai_workspace_periods
    where organization_id = ? and period_start < ? and pack_credits > 0
      and pack_returned_at is null and reserved_credits = 0
    order by period_start for update`,
  markReturned: `update ai_workspace_periods set pack_returned_at = ?, updated_at = ?
    where organization_id = ? and period_start = ? and pack_returned_at is null`,

  livePacks: `select id, remaining_credits, granted_at, expires_at from ai_credit_packs
    where organization_id = ? and remaining_credits > 0 and expires_at > ?
    order by granted_at, id`,
  lockLivePacks: `select id, remaining_credits, granted_at, expires_at from ai_credit_packs
    where organization_id = ? and remaining_credits > 0 and expires_at > ?
    order by granted_at, id for update`,
  drawPack: `update ai_credit_packs set remaining_credits = remaining_credits - ?
    where organization_id = ? and id = ? and remaining_credits >= ? and expires_at > ?`,
  returnPack: `update ai_credit_packs set remaining_credits = remaining_credits + ?
    where organization_id = ? and id = ? and expires_at > ? and remaining_credits + ? <= size_credits`,
  insertPack: `insert into ai_credit_packs
    (id, organization_id, size_credits, remaining_credits, source, requested_by_membership_id,
     granted_by_user_id, granted_at, expires_at, created_at)
    values (?, ?, ?, ?, 'grant', ?, ?, ?, ?, ?)`,
  insertMove: `insert into ai_credit_pack_moves
    (id, organization_id, pack_id, period_start, direction, credits, created_at)
    values (?, ?, ?, ?, ?, ?, ?)`,
  periodDraws: `select p.id as id, p.remaining_credits as remaining_credits, p.granted_at as granted_at,
      p.expires_at as expires_at, sum(m.credits) as drawn_credits
    from ai_credit_pack_moves m
    join ai_credit_packs p on p.organization_id = m.organization_id and p.id = m.pack_id
    where m.organization_id = ? and p.organization_id = ? and m.period_start = ?
      and m.direction = 'draw'
    group by p.id, p.remaining_credits, p.granted_at, p.expires_at`,

  openRequest: `select id, status, requested_by_membership_id, requested_at, decided_at, pack_id
    from ai_credit_pack_requests where organization_id = ? and open_slot = 1 limit 1`,
  lockRequest: `select id, status, requested_by_membership_id, requested_at, decided_at, pack_id
    from ai_credit_pack_requests where organization_id = ? and id = ? for update`,
  insertRequest: `insert into ai_credit_pack_requests
    (id, organization_id, requested_by_membership_id, status, open_slot, requested_at)
    values (?, ?, ?, 'open', 1, ?)`,
  decideRequest: `update ai_credit_pack_requests
    set status = ?, open_slot = null, pack_id = ?, decided_by_user_id = ?, decided_at = ?
    where organization_id = ? and id = ? and status = 'open'`,

  organization: `select id, name, slug from organizations where id = ? limit 1`,

  testList: `select s.organization_id as organization_id, o.name as name, o.slug as slug,
      s.test_list_at as test_list_at, s.pool_class as pool_class
    from ai_workspace_settings s join organizations o on o.id = s.organization_id
    where s.test_list_at is not null
    order by s.test_list_at, s.organization_id
    limit ?`,
  openRequests: `select r.id as id, r.organization_id as organization_id, r.requested_at as requested_at
    from ai_credit_pack_requests r where r.status = 'open'
    order by r.requested_at, r.id
    limit ?`,
} as const;

/** The tables the platform's two cross-tenant reads declare (bootstrap runner). */
export const AI_PACKS_PLATFORM_TABLES = [
  'ai_workspace_settings',
  'organizations',
  'ai_credit_pack_requests',
] as const;

function changed(result: ResultSetHeader): boolean {
  return result.affectedRows === 1;
}

function count(row: QueryRows[number], column: string): number {
  const value = Number(row[column] ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`ai packs: column ${column} is not a count`);
  }
  return value;
}

function at(value: unknown, column: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime()))
    throw new TypeError(`ai packs: column ${column} is not a time`);
  return parsed;
}

function atOrNull(value: unknown, column: string): Date | null {
  return value === null || value === undefined ? null : at(value, column);
}

function isoDate(value: unknown): IsoDate {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  throw new TypeError('ai packs: not a DATE value');
}

function poolClassOf(value: unknown): AiPoolClass {
  return value === 'testing' ? 'testing' : 'customers';
}

function asPeriod(row: QueryRows[number]): PeriodRow {
  return {
    periodStart: isoDate(row['period_start']),
    allowanceCredits: count(row, 'allowance_credits'),
    packCredits: count(row, 'pack_credits'),
    settledCredits: count(row, 'settled_credits'),
    reservedCredits: count(row, 'reserved_credits'),
  };
}

function asPack(row: QueryRows[number]): LivePack {
  return {
    id: String(row['id']),
    remainingCredits: count(row, 'remaining_credits'),
    grantedAt: at(row['granted_at'], 'granted_at'),
    expiresAt: at(row['expires_at'], 'expires_at'),
  };
}

function asRequest(row: QueryRows[number]): AiPackRequestRecord {
  const status = row['status'];
  return {
    id: String(row['id']),
    status: status === 'granted' || status === 'declined' ? status : 'open',
    requestedByMembershipId: String(row['requested_by_membership_id']),
    requestedAt: at(row['requested_at'], 'requested_at'),
    decidedAt: atOrNull(row['decided_at'], 'decided_at'),
    packId: row['pack_id'] === null || row['pack_id'] === undefined ? null : String(row['pack_id']),
  };
}

export class AiPacksRepository {
  // ── The workspace's platform-set AI settings ─────────────────────────────────

  /** No row = defaults: not on the test list, customers pool, 50 % member share. */
  async settings(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<AiWorkspacePlatformSettings> {
    const rows = await runner.execute<QueryRows>(SQL.settings, [context.organizationId]);
    const row = rows[0];
    if (row === undefined) {
      return {
        onTestList: false,
        testListAt: null,
        poolClass: 'customers',
        memberSharePercent: 50,
      };
    }
    const testListAt = atOrNull(row['test_list_at'], 'test_list_at');
    return {
      onTestList: testListAt !== null,
      testListAt,
      poolClass: poolClassOf(row['pool_class']),
      memberSharePercent: count(row, 'member_share_percent'),
    };
  }

  /** Put the workspace on (a time) or off (null) the test list, and set its pool class. */
  async writePlatformSettings(
    tx: TenantQueryRunner,
    context: TenantContext,
    input: { id: string; testListAt: Date | null; poolClass: AiPoolClass; now: Date },
  ): Promise<void> {
    await tx.execute(SQL.upsertPlatformSettings, [
      input.id,
      context.organizationId,
      input.testListAt,
      input.poolClass,
      input.now,
      input.now,
    ]);
  }

  /** The workspace row itself, inside the tenant transaction (null = no such workspace). */
  async organization(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<{ id: string; name: string; slug: string } | null> {
    const rows = await runner.execute<QueryRows>(SQL.organization, [context.organizationId]);
    const row = rows[0];
    return row === undefined
      ? null
      : { id: String(row['id']), name: String(row['name']), slug: String(row['slug']) };
  }

  // ── Period pack columns ──────────────────────────────────────────────────────

  async lockPeriod(
    tx: TenantQueryRunner,
    context: TenantContext,
    periodStart: IsoDate,
  ): Promise<PeriodRow | null> {
    const rows = await tx.execute<QueryRows>(SQL.lockPeriod, [context.organizationId, periodStart]);
    return rows[0] === undefined ? null : asPeriod(rows[0]);
  }

  async readPeriod(
    runner: TenantQueryRunner,
    context: TenantContext,
    periodStart: IsoDate,
  ): Promise<PeriodRow | null> {
    const rows = await runner.execute<QueryRows>(SQL.readPeriod, [
      context.organizationId,
      periodStart,
    ]);
    return rows[0] === undefined ? null : asPeriod(rows[0]);
  }

  async addPackCredits(
    tx: TenantQueryRunner,
    context: TenantContext,
    periodStart: IsoDate,
    credits: number,
    now: Date,
  ): Promise<boolean> {
    return changed(
      await tx.execute<ResultSetHeader>(SQL.addPackCredits, [
        credits,
        now,
        context.organizationId,
        periodStart,
      ]),
    );
  }

  /** Closed periods still holding pack credits, oldest first, locked (no hold may be open). */
  async lockClosedPeriodsWithPackCredits(
    tx: TenantQueryRunner,
    context: TenantContext,
    beforePeriod: IsoDate,
  ): Promise<readonly PeriodRow[]> {
    const rows = await tx.execute<QueryRows>(SQL.closedPeriods, [
      context.organizationId,
      beforePeriod,
    ]);
    return rows.map(asPeriod);
  }

  async markReturned(
    tx: TenantQueryRunner,
    context: TenantContext,
    periodStart: IsoDate,
    now: Date,
  ): Promise<boolean> {
    return changed(
      await tx.execute<ResultSetHeader>(SQL.markReturned, [
        now,
        now,
        context.organizationId,
        periodStart,
      ]),
    );
  }

  // ── Packs and the packs ledger ───────────────────────────────────────────────

  async livePacks(
    runner: TenantQueryRunner,
    context: TenantContext,
    now: Date,
  ): Promise<readonly LivePack[]> {
    const rows = await runner.execute<QueryRows>(SQL.livePacks, [context.organizationId, now]);
    return rows.map(asPack);
  }

  /** The live packs with credits left, locked, oldest grant first (lock order: period, then packs). */
  async lockLivePacks(
    tx: TenantQueryRunner,
    context: TenantContext,
    now: Date,
  ): Promise<readonly LivePack[]> {
    const rows = await tx.execute<QueryRows>(SQL.lockLivePacks, [context.organizationId, now]);
    return rows.map(asPack);
  }

  async drawFromPack(
    tx: TenantQueryRunner,
    context: TenantContext,
    packId: string,
    credits: number,
    now: Date,
  ): Promise<boolean> {
    return changed(
      await tx.execute<ResultSetHeader>(SQL.drawPack, [
        credits,
        context.organizationId,
        packId,
        credits,
        now,
      ]),
    );
  }

  async returnToPack(
    tx: TenantQueryRunner,
    context: TenantContext,
    packId: string,
    credits: number,
    now: Date,
  ): Promise<boolean> {
    return changed(
      await tx.execute<ResultSetHeader>(SQL.returnPack, [
        credits,
        context.organizationId,
        packId,
        now,
        credits,
      ]),
    );
  }

  async insertMove(
    tx: TenantQueryRunner,
    context: TenantContext,
    move: {
      id: string;
      packId: string;
      periodStart: IsoDate;
      direction: 'draw' | 'return';
      credits: number;
      now: Date;
    },
  ): Promise<void> {
    await tx.execute(SQL.insertMove, [
      move.id,
      context.organizationId,
      move.packId,
      move.periodStart,
      move.direction,
      move.credits,
      move.now,
    ]);
  }

  /** What one period drew from each pack, with the pack's grant and expiry. */
  async periodDraws(
    tx: TenantQueryRunner,
    context: TenantContext,
    periodStart: IsoDate,
  ): Promise<readonly PeriodDraw[]> {
    const rows = await tx.execute<QueryRows>(SQL.periodDraws, [
      context.organizationId,
      context.organizationId,
      periodStart,
    ]);
    return rows.map((row) => ({ ...asPack(row), drawnCredits: count(row, 'drawn_credits') }));
  }

  async insertPack(
    tx: TenantQueryRunner,
    context: TenantContext,
    pack: {
      id: string;
      sizeCredits: number;
      requestedByMembershipId: string | null;
      grantedByUserId: string;
      grantedAt: Date;
      expiresAt: Date;
    },
  ): Promise<void> {
    await tx.execute(SQL.insertPack, [
      pack.id,
      context.organizationId,
      pack.sizeCredits,
      pack.sizeCredits,
      pack.requestedByMembershipId,
      pack.grantedByUserId,
      pack.grantedAt,
      pack.expiresAt,
      pack.grantedAt,
    ]);
  }

  // ── Pack requests ────────────────────────────────────────────────────────────

  async openRequest(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<AiPackRequestRecord | null> {
    const rows = await runner.execute<QueryRows>(SQL.openRequest, [context.organizationId]);
    return rows[0] === undefined ? null : asRequest(rows[0]);
  }

  async lockRequest(
    tx: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
  ): Promise<AiPackRequestRecord | null> {
    const rows = await tx.execute<QueryRows>(SQL.lockRequest, [context.organizationId, requestId]);
    return rows[0] === undefined ? null : asRequest(rows[0]);
  }

  /** Insert an open request. A second open one fails on `uq_ai_credit_pack_requests_open`. */
  async insertRequest(
    tx: TenantQueryRunner,
    context: TenantContext,
    input: { id: string; membershipId: string; now: Date },
  ): Promise<void> {
    await tx.execute(SQL.insertRequest, [
      input.id,
      context.organizationId,
      input.membershipId,
      input.now,
    ]);
  }

  async decideRequest(
    tx: TenantQueryRunner,
    context: TenantContext,
    input: {
      requestId: string;
      status: 'granted' | 'declined';
      packId: string | null;
      decidedByUserId: string;
      now: Date;
    },
  ): Promise<boolean> {
    return changed(
      await tx.execute<ResultSetHeader>(SQL.decideRequest, [
        input.status,
        input.packId,
        input.decidedByUserId,
        input.now,
        context.organizationId,
        input.requestId,
      ]),
    );
  }

  // ── Platform reads (cross-tenant, declared bootstrap runner) ─────────────────

  async testList(runner: BootstrapQueryRunner, limit: number): Promise<readonly TestListRow[]> {
    const rows = await runner.query<QueryRows>(SQL.testList, [limit]);
    return rows.map((row) => ({
      organizationId: String(row['organization_id']),
      name: String(row['name']),
      slug: String(row['slug']),
      testListAt: at(row['test_list_at'], 'test_list_at'),
      poolClass: poolClassOf(row['pool_class']),
    }));
  }

  async openRequests(
    runner: BootstrapQueryRunner,
    limit: number,
  ): Promise<readonly OpenRequestRow[]> {
    const rows = await runner.query<QueryRows>(SQL.openRequests, [limit]);
    return rows.map((row) => ({
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      requestedAt: at(row['requested_at'], 'requested_at'),
    }));
  }
}

/** The SQL, for the repository unit test that pins each rule's predicate. */
export const AI_PACKS_SQL = SQL;
