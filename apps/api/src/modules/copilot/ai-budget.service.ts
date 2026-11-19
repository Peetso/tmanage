import { uuidv7 } from '@tmanage/domain';
import {
  SERVICE_PRINCIPAL_ID,
  type TenantContext,
  type TenantDatabase,
  type TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { costOfCall, creditsForMicroUsd, MICRO_USD_PER_CREDIT, type AiUsage } from './ai-cost.js';
import { AI_PRICE_TABLE_VERSION } from './ai-price-table.js';
import type { AiBudgetRepository, AiTaskRecord, IsoDate } from './ai-budget.repository.js';
import {
  AI_CALL_HOLD_TTL_MS,
  AI_TASK_TTL_MS,
  AI_TIER_SPECS,
  choosePool,
  FREE_SUPPORT_PER_MEMBER_PER_DAY,
  poolCapsMicroUsd,
  poolLimitPercentFor,
  REFUNDS_PER_MEMBER_PER_DAY,
  type AiActivity,
  type AiCallerClass,
  type AiPayer,
  type AiSpendingPool,
  type AiSystemJob,
  type AiTier,
} from './ai-tiers.js';

/**
 * The AI budget service (plan 62 §5, slice 62-06, B13): every credit and every micro-USD the in-app
 * AI may spend passes through here, before and after each model call.
 *
 * ## The lifecycle
 *
 * 1. {@link AiBudgetService.openTask}: the server chooses the pool from the caller's class (never
 *    from the request), then holds the tier ceiling on the member and the workspace (workspace-paid
 *    tiers), or counts one free help answer (help tier). The tier — and with it the model — is fixed
 *    here: no silent upgrade.
 * 2. {@link AiBudgetService.reserveCall}: before each model call, a worst-case hold on the pool,
 *    computed here from the prompt size and `max_tokens`, refused when the task would pass its tier
 *    ceiling or the pool its cap (or 80 % of it for Sonnet on the customer pool).
 * 3. {@link AiBudgetService.markSent} once the request leaves the process, then
 *    {@link AiBudgetService.settleCall} with the provider's usage, or
 *    {@link AiBudgetService.releaseCall} when it was never sent.
 * 4. {@link AiBudgetService.finishTask}: completed work is charged its real cost in whole credits,
 *    never above the ceiling; failed, refused and cancelled work is charged 0 (the platform pays).
 * 5. {@link AiBudgetService.refundTask}: an undo gives the credits back, at most 5 a day per member.
 * 6. {@link AiBudgetService.expireLostHolds}: a call whose hold expired is closed — never sent =
 *    released, sent with an unknown result = settled in full — and a task left running is failed.
 *
 * ## Two counters, on purpose
 *
 * The pool always records the real money spent, success or not, so its cap is true. The workspace
 * and member are debited only for successful work that was not undone.
 *
 * ## Self-pause
 *
 * A settlement above its hold is recorded in full and pauses every pool of the period; the result
 * says so (`overSettled`), so the caller can notify the platform admins.
 *
 * Each operation is one transaction. Locks are always taken in the order task → member →
 * workspace → call → pool, so two operations can never wait on each other in a cycle. Not wired to
 * any route yet (62-09 is the orchestrator that calls it). No model is called here.
 */

/** Why the budget said no. Each is a calm state for the member, never an error page. */
export type AiBudgetRefusal =
  | 'caller_not_allowed'
  | 'not_on_test_list'
  | 'free_support_used'
  | 'member_credits_used'
  | 'workspace_credits_used'
  | 'tier_ceiling'
  | 'platform_paused'
  | 'sonnet_unavailable'
  | 'task_not_found'
  | 'task_not_running'
  | 'task_not_completed'
  | 'calls_open'
  | 'call_not_found'
  | 'call_not_reserved'
  | 'call_not_sent';

export type AiBudgetResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: AiBudgetRefusal };

/** A counter that should have moved did not: the ledger and the counters disagree. Rolls back. */
export class AiBudgetInvariantError extends Error {
  override readonly name = 'AiBudgetInvariantError';
}

/** The allowance resolved for this month (plan → support raise → cap; 62-07 resolves it). */
export interface AiCreditAllowance {
  readonly workspaceCredits: number;
  /** The member's share of it (50 % by default, 100 % for a one-person workspace). */
  readonly memberCredits: number;
}

export interface OpenTaskInput {
  readonly tier: AiTier;
  readonly activity: AiActivity;
  readonly allowance: AiCreditAllowance;
  /** Set only by a named platform job running under a service context. */
  readonly systemJob?: AiSystemJob;
}

