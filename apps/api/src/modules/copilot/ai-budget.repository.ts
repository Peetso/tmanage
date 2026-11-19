import type { ResultSetHeader } from 'mysql2';
import type {
  BootstrapQueryRunner,
  QueryRows,
  SqlParameter,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AiUsage } from './ai-cost.js';
import type {
  AiActivity,
  AiPool,
  AiSpendingPool,
  AiTier,
  AiWorkspaceStanding,
} from './ai-tiers.js';

/**
 * The AI budget counters and ledger (plan 62 §5, slice 62-06, B13) over the 0381–0383 tables.
 *
 * Every counter move is one conditional UPDATE whose `WHERE` clause *is* the rule and whose answer
 * is "did a row change" — the shape of `files/usage-counters.repository.ts`. InnoDB re-evaluates
 * the predicate after the row lock is granted, so two holds racing for the last credit serialise on
 * the row and exactly one sees a predicate that still holds. That is what keeps the invariant
 * `settled + reserved <= cap` true at every moment on all three levels (member, workspace, pool);
 * the unsigned counter columns refuse an underflow at the engine for any statement this file did not
 * write.
 *
 * Statements are written out with bound placeholders (the Drizzle mirror of these tables lands with
 * the wave's schema wiring; nothing here depends on it). Every statement on a tenant table carries
 * `organization_id = ?` bound to the context's organization; `ai_budget_pools` is a platform table.
 * Dates and times are always bound values, never the database clock. No prompt, answer or argument
 * text is ever written: the ledger holds counts, models, versions and ids.
 */

/** `YYYY-MM-DD`, the first day of the month (a period) or a day (the daily limits). */
export type IsoDate = string;

export type AiTaskStatus = 'running' | 'completed' | 'failed' | 'refused' | 'cancelled' | 'undone';
export type AiCallStatus = 'reserved' | 'sent' | 'settled' | 'released' | 'expired';

export interface AiTaskRecord {
  readonly id: string;
  readonly membershipId: string;
  readonly tier: AiTier;
  readonly pool: AiSpendingPool;
  readonly status: AiTaskStatus;
  readonly ceilingCredits: number;
  readonly chargedCredits: number;
  readonly costMicroUsd: number;
  readonly startedAt: Date;
}

export interface NewAiTask {
  readonly id: string;
  readonly membershipId: string;
  readonly tier: AiTier;
  readonly activity: AiActivity;
  readonly pool: AiSpendingPool;
  readonly ceilingCredits: number;
  readonly startedAt: Date;
}

export interface AiCallRecord {
  readonly id: string;
  readonly taskId: string;
  readonly pool: AiSpendingPool;
  readonly poolPeriodStart: IsoDate;
  readonly status: AiCallStatus;
  readonly model: string;
  readonly holdMicroUsd: number;
}

export interface NewAiCallHold {
  readonly id: string;
  readonly taskId: string;
  readonly membershipId: string;
  readonly pool: AiSpendingPool;
  readonly poolPeriodStart: IsoDate;
  readonly model: string;
  readonly priceTableVersion: string;
  readonly holdMicroUsd: number;
  readonly holdCredits: number;
  readonly reservedAt: Date;
  readonly holdExpiresAt: Date;
}

/** What a settled call records: the real cost and every usage bucket it was computed from. */
export interface AiCallSettlement {
  readonly costMicroUsd: number;
  readonly usage: AiUsage;
  readonly toolCalls: number;
  readonly latencyMs: number | null;
  readonly stopReason: string | null;
  readonly providerMessageId: string | null;
  readonly settledAt: Date;
}

/** The task's spend so far: settled cost and the holds still open, both in micro-USD. */
export interface AiTaskSpend {
  readonly settledMicroUsd: number;
  readonly openHoldMicroUsd: number;
  readonly openCalls: number;
}

export interface AiPoolState {
  readonly capMicroUsd: number;
  readonly settledMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly paused: boolean;
}

/** Why the platform paused itself (`ai_budget_pools.paused_reason`). */
export type AiPauseReason = 'over_settlement';

/** A lost call's terminal state: never sent = expired (released), sent = settled in full. */
export type AiLostCallClose = 'expired' | 'settled';

/** The reason recorded on a sent call whose result never arrived and was settled in full. */
export const LOST_RESULT_STOP_REASON = 'lost_result';

