import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { periodStartOf, type AiCreditAllowance } from '../copilot/ai-budget.service.js';
import { platformCapMicroUsd, poolCapsMicroUsd } from '../copilot/ai-tiers.js';
import { aiAllowanceOf, creditsOfMicroUsd, memberShareCredits } from './ai-allowance.js';
import type { AiAllowanceSource } from './ai-allowance.js';
import { AiAllowanceRepository } from './ai-allowance.repository.js';
import { packBalance } from './ai-packs.js';
import type { LivePack } from './ai-packs.js';
import { AiPacksRepository } from './ai-packs.repository.js';
import type { AiPoolClass, AiWorkspacePlatformSettings, PeriodRow } from './ai-packs.repository.js';
import { billingMode, entitlementsFor } from './billing-mode.js';
import type { BillingMode } from './billing-mode.js';
import { readPlanId } from './plan-catalog.js';
import { SubscriptionRepository } from './subscription.repository.js';

/** The monthly cap of the pool a workspace draws from, in micro-USD (62-08 settings, else env). */
export type PoolCapReader = (pool: AiPoolClass) => Promise<number>;

/** The env shares of `AI_PLATFORM_CAP_MAX_USD` (62-06): the cap source until 62-08 is wired. */
export function envPoolCapReader(env: NodeJS.ProcessEnv = process.env): PoolCapReader {
  const caps = poolCapsMicroUsd(platformCapMicroUsd(env));
  return async (pool) => caps[pool];
}

/** Everything the owner's credit read and the budget's `openTask` need, resolved once. */
export interface AiWorkspaceAllowance {
  readonly settings: AiWorkspacePlatformSettings;
  readonly periodStart: string;
  readonly allowanceCredits: number;
  readonly limitedBy: AiAllowanceSource;
  readonly raisedBySupport: boolean;
  /** This month's period row (null before the first AI task of the month). */
  readonly period: PeriodRow | null;
  readonly livePacks: readonly LivePack[];
  /** Credits the live packs still hold (not yet moved into a period). */
  readonly packBalanceCredits: number;
  /** What one member may hold this month: their share of allowance + pack credits. */
  readonly memberCredits: number;
}

/**
 * What the workspace can spend this month: the allowance, the pack credits already moved into the
 * month and what the live packs still hold. The one formula the member share is taken of (AR-8);
 * 62-17's share preview uses it too.
 */
export function spendableCreditsOf(
  resolved: Pick<AiWorkspaceAllowance, 'allowanceCredits' | 'period' | 'packBalanceCredits'>,
): number {
  return (
    resolved.allowanceCredits + (resolved.period?.packCredits ?? 0) + resolved.packBalanceCredits
  );
}

export interface AiAllowanceDeps {
  readonly database: Pick<TenantDatabase, 'read'>;
  readonly poolCapMicroUsd?: PoolCapReader;
  readonly subscriptions?: Pick<SubscriptionRepository, 'find' | 'countInternalPeople'>;
  readonly raises?: Pick<AiAllowanceRepository, 'findRaiseCredits'>;
  readonly packs?: Pick<AiPacksRepository, 'settings' | 'readPeriod' | 'livePacks'>;
  readonly mode?: () => BillingMode;
  readonly now?: () => Date;
}

/**
 * 62-07 (plan 62 §5). The ONE place a workspace's monthly AI credits are resolved (AR-8): plan
 * figure → support raise → the pool cap (`ai-allowance.ts`), then the member share of allowance and
 * packs. The plan comes from `entitlementsFor` like every other limit (the top plan in the free
 * beta, whose "by agreement" figure is the per-workspace target). The caller of the budget's
 * `openTask` passes {@link forBudget}'s answer; the owner's credit read shows {@link resolveWith}'s.
 */
export class AiAllowanceService {
  private readonly database: Pick<TenantDatabase, 'read'>;
  private readonly poolCapMicroUsd: PoolCapReader;
  private readonly subscriptions: Pick<SubscriptionRepository, 'find' | 'countInternalPeople'>;
  private readonly raises: Pick<AiAllowanceRepository, 'findRaiseCredits'>;
  private readonly packs: Pick<AiPacksRepository, 'settings' | 'readPeriod' | 'livePacks'>;
  private readonly mode: () => BillingMode;
  private readonly now: () => Date;

  constructor(deps: AiAllowanceDeps) {
    this.database = deps.database;
    this.poolCapMicroUsd = deps.poolCapMicroUsd ?? envPoolCapReader();
    this.subscriptions = deps.subscriptions ?? new SubscriptionRepository();
    this.raises = deps.raises ?? new AiAllowanceRepository();
    this.packs = deps.packs ?? new AiPacksRepository();
    this.mode = deps.mode ?? (() => billingMode());
    this.now = deps.now ?? (() => new Date());
  }

  async resolveWith(
    runner: TenantQueryRunner,
    context: TenantContext,
    now: Date = this.now(),
  ): Promise<AiWorkspaceAllowance> {
    const settings = await this.packs.settings(runner, context);
    const subscription = await this.subscriptions.find(runner, context);
    const plan = entitlementsFor(readPlanId(subscription?.planId), this.mode());
    const raise = await this.raises.findRaiseCredits(runner, context);
    const capCredits = creditsOfMicroUsd(await this.poolCapMicroUsd(settings.poolClass));
    const allowance = aiAllowanceOf(plan.limits.aiCreditsMonthly, raise, capCredits);

    const periodStart = periodStartOf(now);
    const period = await this.packs.readPeriod(runner, context, periodStart);
    const livePacks = await this.packs.livePacks(runner, context, now);
    const balance = packBalance(livePacks, now);
    const people = await this.subscriptions.countInternalPeople(runner, context);
    const spendable = spendableCreditsOf({
      allowanceCredits: allowance.allowanceCredits,
      period,
      packBalanceCredits: balance,
    });
    return {
      settings,
      periodStart,
      allowanceCredits: allowance.allowanceCredits,
      limitedBy: allowance.limitedBy,
      raisedBySupport: allowance.raisedBySupport,
      period,
      livePacks,
      packBalanceCredits: balance,
      memberCredits: memberShareCredits(spendable, settings.memberSharePercent, people),
    };
  }

  /** What `AiBudgetService.openTask` takes as `allowance`, read in its own short read. */
  async forBudget(context: TenantContext): Promise<AiCreditAllowance> {
    const resolved = await this.database.read(context, (runner) =>
      this.resolveWith(runner, context),
    );
    return { workspaceCredits: resolved.allowanceCredits, memberCredits: resolved.memberCredits };
  }
}