export interface OpenedTask {
  readonly taskId: string;
  readonly tier: AiTier;
  readonly model: string;
  readonly pool: AiSpendingPool;
  readonly payer: AiPayer;
  readonly ceilingCredits: number;
}

export interface ReserveCallInput {
  readonly taskId: string;
  /** The prompt size from `count_tokens`. */
  readonly promptTokens: number;
  /** The `max_tokens` the request will carry. */
  readonly maxTokens: number;
}

export interface ReservedCall {
  readonly callId: string;
  /** The only model this call may use: the tier's. */
  readonly model: string;
  readonly holdMicroUsd: number;
  readonly holdExpiresAt: Date;
}

export interface SettleCallInput {
  readonly callId: string;
  readonly usage: AiUsage;
  readonly toolCalls: number;
  readonly latencyMs: number | null;
  readonly stopReason: string | null;
  readonly providerMessageId: string | null;
}

export interface SettledCall {
  readonly costMicroUsd: number;
  /** The cost passed the hold: recorded in full, the platform paused itself. */
  readonly overSettled: boolean;
}

export type AiTaskOutcome = 'completed' | 'failed' | 'refused' | 'cancelled';

export interface FinishedTask {
  readonly chargedCredits: number;
  readonly costMicroUsd: number;
}

export interface RefundedTask {
  readonly refundedCredits: number;
  /** The member had already had their refunds for the day: undone, nothing given back. */
  readonly limited: boolean;
}

export interface ExpirySweep {
  readonly releasedCalls: number;
  readonly settledInFull: number;
  readonly failedTasks: number;
}

/** The repository surface the service uses (the class itself, or a fake in unit tests). */
export type AiBudgetStore = { readonly [K in keyof AiBudgetRepository]: AiBudgetRepository[K] };

export interface AiBudgetDeps {
  readonly database: Pick<TenantDatabase, 'transaction'>;
  readonly store: AiBudgetStore;
  /** `platformCapMicroUsd(process.env)` at construction. */
  readonly platformCapMicroUsd: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** The first day of `at`'s month, UTC: the period every counter row belongs to. */
export function periodStartOf(at: Date): IsoDate {
  return `${at.toISOString().slice(0, 7)}-01`;
}

/** `at`'s day, UTC: the key of the per-day limits. */
export function dayOf(at: Date): IsoDate {
  return at.toISOString().slice(0, 10);
}

/**
 * The most one call can cost: every prompt token at the dearest input rate (a 1-hour cache write)
 * and every `max_tokens` token of output, in the band the prompt size selects. Real cost cannot
 * exceed it, so a settlement above it means the provider billed something we did not expect.
 */
export function worstCaseHoldMicroUsd(
  model: string,
  promptTokens: number,
  maxTokens: number,
): number {
  return costOfCall(model, {
    inputTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: promptTokens,
    cacheReadTokens: 0,
    outputTokens: maxTokens,
  }).microUsd;
}

/**
 * The caller's class from the context the guard resolved. An internal member on an ordinary
 * session; a service context with a named job; nothing else. A personal-access-token (MCP) channel,
 * clients, guests and unnamed service work (workers, automations, agents) are refused.
 */
export function callerClassOf(context: TenantContext, systemJob?: AiSystemJob): AiCallerClass {
  if (systemJob !== undefined) {
    return context.principalKind === 'service'
      ? { kind: 'system_job', job: systemJob }
      : { kind: 'refused' };
  }
  if (context.principalKind === 'internal' && context.actorChannel === undefined) {
    return { kind: 'member' };
  }
  return { kind: 'refused' };
}

/**
 * Who pays a stored task. A system job runs under a service context (nil membership) and the help
 * tier is free support; both are platform-paid, exactly as {@link choosePool} decided at open.
 */
function payerOf(task: AiTaskRecord): AiPayer {
  if (task.membershipId === SERVICE_PRINCIPAL_ID) return 'platform';
  return AI_TIER_SPECS[task.tier].payer;
}

/** Thrown inside a transaction to roll back every hold already taken, then returned as a result. */
class Refused extends Error {
  constructor(readonly reason: AiBudgetRefusal) {
    super(reason);
  }
}

const EXPIRY_BATCH = 100;

export class AiBudgetService {
  private readonly database: Pick<TenantDatabase, 'transaction'>;
  private readonly store: AiBudgetStore;
  private readonly poolCaps: ReturnType<typeof poolCapsMicroUsd>;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: AiBudgetDeps) {
    this.database = deps.database;
    this.store = deps.store;
    this.poolCaps = poolCapsMicroUsd(deps.platformCapMicroUsd);
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? uuidv7;
  }

