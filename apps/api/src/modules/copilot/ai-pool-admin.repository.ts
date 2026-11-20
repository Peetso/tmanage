import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { uuidv7 } from '@tmanage/domain';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';
import type { IsoDate } from './ai-budget.repository.js';
import { AI_POOLS, type AiPool } from './ai-tiers.js';

/**
 * 62-08 (plan 62 §5) — the platform admin's statements on `ai_budget_pools`. The table belongs to
 * the copilot budget (AR-7: one owning context per table), so its admin writes live here, beside
 * `ai-budget.repository.ts`, and the platform settings service calls them inside its own identity
 * transaction with the platform audit row (DA-11).
 *
 * Every write keeps the budget invariant `settled + reserved <= cap` honest: a cap is only ever
 * set, never derived; a pool whose new cap is below what it already settled and holds is paused
 * in the same transaction (`cap_lowered`); a resume only clears a pool that fits its cap; the
 * reserve gives away only what it has not spent or held (a conditional UPDATE, DA-1). Rows are
 * locked in pool order, the order every other writer here uses, so two admins never deadlock.
 */

/** The global tables one admin unit of work touches (identity path, `NON_TENANT_TABLES`). */
export const AI_POOL_ADMIN_TABLES = [
  'ai_budget_pools',
  'platform_settings',
  'platform_admin_audit_events',
] as const;

/** Why an admin action paused a pool (`ai_budget_pools.paused_reason`, VARCHAR(32)). */
export type AiAdminPauseReason = 'admin' | 'cap_lowered';

export interface AiPoolRow {
  readonly pool: AiPool;
  readonly capMicroUsd: number;
  readonly settledMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly pausedAt: Date | null;
  readonly pausedReason: string | null;
}

export const AI_POOL_ADMIN_SQL = {
  ensure: `insert into ai_budget_pools
    (id, pool, period_start, cap_micro_usd, settled_micro_usd, reserved_micro_usd, created_at, updated_at)
    values (?, ?, ?, ?, 0, 0, ?, ?)
    on duplicate key update id = id`,
  lockPeriod: `select pool, cap_micro_usd, settled_micro_usd, reserved_micro_usd, paused_at, paused_reason
    from ai_budget_pools where period_start = ? order by pool for update`,
  readPeriod: `select pool, cap_micro_usd, settled_micro_usd, reserved_micro_usd, paused_at, paused_reason
    from ai_budget_pools where period_start = ? order by pool`,
  setCap: `update ai_budget_pools set cap_micro_usd = ?, updated_at = ?
    where pool = ? and period_start = ?`,
  pauseOverCap: `update ai_budget_pools set paused_at = ?, paused_reason = 'cap_lowered', updated_at = ?
    where pool = ? and period_start = ? and paused_at is null
      and settled_micro_usd + reserved_micro_usd > cap_micro_usd`,
  pauseAll: `update ai_budget_pools set paused_at = ?, paused_reason = 'admin', updated_at = ?
    where period_start = ? and paused_at is null`,
  resumeFitting: `update ai_budget_pools set paused_at = null, paused_reason = null, updated_at = ?
    where period_start = ? and paused_at is not null
      and settled_micro_usd + reserved_micro_usd <= cap_micro_usd`,
  takeFromReserve: `update ai_budget_pools set cap_micro_usd = cap_micro_usd - ?, updated_at = ?
    where pool = 'reserve' and period_start = ?
      and cap_micro_usd >= settled_micro_usd + reserved_micro_usd + ?`,
  addToPool: `update ai_budget_pools set cap_micro_usd = cap_micro_usd + ?, updated_at = ?
    where pool = ? and period_start = ? and pool <> 'reserve'`,
} as const;

type Row = RowDataPacket & Record<string, unknown>;

const num = (value: unknown): number => Number(value ?? 0);

function changed(result: unknown): number {
  return num((result as Partial<ResultSetHeader> | undefined)?.affectedRows);
}

