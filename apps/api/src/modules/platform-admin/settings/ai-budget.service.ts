import { ApiError } from '../../../common/http/errors.js';
import type {
  IdentityQueryRunner,
  TenantDatabase,
} from '../../../common/database/tenant-context.js';
import { periodStartOf } from '../../copilot/ai-budget.service.js';
import {
  AI_POOL_ADMIN_TABLES,
  AiPoolAdminRepository,
  type AiPoolRow,
} from '../../copilot/ai-pool-admin.repository.js';
import { platformCapMicroUsd, type AiPool } from '../../copilot/ai-tiers.js';
import { PLATFORM_STEP_UP_MINUTES, requireReason } from '../platform-admin.access.js';
import type { PlatformRequestContext } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAuditInput, PlatformStepUp } from '../platform-admin.repository.js';
import { insertPlatformAudit, platformAuditFor } from '../platform-audit.service.js';
import {
  AI_ADMIN_POOLS,
  AI_BUDGET_SETTING,
  aiBudgetRecord,
  aiBudgetSettingsOf,
  parseAiBudgetBody,
  parseReserveRelease,
  parseStoredAiBudget,
  serializeAiBudget,
  type AiBudgetApplyTo,
  type AiBudgetConfig,
} from './ai-budget.js';
import { SETTINGS_SQL, type PlatformSettingsRepository } from './settings.repository.js';

/**
 * 62-08 (plan 62 §5) — Platform settings → AI budget: read the caps, the switches and this
 * month's pools; set the caps (this month or from next month) and the Sonnet switch; pause and
 * resume; release the reserve into another pool. Every change is one identity transaction that
 * writes the `ai_budget` setting and/or the pool rows and its one platform audit row (DA-11), and
 * every change needs a typed reason. The reserve release also needs a step-up confirmed within
 * {@link AI_RESERVE_STEP_UP_FRESH_MINUTES} (SE-3: the guard proves a live step-up; money out of
 * the reserve asks for a recent one, like entering Support mode does).
 *
 * Lowering a cap below what a pool already settled and holds pauses that pool at once, in the same
 * transaction (`cap_lowered`); a resume only clears pools that fit their cap again.
 */

/** How recent the platform admin's step-up must be to release the reserve. */
export const AI_RESERVE_STEP_UP_FRESH_MINUTES = 15;

export const AI_BUDGET_AUDIT_ACTIONS = {
  updated: 'platform.ai_budget_updated',
  paused: 'platform.ai_paused',
  resumed: 'platform.ai_resumed',
  reserveReleased: 'platform.ai_reserve_released',
} as const;

/** One pool of the current month, for the page. */
export interface AiBudgetPoolView {
  readonly pool: AiPool;
  readonly capMicroUsd: number;
  readonly settledMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly remainingMicroUsd: number;
  readonly paused: boolean;
  readonly pausedReason: string | null;
}

/** `GET/PUT /v1/platform/settings/ai-budget` and its actions — no web client yet (62-19). */
export interface AiBudgetView {
  /** `AI_PLATFORM_CAP_MAX_USD` in micro-USD: the three caps together never pass it. */
  readonly ceilingMicroUsd: number;
  readonly capsMicroUsd: Readonly<Record<'customers' | 'testing' | 'reserve', number>>;
  readonly sonnetEnabled: boolean;
  readonly paused: boolean;
  /** The current month (`YYYY-MM-01`) the pools below belong to. */
  readonly periodStart: string;
  /** This month's pool rows; a pool not used yet this month is absent. */
  readonly pools: readonly AiBudgetPoolView[];
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface AiBudgetServiceDeps {
  readonly database: Pick<TenantDatabase, 'identityRead' | 'identityTransaction'>;
  readonly store: Pick<PlatformSettingsRepository, 'readAll'>;
  readonly pools?: AiPoolAdminRepository;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly stepUpWindowMinutes?: number;
}

/**
 * 403 `reauthentication_required` unless the step-up was confirmed within the last
 * {@link AI_RESERVE_STEP_UP_FRESH_MINUTES}. A step-up lasts `windowMinutes` from its
 * confirmation, so its confirmation time is its expiry minus that window.
 */
export function requireFreshStepUp(
  stepUp: PlatformStepUp | null,
  now: Date,
  windowMinutes: number = PLATFORM_STEP_UP_MINUTES,
): void {
  const fresh =
    stepUp !== null &&
    stepUp.expiresAt.getTime() > now.getTime() &&
    now.getTime() - (stepUp.expiresAt.getTime() - windowMinutes * 60_000) <=
      AI_RESERVE_STEP_UP_FRESH_MINUTES * 60_000;
  if (!fresh) {
    throw new ApiError(
      403,
      'reauthentication_required',
      'Confirm your password again to release the reserve.',
      undefined,
      'ai_reserve_step_up_stale',
    );
  }
}

function poolView(row: AiPoolRow): AiBudgetPoolView {
  return {
    pool: row.pool,
    capMicroUsd: row.capMicroUsd,
    settledMicroUsd: row.settledMicroUsd,
    reservedMicroUsd: row.reservedMicroUsd,
    remainingMicroUsd: Math.max(0, row.capMicroUsd - row.settledMicroUsd - row.reservedMicroUsd),
    paused: row.pausedAt !== null,
    pausedReason: row.pausedReason,
  };
}

export class AiBudgetSettingsService {
  private readonly database: AiBudgetServiceDeps['database'];
  private readonly store: AiBudgetServiceDeps['store'];
  private readonly pools: AiPoolAdminRepository;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly now: () => Date;
  private readonly stepUpWindowMinutes: number;