  private async run<T>(
    context: TenantContext,
    work: (tx: TenantQueryRunner, now: Date) => Promise<T>,
  ): Promise<AiBudgetResult<T>> {
    const now = this.now();
    try {
      const value = await this.database.transaction(context, (tx) => work(tx, now));
      return { ok: true, value };
    } catch (error) {
      if (error instanceof Refused) return { ok: false, reason: error.reason };
      throw error;
    }
  }

  private async lockRunningTask(
    tx: TenantQueryRunner,
    context: TenantContext,
    taskId: string,
  ): Promise<AiTaskRecord> {
    const task = await this.store.lockTask(tx, context, taskId);
    if (task === null) throw new Refused('task_not_found');
    if (task.status !== 'running') throw new Refused('task_not_running');
    return task;
  }

  private static must(moved: boolean, what: string): void {
    if (!moved) throw new AiBudgetInvariantError(`ai budget: ${what} did not move`);
  }

  /** Start a task: choose the pool, fix the tier, take the credit hold or count the free answer. */
  openTask(context: TenantContext, input: OpenTaskInput): Promise<AiBudgetResult<OpenedTask>> {
    return this.run(context, async (tx, now) => {
      const caller = callerClassOf(context, input.systemJob);
      if (caller.kind === 'refused') throw new Refused('caller_not_allowed');
      const standing = await this.store.workspaceStanding(tx, context);
      const choice = choosePool(caller, standing, input.tier);
      if (!choice.ok) throw new Refused(choice.reason);

      const spec = AI_TIER_SPECS[input.tier];
      const period = periodStartOf(now);
      const memberId = context.membershipId;

      if (caller.kind === 'member') {
        await this.store.ensureMemberPeriod(tx, context, {
          id: this.newId(),
          membershipId: memberId,
          periodStart: period,
          capCredits: input.allowance.memberCredits,
          now,
        });
      }
      if (choice.payer === 'workspace') {
        await this.store.ensureWorkspacePeriod(tx, context, {
          id: this.newId(),
          periodStart: period,
          allowanceCredits: input.allowance.workspaceCredits,
          now,
        });
        const ceiling = spec.ceilingCredits;
        if (!(await this.store.holdMemberCredits(tx, context, memberId, period, ceiling, now))) {
          throw new Refused('member_credits_used');
        }
        if (!(await this.store.holdWorkspaceCredits(tx, context, period, ceiling, now))) {
          throw new Refused('workspace_credits_used');
        }
      } else if (caller.kind === 'member') {
        const counted = await this.store.countFreeSupport(
          tx,
          context,
          memberId,
          period,
          dayOf(now),
          FREE_SUPPORT_PER_MEMBER_PER_DAY,
          now,
        );
        if (!counted) throw new Refused('free_support_used');
      }

      const taskId = this.newId();
      await this.store.insertTask(tx, context, {
        id: taskId,
        membershipId: memberId,
        tier: input.tier,
        activity: input.activity,
        pool: choice.pool,
        ceilingCredits: spec.ceilingCredits,
        startedAt: now,
      });
      return {
        taskId,
        tier: input.tier,
        model: spec.model,
        pool: choice.pool,
        payer: choice.payer,
        ceilingCredits: spec.ceilingCredits,
      };
    });
  }

  /** Hold the worst case of one call on the pool, within the task's tier ceiling. */
  reserveCall(
    context: TenantContext,
    input: ReserveCallInput,
  ): Promise<AiBudgetResult<ReservedCall>> {
    return this.run(context, async (tx, now) => {
      const task = await this.lockRunningTask(tx, context, input.taskId);
      const spec = AI_TIER_SPECS[task.tier];
      const holdMicroUsd = worstCaseHoldMicroUsd(spec.model, input.promptTokens, input.maxTokens);

      const spend = await this.store.taskSpend(tx, context, task.id);
      const ceilingMicroUsd = spec.ceilingCredits * MICRO_USD_PER_CREDIT;
      if (spend.settledMicroUsd + spend.openHoldMicroUsd + holdMicroUsd > ceilingMicroUsd) {
        throw new Refused('tier_ceiling');
      }

      const period = periodStartOf(now);
      await this.store.ensurePoolPeriod(tx, {
        id: this.newId(),
        pool: task.pool,
        periodStart: period,
        capMicroUsd: this.poolCaps[task.pool],
        now,
      });
      const limitPercent = poolLimitPercentFor(task.pool, spec.model);
      if (!(await this.store.holdPool(tx, task.pool, period, holdMicroUsd, limitPercent, now))) {
        const state = await this.store.poolState(tx, task.pool, period);
        const fitsWholeCap =
          state !== null &&
          !state.paused &&
          state.settledMicroUsd + state.reservedMicroUsd + holdMicroUsd <= state.capMicroUsd;
        throw new Refused(
          limitPercent < 100 && fitsWholeCap ? 'sonnet_unavailable' : 'platform_paused',
        );
      }

      const callId = this.newId();
      const holdExpiresAt = new Date(now.getTime() + AI_CALL_HOLD_TTL_MS);
      await this.store.insertCallHold(tx, context, {
        id: callId,
        taskId: task.id,
        membershipId: task.membershipId,
        pool: task.pool,
        poolPeriodStart: period,
        model: spec.model,
        priceTableVersion: AI_PRICE_TABLE_VERSION,
        holdMicroUsd,
        holdCredits: creditsForMicroUsd(holdMicroUsd),
        reservedAt: now,
        holdExpiresAt,
      });
      return { callId, model: spec.model, holdMicroUsd, holdExpiresAt };
    });
  }