const SQL = {
  workspaceStanding: `select pool_class, test_list_at from ai_workspace_settings
    where organization_id = ? limit 1`,

  ensurePool: `insert into ai_budget_pools
    (id, pool, period_start, cap_micro_usd, settled_micro_usd, reserved_micro_usd, created_at, updated_at)
    values (?, ?, ?, ?, 0, 0, ?, ?)
    on duplicate key update id = id`,
  ensureWorkspace: `insert into ai_workspace_periods
    (id, organization_id, period_start, allowance_credits, settled_credits, reserved_credits, created_at, updated_at)
    values (?, ?, ?, ?, 0, 0, ?, ?)
    on duplicate key update id = id`,
  ensureMember: `insert into ai_member_periods
    (id, organization_id, membership_id, period_start, cap_credits, settled_credits, reserved_credits,
     free_support_count, refunds_count, created_at, updated_at)
    values (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)
    on duplicate key update id = id`,

  holdMember: `update ai_member_periods
    set reserved_credits = reserved_credits + ?, updated_at = ?
    where organization_id = ? and membership_id = ? and period_start = ?
      and settled_credits + reserved_credits + ? <= cap_credits`,
  holdWorkspace: `update ai_workspace_periods
    set reserved_credits = reserved_credits + ?, updated_at = ?
    where organization_id = ? and period_start = ? and paused_at is null
      and settled_credits + reserved_credits + ? <= allowance_credits`,
  closeMember: `update ai_member_periods
    set reserved_credits = reserved_credits - ?, settled_credits = settled_credits + ?, updated_at = ?
    where organization_id = ? and membership_id = ? and period_start = ? and reserved_credits >= ?`,
  closeWorkspace: `update ai_workspace_periods
    set reserved_credits = reserved_credits - ?, settled_credits = settled_credits + ?, updated_at = ?
    where organization_id = ? and period_start = ? and reserved_credits >= ?`,
  refundMember: `update ai_member_periods
    set settled_credits = settled_credits - ?, updated_at = ?
    where organization_id = ? and membership_id = ? and period_start = ? and settled_credits >= ?`,
  refundWorkspace: `update ai_workspace_periods
    set settled_credits = settled_credits - ?, updated_at = ?
    where organization_id = ? and period_start = ? and settled_credits >= ?`,
  countFreeSupport: `update ai_member_periods
    set free_support_count = if(free_support_day <=> ?, free_support_count + 1, 1),
        free_support_day = ?, updated_at = ?
    where organization_id = ? and membership_id = ? and period_start = ?
      and (not (free_support_day <=> ?) or free_support_count < ?)`,
  countRefund: `update ai_member_periods
    set refunds_count = if(refunds_day <=> ?, refunds_count + 1, 1),
        refunds_day = ?, updated_at = ?
    where organization_id = ? and membership_id = ? and period_start = ?
      and (not (refunds_day <=> ?) or refunds_count < ?)`,

  holdPool: `update ai_budget_pools
    set reserved_micro_usd = reserved_micro_usd + ?, updated_at = ?
    where pool = ? and period_start = ? and paused_at is null
      and (settled_micro_usd + reserved_micro_usd + ?) * 100 <= cap_micro_usd * ?`,
  settlePool: `update ai_budget_pools
    set reserved_micro_usd = reserved_micro_usd - ?, settled_micro_usd = settled_micro_usd + ?, updated_at = ?
    where pool = ? and period_start = ? and reserved_micro_usd >= ?`,
  poolState: `select cap_micro_usd, settled_micro_usd, reserved_micro_usd, paused_at
    from ai_budget_pools where pool = ? and period_start = ? limit 1`,
  pausePlatform: `update ai_budget_pools
    set paused_at = ?, paused_reason = ?, updated_at = ?
    where period_start = ? and paused_at is null`,

  insertTask: `insert into ai_tasks
    (id, organization_id, membership_id, tier, activity, pool, status, ceiling_credits,
     charged_credits, refunded_credits, cost_micro_usd, started_at)
    values (?, ?, ?, ?, ?, ?, 'running', ?, 0, 0, 0, ?)`,
  lockTask: `select id, membership_id, tier, pool, status, ceiling_credits, charged_credits,
      cost_micro_usd, started_at
    from ai_tasks where organization_id = ? and id = ? for update`,
  addTaskCost: `update ai_tasks set cost_micro_usd = cost_micro_usd + ?
    where organization_id = ? and id = ? and status = 'running'`,
  finishTask: `update ai_tasks
    set status = ?, charged_credits = ?, finished_at = ?
    where organization_id = ? and id = ? and status = 'running'`,
  undoTask: `update ai_tasks
    set status = 'undone', refunded_credits = ?, refunded_at = ?
    where organization_id = ? and id = ? and status = 'completed'`,
  staleTasks: `select id from ai_tasks
    where organization_id = ? and status = 'running' and started_at <= ?
    order by started_at, id limit ?`,

  insertHold: `insert into ai_usage_ledger
    (id, organization_id, task_id, membership_id, pool, pool_period_start, status, model,
     price_table_version, hold_micro_usd, hold_credits, reserved_at, hold_expires_at)
    values (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)`,
  findCall: `select id, task_id, pool, pool_period_start, status, model, hold_micro_usd
    from ai_usage_ledger where organization_id = ? and id = ? limit 1`,
  taskSpend: `select
      coalesce(sum(case when status in ('settled') then cost_micro_usd else 0 end), 0) as settled,
      coalesce(sum(case when status in ('reserved', 'sent') then hold_micro_usd else 0 end), 0) as open_hold,
      coalesce(sum(case when status in ('reserved', 'sent') then 1 else 0 end), 0) as open_calls
    from ai_usage_ledger where organization_id = ? and task_id = ?`,
  markSent: `update ai_usage_ledger set status = 'sent', sent_at = ?
    where organization_id = ? and id = ? and status = 'reserved'`,
  settleCall: `update ai_usage_ledger
    set status = 'settled', cost_micro_usd = ?, input_tokens = ?, cache_write_5m_tokens = ?,
        cache_write_1h_tokens = ?, cache_read_tokens = ?, output_tokens = ?, tool_calls = ?,
        latency_ms = ?, stop_reason = ?, provider_message_id = ?, settled_at = ?
    where organization_id = ? and id = ? and status = 'sent'`,
  releaseCall: `update ai_usage_ledger set status = 'released', settled_at = ?
    where organization_id = ? and id = ? and status = 'reserved'`,
  closeLostCall: `update ai_usage_ledger
    set status = ?, cost_micro_usd = ?, stop_reason = ?, settled_at = ?
    where organization_id = ? and id = ? and status = ? and hold_expires_at <= ?`,
  lostCalls: `select id, task_id, pool, pool_period_start, status, model, hold_micro_usd
    from ai_usage_ledger
    where organization_id = ? and status in ('reserved', 'sent') and hold_expires_at <= ?
    order by hold_expires_at, id limit ?`,
  organizationsWithLostCalls: `select distinct organization_id from ai_usage_ledger
    where status in ('reserved', 'sent') and hold_expires_at <= ?
    order by organization_id limit ?`,
} as const;