function poolRow(row: Row): AiPoolRow {
  return {
    pool: row['pool'] as AiPool,
    capMicroUsd: num(row['cap_micro_usd']),
    settledMicroUsd: num(row['settled_micro_usd']),
    reservedMicroUsd: num(row['reserved_micro_usd']),
    pausedAt: row['paused_at'] instanceof Date ? row['paused_at'] : null,
    pausedReason: typeof row['paused_reason'] === 'string' ? row['paused_reason'] : null,
  };
}

export class AiPoolAdminRepository {
  constructor(private readonly newId: () => string = uuidv7) {}

  /** Create the period's missing pool rows with `caps` (an existing row keeps its cap). */
  async ensurePeriod(
    tx: IdentityQueryRunner,
    periodStart: IsoDate,
    caps: Readonly<Record<AiPool, number>>,
    now: Date,
  ): Promise<void> {
    for (const pool of AI_POOLS) {
      await tx.query(AI_POOL_ADMIN_SQL.ensure, [
        this.newId(),
        pool,
        periodStart,
        caps[pool],
        now,
        now,
      ]);
    }
  }

  /** The period's pool rows under their row locks, in pool order. Inside a transaction. */
  async lockPeriod(tx: IdentityQueryRunner, periodStart: IsoDate): Promise<AiPoolRow[]> {
    const rows = await tx.query<Row[]>(AI_POOL_ADMIN_SQL.lockPeriod, [periodStart]);
    return rows.map(poolRow);
  }

  async readPeriod(tx: IdentityQueryRunner, periodStart: IsoDate): Promise<AiPoolRow[]> {
    const rows = await tx.query<Row[]>(AI_POOL_ADMIN_SQL.readPeriod, [periodStart]);
    return rows.map(poolRow);
  }

  /**
   * Set one pool's cap for the period; when the new cap is below what the pool already settled
   * and holds, pause it in the same statement batch. Returns whether it was paused now.
   */
  async setCap(
    tx: IdentityQueryRunner,
    pool: AiPool,
    periodStart: IsoDate,
    capMicroUsd: number,
    now: Date,
  ): Promise<boolean> {
    await tx.query(AI_POOL_ADMIN_SQL.setCap, [capMicroUsd, now, pool, periodStart]);
    return (
      changed(await tx.query(AI_POOL_ADMIN_SQL.pauseOverCap, [now, now, pool, periodStart])) > 0
    );
  }

  /** Pause every running pool of the period. Returns how many were paused now. */
  async pauseAll(tx: IdentityQueryRunner, periodStart: IsoDate, now: Date): Promise<number> {
    return changed(await tx.query(AI_POOL_ADMIN_SQL.pauseAll, [now, now, periodStart]));
  }

  /** Resume every paused pool that fits its cap; one over its cap stays paused. */
  async resumeFitting(tx: IdentityQueryRunner, periodStart: IsoDate, now: Date): Promise<number> {
    return changed(await tx.query(AI_POOL_ADMIN_SQL.resumeFitting, [now, periodStart]));
  }

  /**
   * Move `microUsd` of this period's reserve cap into `to`. The reserve only gives what it has not
   * settled or held; `false` (nothing moved) when it cannot.
   */
  async releaseReserve(
    tx: IdentityQueryRunner,
    to: Exclude<AiPool, 'reserve'>,
    periodStart: IsoDate,
    microUsd: number,
    now: Date,
  ): Promise<boolean> {
    const taken = changed(
      await tx.query(AI_POOL_ADMIN_SQL.takeFromReserve, [microUsd, now, periodStart, microUsd]),
    );
    if (taken !== 1) return false;
    const added = changed(
      await tx.query(AI_POOL_ADMIN_SQL.addToPool, [microUsd, now, to, periodStart]),
    );
    if (added !== 1) throw new Error(`ai pool ${to} has no row for ${periodStart}`);
    return true;
  }
}