  /** The request left the process: from here a lost result settles in full. */
  markSent(context: TenantContext, callId: string): Promise<AiBudgetResult<null>> {
    return this.run(context, async (tx, now) => {
      if (!(await this.store.markCallSent(tx, context, callId, now))) {
        throw new Refused('call_not_reserved');
      }
      return null;
    });
  }

  /** Record the real cost of a sent call from the provider's usage and release its hold. */
  settleCall(context: TenantContext, input: SettleCallInput): Promise<AiBudgetResult<SettledCall>> {
    return this.run(context, async (tx, now) => {
      const call = await this.store.findCall(tx, context, input.callId);
      if (call === null) throw new Refused('call_not_found');
      const task = await this.lockRunningTask(tx, context, call.taskId);

      const { microUsd: costMicroUsd } = costOfCall(call.model, input.usage);
      const settled = await this.store.settleCall(tx, context, call.id, {
        costMicroUsd,
        usage: input.usage,
        toolCalls: input.toolCalls,
        latencyMs: input.latencyMs,
        stopReason: input.stopReason,
        providerMessageId: input.providerMessageId,
        settledAt: now,
      });
      if (!settled) throw new Refused('call_not_sent');

      AiBudgetService.must(
        await this.store.settlePool(
          tx,
          call.pool,
          call.poolPeriodStart,
          call.holdMicroUsd,
          costMicroUsd,
          now,
        ),
        'pool settlement',
      );
      AiBudgetService.must(
        await this.store.addTaskCost(tx, context, task.id, costMicroUsd),
        'task cost',
      );

      const overSettled = costMicroUsd > call.holdMicroUsd;
      if (overSettled) {
        await this.store.pausePlatform(tx, call.poolPeriodStart, 'over_settlement', now);
      }
      return { costMicroUsd, overSettled };
    });
  }

  /** The call was never sent: release its hold, no cost. */
  releaseCall(context: TenantContext, callId: string): Promise<AiBudgetResult<null>> {
    return this.run(context, async (tx, now) => {
      const call = await this.store.findCall(tx, context, callId);
      if (call === null) throw new Refused('call_not_found');
      await this.store.lockTask(tx, context, call.taskId);
      if (!(await this.store.releaseCall(tx, context, call.id, now))) {
        throw new Refused('call_not_reserved');
      }
      AiBudgetService.must(
        await this.store.settlePool(tx, call.pool, call.poolPeriodStart, call.holdMicroUsd, 0, now),
        'pool release',
      );
      return null;
    });
  }

  /** Close a task: charge completed work its real cost (never above the ceiling), anything else 0. */
  finishTask(
    context: TenantContext,
    taskId: string,
    outcome: AiTaskOutcome,
  ): Promise<AiBudgetResult<FinishedTask>> {
    return this.run(context, (tx, now) => this.finishLocked(tx, context, taskId, outcome, now));
  }