/** A counter value read back from MariaDB (BIGINT may arrive as a string). */
function count(row: QueryRows[number], column: string): number {
  const value = Number(row[column]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`ai budget: column ${column} is not a counter`);
  }
  return value;
}

/** A DATE column as `YYYY-MM-DD`, whether the driver hands a Date or a string. */
function isoDate(value: unknown): IsoDate {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  throw new TypeError('ai budget: not a DATE value');
}

function changed(result: ResultSetHeader): boolean {
  return result.affectedRows === 1;
}

function asCall(row: QueryRows[number]): AiCallRecord {
  return {
    id: String(row['id']),
    taskId: String(row['task_id']),
    pool: row['pool'] as AiSpendingPool,
    poolPeriodStart: isoDate(row['pool_period_start']),
    status: row['status'] as AiCallStatus,
    model: String(row['model']),
    holdMicroUsd: count(row, 'hold_micro_usd'),
  };
}

export class AiBudgetRepository {
  private async update(
    runner: TenantQueryRunner,
    sql: string,
    params: readonly SqlParameter[],
  ): Promise<boolean> {
    return changed(await runner.execute<ResultSetHeader>(sql, params));
  }

  // ── Workspace standing ──────────────────────────────────────────────────────

  /** The platform-set pool class and test-list mark. No row = defaults (customers, not listed). */
  async workspaceStanding(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<AiWorkspaceStanding> {
    const rows = await runner.execute<QueryRows>(SQL.workspaceStanding, [context.organizationId]);
    const row = rows[0];
    if (row === undefined) return { poolClass: 'customers', onTestList: false };
    return {
      poolClass: row['pool_class'] === 'testing' ? 'testing' : 'customers',
      onTestList: row['test_list_at'] !== null && row['test_list_at'] !== undefined,
    };
  }

  // ── Period rows (idempotent; the first insert fixes the cap) ────────────────

  async ensurePoolPeriod(
    runner: TenantQueryRunner,
    input: { id: string; pool: AiPool; periodStart: IsoDate; capMicroUsd: number; now: Date },
  ): Promise<void> {
    await runner.execute(SQL.ensurePool, [
      input.id,
      input.pool,
      input.periodStart,
      input.capMicroUsd,
      input.now,
      input.now,
    ]);
  }

  async ensureWorkspacePeriod(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: { id: string; periodStart: IsoDate; allowanceCredits: number; now: Date },
  ): Promise<void> {
    await runner.execute(SQL.ensureWorkspace, [
      input.id,
      context.organizationId,
      input.periodStart,
      input.allowanceCredits,
      input.now,
      input.now,
    ]);
  }

  async ensureMemberPeriod(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      id: string;
      membershipId: string;
      periodStart: IsoDate;
      capCredits: number;
      now: Date;
    },
  ): Promise<void> {
    await runner.execute(SQL.ensureMember, [
      input.id,
      context.organizationId,
      input.membershipId,
      input.periodStart,
      input.capCredits,
      input.now,
      input.now,
    ]);
  }