  constructor(deps: AiBudgetServiceDeps) {
    this.database = deps.database;
    this.store = deps.store;
    this.pools = deps.pools ?? new AiPoolAdminRepository();
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => new Date());
    this.stepUpWindowMinutes = deps.stepUpWindowMinutes ?? PLATFORM_STEP_UP_MINUTES;
  }

  private ceiling(): number {
    return platformCapMicroUsd(this.env);
  }

  private async config(context: PlatformRequestContext): Promise<{
    config: AiBudgetConfig;
    updatedAt: Date | null;
    updatedBy: string | null;
  }> {
    const stored = (await this.store.readAll(context.correlationId)).get(AI_BUDGET_SETTING);
    return {
      config: parseStoredAiBudget(stored?.value, this.ceiling()),
      updatedAt: stored?.updatedAt ?? null,
      updatedBy: stored?.updatedBy ?? null,
    };
  }

  async read(context: PlatformRequestContext): Promise<AiBudgetView> {
    const { config, updatedAt, updatedBy } = await this.config(context);
    const periodStart = periodStartOf(this.now());
    const rows = await this.database.identityRead(
      { correlationId: context.correlationId, tables: ['ai_budget_pools'] },
      (db) => this.pools.readPeriod(db, periodStart),
    );
    return {
      ceilingMicroUsd: this.ceiling(),
      capsMicroUsd: config.capsMicroUsd,
      sonnetEnabled: config.sonnetEnabled,
      paused: config.paused,
      periodStart,
      pools: rows.map(poolView),
      updatedAt: updatedAt?.toISOString() ?? null,
      updatedBy,
    };
  }