  private async finishLocked(
    tx: TenantQueryRunner,
    context: TenantContext,
    taskId: string,
    outcome: AiTaskOutcome,
    now: Date,
  ): Promise<FinishedTask> {
    const task = await this.lockRunningTask(tx, context, taskId);
    const spend = await this.store.taskSpend(tx, context, task.id);
    if (spend.openCalls > 0) throw new Refused('calls_open');

    const payer = payerOf(task);
    const chargedCredits =
      outcome === 'completed' && payer === 'workspace'
        ? Math.min(creditsForMicroUsd(task.costMicroUsd), task.ceilingCredits)
        : 0;
    AiBudgetService.must(
      await this.store.finishTask(tx, context, task.id, outcome, chargedCredits, now),
      'task status',
    );
    if (payer === 'workspace') {
      const period = periodStartOf(task.startedAt);
      const held = task.ceilingCredits;
      AiBudgetService.must(
        await this.store.closeMemberHold(
          tx,
          context,
          task.membershipId,
          period,
          held,
          chargedCredits,
          now,
        ),
        'member hold',
      );
      AiBudgetService.must(
        await this.store.closeWorkspaceHold(tx, context, period, held, chargedCredits, now),
        'workspace hold',
      );
    }
    return { chargedCredits, costMicroUsd: task.costMicroUsd };
  }

  /**
   * An undo: the task becomes `undone` and its credits go back to the member and the workspace — at
   * most {@link REFUNDS_PER_MEMBER_PER_DAY} a day per member, and only within the month it was
   * charged (allowances reset monthly, nothing rolls over). Past either, the undo stands and
   * nothing is given back. The pool keeps the real cost either way.
   */
  refundTask(context: TenantContext, taskId: string): Promise<AiBudgetResult<RefundedTask>> {
    return this.run(context, async (tx, now) => {
      const task = await this.store.lockTask(tx, context, taskId);
      if (task === null) throw new Refused('task_not_found');
      if (task.status !== 'completed') throw new Refused('task_not_completed');

      const period = periodStartOf(task.startedAt);
      const refundable = task.chargedCredits > 0 && period === periodStartOf(now);
      const counted =
        refundable &&
        (await this.store.countRefund(
          tx,
          context,
          task.membershipId,
          period,
          dayOf(now),
          REFUNDS_PER_MEMBER_PER_DAY,
          now,
        ));
      const refundedCredits = counted ? task.chargedCredits : 0;
      if (refundedCredits > 0) {
        AiBudgetService.must(
          await this.store.refundMemberCredits(
            tx,
            context,
            task.membershipId,
            period,
            refundedCredits,
            now,
          ),
          'member refund',
        );
        AiBudgetService.must(
          await this.store.refundWorkspaceCredits(tx, context, period, refundedCredits, now),
          'workspace refund',
        );
      }
      AiBudgetService.must(
        await this.store.undoTask(tx, context, task.id, refundedCredits, now),
        'task undo',
      );
      return { refundedCredits, limited: refundable && !counted };
    });
  }

  /**
   * Close the organization's lost calls and stale tasks. A call never sent is released; a call
   * sent whose result never arrived is settled at its full hold (the provider may have billed it).
   * A task still running {@link AI_TASK_TTL_MS} after it started, with no call open, is failed: the
   * platform pays and the credit hold is released. One transaction per row, each re-checked under
   * its lock, so a call that settled meanwhile is left alone. Run by the hold-expiry sweep.
   */
  async expireLostHolds(context: TenantContext): Promise<ExpirySweep> {
    let releasedCalls = 0;
    let settledInFull = 0;
    let failedTasks = 0;
    const now = this.now();

    const lost = await this.database.transaction(context, (tx) =>
      this.store.lostCalls(tx, context, now, EXPIRY_BATCH),
    );
    for (const call of lost) {
      const closed = await this.database.transaction(context, async (tx) => {
        await this.store.lockTask(tx, context, call.taskId);
        if (!(await this.store.closeLostCall(tx, context, call, now))) return false;
        const cost = call.status === 'sent' ? call.holdMicroUsd : 0;
        AiBudgetService.must(
          await this.store.settlePool(
            tx,
            call.pool,
            call.poolPeriodStart,
            call.holdMicroUsd,
            cost,
            now,
          ),
          'pool on expiry',
        );
        if (cost > 0) {
          AiBudgetService.must(
            await this.store.addTaskCost(tx, context, call.taskId, cost),
            'task cost',
          );
        }
        return true;
      });
      if (closed && call.status === 'sent') settledInFull += 1;
      else if (closed) releasedCalls += 1;
    }

    const staleBefore = new Date(now.getTime() - AI_TASK_TTL_MS);
    const stale = await this.database.transaction(context, (tx) =>
      this.store.staleRunningTasks(tx, context, staleBefore, EXPIRY_BATCH),
    );
    for (const taskId of stale) {
      const result = await this.run(context, (tx) =>
        this.finishLocked(tx, context, taskId, 'failed', now),
      );
      if (result.ok) failedTasks += 1;
    }
    return { releasedCalls, settledInFull, failedTasks };
  }
}