  // ── Credit holds (member, workspace) ────────────────────────────────────────

  /** Hold `credits` of the member's share if `settled + reserved + credits <= cap`. */
  holdMemberCredits(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    periodStart: IsoDate,
    credits: number,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.holdMember, [
      credits,
      now,
      context.organizationId,
      membershipId,
      periodStart,
      credits,
    ]);
  }

  /** Hold `credits` of the workspace allowance if not paused and within the allowance. */
  holdWorkspaceCredits(
    runner: TenantQueryRunner,
    context: TenantContext,
    periodStart: IsoDate,
    credits: number,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.holdWorkspace, [
      credits,
      now,
      context.organizationId,
      periodStart,
      credits,
    ]);
  }

  /** Close a member hold: release `held`, debit `charged` (`charged <= held`). */
  closeMemberHold(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    periodStart: IsoDate,
    held: number,
    charged: number,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.closeMember, [
      held,
      charged,
      now,
      context.organizationId,
      membershipId,
      periodStart,
      held,
    ]);
  }

  closeWorkspaceHold(
    runner: TenantQueryRunner,
    context: TenantContext,
    periodStart: IsoDate,
    held: number,
    charged: number,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.closeWorkspace, [
      held,
      charged,
      now,
      context.organizationId,
      periodStart,
      held,
    ]);
  }

  refundMemberCredits(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    periodStart: IsoDate,
    credits: number,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.refundMember, [
      credits,
      now,
      context.organizationId,
      membershipId,
      periodStart,
      credits,
    ]);
  }

  refundWorkspaceCredits(
    runner: TenantQueryRunner,
    context: TenantContext,
    periodStart: IsoDate,
    credits: number,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.refundWorkspace, [
      credits,
      now,
      context.organizationId,
      periodStart,
      credits,
    ]);
  }

  // ── Per-member daily limits (the count resets when the day changes) ─────────

  /** Count one free help answer for `day` if fewer than `limit` were counted that day. */
  countFreeSupport(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    periodStart: IsoDate,
    day: IsoDate,
    limit: number,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.countFreeSupport, [
      day,
      day,
      now,
      context.organizationId,
      membershipId,
      periodStart,
      day,
      limit,
    ]);
  }

  /** Count one undo refund for `day` if fewer than `limit` were counted that day. */
  countRefund(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    periodStart: IsoDate,
    day: IsoDate,
    limit: number,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.countRefund, [
      day,
      day,
      now,
      context.organizationId,
      membershipId,
      periodStart,
      day,
      limit,
    ]);
  }

  // ── Pool (platform money) ───────────────────────────────────────────────────

  /**
   * Hold `holdMicroUsd` of the pool if it is not paused and `settled + reserved + hold` stays
   * within `limitPercent` of the cap (100, or 80 for Sonnet on the customer pool).
   */
  holdPool(
    runner: TenantQueryRunner,
    pool: AiSpendingPool,
    periodStart: IsoDate,
    holdMicroUsd: number,
    limitPercent: number,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.holdPool, [
      holdMicroUsd,
      now,
      pool,
      periodStart,
      holdMicroUsd,
      limitPercent,
    ]);
  }

  /**
   * Release the hold and record the real cost — in full, even above the hold (the pool always
   * records the real money spent). The caller pauses the platform when `cost > hold`.
   */
  settlePool(
    runner: TenantQueryRunner,
    pool: AiSpendingPool,
    periodStart: IsoDate,
    holdMicroUsd: number,
    costMicroUsd: number,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.settlePool, [
      holdMicroUsd,
      costMicroUsd,
      now,
      pool,
      periodStart,
      holdMicroUsd,
    ]);
  }

  async poolState(
    runner: TenantQueryRunner,
    pool: AiSpendingPool,
    periodStart: IsoDate,
  ): Promise<AiPoolState | null> {
    const rows = await runner.execute<QueryRows>(SQL.poolState, [pool, periodStart]);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      capMicroUsd: count(row, 'cap_micro_usd'),
      settledMicroUsd: count(row, 'settled_micro_usd'),
      reservedMicroUsd: count(row, 'reserved_micro_usd'),
      paused: row['paused_at'] !== null && row['paused_at'] !== undefined,
    };
  }

  /** Pause every pool of the period (the platform's self-pause). Idempotent. */
  async pausePlatform(
    runner: TenantQueryRunner,
    periodStart: IsoDate,
    reason: AiPauseReason,
    now: Date,
  ): Promise<void> {
    await runner.execute(SQL.pausePlatform, [now, reason, now, periodStart]);
  }

  // ── Tasks ───────────────────────────────────────────────────────────────────

  async insertTask(
    runner: TenantQueryRunner,
    context: TenantContext,
    task: NewAiTask,
  ): Promise<void> {
    await runner.execute(SQL.insertTask, [
      task.id,
      context.organizationId,
      task.membershipId,
      task.tier,
      task.activity,
      task.pool,
      task.ceilingCredits,
      task.startedAt,
    ]);
  }

  /** Read the task under its row lock. Must run inside a transaction. */
  async lockTask(
    runner: TenantQueryRunner,
    context: TenantContext,
    taskId: string,
  ): Promise<AiTaskRecord | null> {
    const rows = await runner.execute<QueryRows>(SQL.lockTask, [context.organizationId, taskId]);
    const row = rows[0];
    if (row === undefined) return null;
    const startedAt = row['started_at'];
    if (!(startedAt instanceof Date))
      throw new TypeError('ai budget: started_at is not a DATETIME');
    return {
      id: String(row['id']),
      membershipId: String(row['membership_id']),
      tier: row['tier'] as AiTier,
      pool: row['pool'] as AiSpendingPool,
      status: row['status'] as AiTaskStatus,
      ceilingCredits: count(row, 'ceiling_credits'),
      chargedCredits: count(row, 'charged_credits'),
      costMicroUsd: count(row, 'cost_micro_usd'),
      startedAt,
    };
  }

  addTaskCost(
    runner: TenantQueryRunner,
    context: TenantContext,
    taskId: string,
    costMicroUsd: number,
  ): Promise<boolean> {
    return this.update(runner, SQL.addTaskCost, [costMicroUsd, context.organizationId, taskId]);
  }

  /** Close a running task with its outcome and the credits it was charged. */
  finishTask(
    runner: TenantQueryRunner,
    context: TenantContext,
    taskId: string,
    status: Exclude<AiTaskStatus, 'running' | 'undone'>,
    chargedCredits: number,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.finishTask, [
      status,
      chargedCredits,
      now,
      context.organizationId,
      taskId,
    ]);
  }

  /** Mark a completed task undone, recording the credits given back (0 past the daily limit). */
  undoTask(
    runner: TenantQueryRunner,
    context: TenantContext,
    taskId: string,
    refundedCredits: number,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.undoTask, [
      refundedCredits,
      now,
      context.organizationId,
      taskId,
    ]);
  }

  async staleRunningTasks(
    runner: TenantQueryRunner,
    context: TenantContext,
    startedAtOrBefore: Date,
    limit: number,
  ): Promise<readonly string[]> {
    const rows = await runner.execute<QueryRows>(SQL.staleTasks, [
      context.organizationId,
      startedAtOrBefore,
      limit,
    ]);
    return rows.map((row) => String(row['id']));
  }

  // ── Calls (the usage ledger) ────────────────────────────────────────────────

  async insertCallHold(
    runner: TenantQueryRunner,
    context: TenantContext,
    hold: NewAiCallHold,
  ): Promise<void> {
    await runner.execute(SQL.insertHold, [
      hold.id,
      context.organizationId,
      hold.taskId,
      hold.membershipId,
      hold.pool,
      hold.poolPeriodStart,
      hold.model,
      hold.priceTableVersion,
      hold.holdMicroUsd,
      hold.holdCredits,
      hold.reservedAt,
      hold.holdExpiresAt,
    ]);
  }

  async findCall(
    runner: TenantQueryRunner,
    context: TenantContext,
    callId: string,
  ): Promise<AiCallRecord | null> {
    const rows = await runner.execute<QueryRows>(SQL.findCall, [context.organizationId, callId]);
    const row = rows[0];
    return row === undefined ? null : asCall(row);
  }

  async taskSpend(
    runner: TenantQueryRunner,
    context: TenantContext,
    taskId: string,
  ): Promise<AiTaskSpend> {
    const rows = await runner.execute<QueryRows>(SQL.taskSpend, [context.organizationId, taskId]);
    const row = rows[0];
    if (row === undefined) return { settledMicroUsd: 0, openHoldMicroUsd: 0, openCalls: 0 };
    return {
      settledMicroUsd: count(row, 'settled'),
      openHoldMicroUsd: count(row, 'open_hold'),
      openCalls: count(row, 'open_calls'),
    };
  }

  markCallSent(
    runner: TenantQueryRunner,
    context: TenantContext,
    callId: string,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.markSent, [now, context.organizationId, callId]);
  }

  settleCall(
    runner: TenantQueryRunner,
    context: TenantContext,
    callId: string,
    settlement: AiCallSettlement,
  ): Promise<boolean> {
    const { usage } = settlement;
    return this.update(runner, SQL.settleCall, [
      settlement.costMicroUsd,
      usage.inputTokens,
      usage.cacheWrite5mTokens,
      usage.cacheWrite1hTokens,
      usage.cacheReadTokens,
      usage.outputTokens,
      settlement.toolCalls,
      settlement.latencyMs,
      settlement.stopReason,
      settlement.providerMessageId,
      settlement.settledAt,
      context.organizationId,
      callId,
    ]);
  }

  releaseCall(
    runner: TenantQueryRunner,
    context: TenantContext,
    callId: string,
    now: Date,
  ): Promise<boolean> {
    return this.update(runner, SQL.releaseCall, [now, context.organizationId, callId]);
  }

  /**
   * Close a lost call whose hold expired: `reserved` (never sent) becomes `expired` with no cost;
   * `sent` (result unknown) becomes `settled` at its full hold. Conditional on the status read and
   * on the expiry, so a call that settled meanwhile is left alone.
   */
  closeLostCall(
    runner: TenantQueryRunner,
    context: TenantContext,
    call: AiCallRecord,
    now: Date,
  ): Promise<boolean> {
    const sent = call.status === 'sent';
    return this.update(runner, SQL.closeLostCall, [
      sent ? 'settled' : 'expired',
      sent ? call.holdMicroUsd : 0,
      sent ? LOST_RESULT_STOP_REASON : null,
      now,
      context.organizationId,
      call.id,
      call.status,
      now,
    ]);
  }

  async lostCalls(
    runner: TenantQueryRunner,
    context: TenantContext,
    now: Date,
    limit: number,
  ): Promise<readonly AiCallRecord[]> {
    const rows = await runner.execute<QueryRows>(SQL.lostCalls, [
      context.organizationId,
      now,
      limit,
    ]);
    return rows.map(asCall);
  }

  /**
   * Which organizations hold a lost call — the expiry sweep's cross-tenant scan, the one read
   * here with no tenant predicate, so it takes a {@link BootstrapQueryRunner} declared over
   * `ai_usage_ledger` (the pattern of `UsageCountersRepository.organizationsWithCounter`).
   */
  async organizationsWithLostCalls(
    runner: BootstrapQueryRunner,
    now: Date,
    limit: number,
  ): Promise<readonly string[]> {
    const rows = await runner.query<QueryRows>(SQL.organizationsWithLostCalls, [now, limit]);
    return rows.map((row) => String(row['organization_id']));
  }
}