  /**
   * Write the setting, then (inside the same transaction) the pool rows the change reaches, then
   * the audit row built from what happened.
   */
  private async change(
    actor: PlatformAdminActor,
    context: PlatformRequestContext,
    next: AiBudgetConfig | null,
    work: (
      tx: IdentityQueryRunner,
      periodStart: string,
      now: Date,
    ) => Promise<Omit<PlatformAuditInput, 'actorUserId' | 'actorEmail' | 'correlationId'>>,
  ): Promise<AiBudgetView> {
    const now = this.now();
    const periodStart = periodStartOf(now);
    await this.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...AI_POOL_ADMIN_TABLES] },
      async (tx) => {
        if (next !== null) {
          await tx.query(SETTINGS_SQL.write, [
            AI_BUDGET_SETTING,
            serializeAiBudget(next),
            actor.account.userId,
          ]);
        }
        const audit = await work(tx, periodStart, now);
        await insertPlatformAudit(tx, platformAuditFor(actor, context, audit));
      },
    );
    return this.read(context);
  }

  /** Caps (≤ the ceiling, else 400 `ai_cap_above_ceiling`) and the Sonnet switch. */
  async update(
    actor: PlatformAdminActor,
    body: Readonly<Record<string, unknown>> | null,
    context: PlatformRequestContext,
  ): Promise<AiBudgetView> {
    const ceiling = this.ceiling();
    const update = parseAiBudgetBody(body, ceiling);
    const reason = requireReason(body?.['reason']);
    const { config: before } = await this.config(context);
    const next: AiBudgetConfig = { ...before, ...update };
    return this.change(actor, context, next, async (tx, periodStart, now) => {
      const pausedNow = await this.applyCaps(tx, update.applyTo, next, periodStart, now, ceiling);
      return {
        action: AI_BUDGET_AUDIT_ACTIONS.updated,
        targetType: 'setting',
        targetId: null,
        targetLabel: AI_BUDGET_SETTING,
        reason,
        beforeJson: serializeAiBudget(before),
        afterJson: JSON.stringify({ ...aiBudgetRecord(next), applyTo: update.applyTo, pausedNow }),
      };
    });
  }

  /**
   * `this_month`: this month's rows take the new caps now, and a pool left below what it already
   * settled and holds is paused at once. `next_month`: the rows of this month keep their caps; the
   * next month's rows are created from the setting.
   */
  private async applyCaps(
    tx: IdentityQueryRunner,
    applyTo: AiBudgetApplyTo,
    config: AiBudgetConfig,
    periodStart: string,
    now: Date,
    ceiling: number,
  ): Promise<AiPool[]> {
    if (applyTo === 'next_month') return [];
    const caps = aiBudgetSettingsOf(config, ceiling).poolCapsMicroUsd;
    await this.pools.ensurePeriod(tx, periodStart, caps, now);
    await this.pools.lockPeriod(tx, periodStart);
    const pausedNow: AiPool[] = [];
    for (const pool of AI_ADMIN_POOLS) {
      if (await this.pools.setCap(tx, pool, periodStart, caps[pool], now)) pausedNow.push(pool);
    }
    return pausedNow;
  }

  /** Stop every model call now and until resumed (also next month's rows). */
  async pause(
    actor: PlatformAdminActor,
    body: Readonly<Record<string, unknown>> | null,
    context: PlatformRequestContext,
  ): Promise<AiBudgetView> {
    const reason = requireReason(body?.['reason']);
    const ceiling = this.ceiling();
    const { config: before } = await this.config(context);
    const next: AiBudgetConfig = { ...before, paused: true };
    return this.change(actor, context, next, async (tx, periodStart, now) => {
      await this.pools.ensurePeriod(
        tx,
        periodStart,
        aiBudgetSettingsOf(before, ceiling).poolCapsMicroUsd,
        now,
      );
      await this.pools.lockPeriod(tx, periodStart);
      const paused = await this.pools.pauseAll(tx, periodStart, now);
      return {
        action: AI_BUDGET_AUDIT_ACTIONS.paused,
        targetType: 'platform',
        targetId: null,
        targetLabel: 'ai',
        reason,
        beforeJson: JSON.stringify({ paused: before.paused }),
        afterJson: JSON.stringify({ paused: true, poolsPausedNow: paused }),
      };
    });
  }

  /** Lift the standing pause; a pool still above its cap stays paused (the view shows which). */
  async resume(
    actor: PlatformAdminActor,
    body: Readonly<Record<string, unknown>> | null,
    context: PlatformRequestContext,
  ): Promise<AiBudgetView> {
    const reason = requireReason(body?.['reason']);
    const { config: before } = await this.config(context);
    const next: AiBudgetConfig = { ...before, paused: false };
    return this.change(actor, context, next, async (tx, periodStart, now) => {
      await this.pools.lockPeriod(tx, periodStart);
      const resumed = await this.pools.resumeFitting(tx, periodStart, now);
      const stillPaused = (await this.pools.readPeriod(tx, periodStart))
        .filter((row) => row.pausedAt !== null)
        .map((row) => row.pool);
      return {
        action: AI_BUDGET_AUDIT_ACTIONS.resumed,
        targetType: 'platform',
        targetId: null,
        targetLabel: 'ai',
        reason,
        beforeJson: JSON.stringify({ paused: before.paused }),
        afterJson: JSON.stringify({ paused: false, poolsResumed: resumed, stillPaused }),
      };
    });
  }

  /**
   * Move part of this month's reserve into the customers or testing pool. Step-up confirmed in
   * the last 15 minutes (403 otherwise), a reason, and a reserve that still has it (409
   * `ai_reserve_short`). The ceiling holds: the sum of the caps does not change.
   */
  async releaseReserve(
    actor: PlatformAdminActor,
    body: Readonly<Record<string, unknown>> | null,
    context: PlatformRequestContext,
  ): Promise<AiBudgetView> {
    requireFreshStepUp(actor.stepUp, this.now(), this.stepUpWindowMinutes);
    const ceiling = this.ceiling();
    const release = parseReserveRelease(body, ceiling);
    const reason = requireReason(body?.['reason']);
    const { config } = await this.config(context);
    return this.change(actor, context, null, async (tx, periodStart, now) => {
      await this.pools.ensurePeriod(
        tx,
        periodStart,
        aiBudgetSettingsOf(config, ceiling).poolCapsMicroUsd,
        now,
      );
      const before = await this.pools.lockPeriod(tx, periodStart);
      if (!(await this.pools.releaseReserve(tx, release.to, periodStart, release.microUsd, now))) {
        throw new ApiError(
          409,
          'conflict',
          'The reserve does not hold that much this month.',
          undefined,
          'ai_reserve_short',
        );
      }
      const caps = (rows: readonly AiPoolRow[]) =>
        Object.fromEntries(rows.map((row) => [row.pool, row.capMicroUsd]));
      return {
        action: AI_BUDGET_AUDIT_ACTIONS.reserveReleased,
        targetType: 'platform',
        targetId: null,
        targetLabel: `reserve→${release.to}`,
        reason,
        beforeJson: JSON.stringify({ periodStart, caps: caps(before) }),
        afterJson: JSON.stringify({
          periodStart,
          to: release.to,
          microUsd: release.microUsd,
          caps: caps(await this.pools.readPeriod(tx, periodStart)),
        }),
      };
    });
  }
}
