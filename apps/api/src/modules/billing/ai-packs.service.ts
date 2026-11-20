import { uuidv7 } from '@tmanage/domain';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AiPackTopUp } from '../copilot/ai-budget.service.js';
import type { AiAllowanceSource } from './ai-allowance.js';
import type { AiAllowanceService } from './ai-allowance.service.js';
import { creditsShort, planDraw, planReturn, unusedPackCredits } from './ai-packs.js';
import { AiPacksRepository } from './ai-packs.repository.js';
import type { AiPackRequestRecord, IsoDate } from './ai-packs.repository.js';
import { isDuplicateKey } from './referrals.repository.js';

/**
 * 62-07 (plan 62 §5). Credit packs on the workspace side:
 *
 * - {@link AiPacksService.topUp}: the budget service's {@link AiPackTopUp} port. Inside its
 *   transaction (READ COMMITTED), it first gives back the unused pack credits of closed periods,
 *   then moves exactly the credits a hold is short of from the oldest live packs into this period.
 *   Lock order: closed periods → this period → packs, the same in every caller, so two top-ups of
 *   one workspace serialise instead of deadlocking (DA-1: `SELECT … FOR UPDATE` plus conditional
 *   UPDATEs that re-check the rule on the locked row).
 * - {@link AiPacksService.credits}: the owner's read — allowance, used, held, remaining, reset date,
 *   pack balance, the open request, and the decision `canRequestPack` (AR-9).
 * - {@link AiPacksService.requestPack}: the owner's "Get more credits" during testing. One open
 *   request per workspace, held by a unique key (DA-1); audited in the same transaction (DA-11).
 *
 * A workspace that is not on the AI test list does not have the feature at all: both routes answer
 * 404, exactly as for a missing route (plan 62 §9 62-07, HT-1).
 */

/** `GET …/ai/credits` — CONTRACT: none on the web yet (62-18 builds the usage screen). */
export interface AiCreditsView {
  /** The month the figures belong to (`YYYY-MM-01`, UTC) and the day they reset. */
  readonly periodStart: string;
  readonly resetsOn: string;
  readonly allowanceCredits: number;
  readonly limitedBy: AiAllowanceSource;
  readonly raisedBySupport: boolean;
  /** Pack credits already moved into this month. */
  readonly packCreditsThisMonth: number;
  /** Credits of successful work this month, and credits held by tasks still running. */
  readonly usedCredits: number;
  readonly heldCredits: number;
  /** What the workspace can still spend this month before its packs: never below 0. */
  readonly remainingCredits: number;
  /** Credits still in live packs. */
  readonly packBalanceCredits: number;
  readonly packs: readonly AiCreditPackView[];
  /** What one member may use this month (share of allowance and packs). */
  readonly memberShareCredits: number;
  readonly openRequest: AiPackRequestView | null;
  /** The viewer may ask for a pack now (owner, and no request open). */
  readonly canRequestPack: boolean;
}

export interface AiCreditPackView {
  readonly remainingCredits: number;
  readonly grantedAt: string;
  readonly expiresAt: string;
}

/** `POST …/ai/credits/pack-requests` and the open request inside {@link AiCreditsView}. */
export interface AiPackRequestView {
  readonly id: string;
  readonly status: 'open' | 'granted' | 'declined';
  readonly requestedAt: string;
}

/** The tenant audit action of a pack request (`packages/domain` audit catalog). */
export const AI_PACK_REQUESTED_AUDIT_ACTION = 'ai_credit_pack.requested';

/** The capability that may request a pack (owner-only, like the plan-change request). */
const REQUEST_CAPABILITY = 'billing.manage';

export class AiPacksInvariantError extends Error {
  override readonly name = 'AiPacksInvariantError';
}

function must(moved: boolean, what: string): void {
  if (!moved) throw new AiPacksInvariantError(`ai packs: ${what} did not move`);
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'Not found');
}

function nextPeriodOf(periodStart: IsoDate): string {
  const [year = '1970', month = '01'] = periodStart.split('-');
  const next = new Date(Date.UTC(Number(year), Number(month), 1));
  return next.toISOString().slice(0, 10);
}

function requestView(request: AiPackRequestRecord): AiPackRequestView {
  return {
    id: request.id,
    status: request.status,
    requestedAt: request.requestedAt.toISOString(),
  };
}

export interface AiPacksDeps {
  readonly database: Pick<TenantDatabase, 'read' | 'transaction'>;
  readonly allowance: Pick<AiAllowanceService, 'resolveWith'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly repository?: AiPacksRepository;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export class AiPacksService implements AiPackTopUp {
  private readonly database: Pick<TenantDatabase, 'read' | 'transaction'>;
  private readonly allowance: Pick<AiAllowanceService, 'resolveWith'>;
  private readonly audit: Pick<AuditService, 'record'>;
  private readonly repository: AiPacksRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: AiPacksDeps) {
    this.database = deps.database;
    this.allowance = deps.allowance;
    this.audit = deps.audit;
    this.repository = deps.repository ?? new AiPacksRepository();
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? uuidv7;
  }

  // ── The budget's port ────────────────────────────────────────────────────────

  async topUp(
    tx: TenantQueryRunner,
    context: TenantContext,
    periodStart: IsoDate,
    holdCredits: number,
    now: Date,
  ): Promise<boolean> {
    await this.returnUnused(tx, context, periodStart, now);
    const period = await this.repository.lockPeriod(tx, context, periodStart);
    if (period === null) return false;
    const need = creditsShort(period, holdCredits);
    if (need === 0) return true;
    const moves = planDraw(await this.repository.lockLivePacks(tx, context, now), need, now);
    if (moves === null) return false;
    for (const move of moves) {
      must(
        await this.repository.drawFromPack(tx, context, move.packId, move.credits, now),
        'pack draw',
      );
      await this.repository.insertMove(tx, context, {
        id: this.newId(),
        packId: move.packId,
        periodStart,
        direction: 'draw',
        credits: move.credits,
        now,
      });
    }
    must(
      await this.repository.addPackCredits(tx, context, periodStart, need, now),
      'period pack credits',
    );
    return true;
  }

  /**
   * Give the unused pack credits of every closed period back to their live packs (newest grant
   * first) and mark the period returned, so it is never counted twice. A period with a hold still
   * open is skipped until the hold-expiry sweep closes it. Returns the credits given back.
   */
  async returnUnused(
    tx: TenantQueryRunner,
    context: TenantContext,
    currentPeriod: IsoDate,
    now: Date,
  ): Promise<number> {
    let returned = 0;
    for (const period of await this.repository.lockClosedPeriodsWithPackCredits(
      tx,
      context,
      currentPeriod,
    )) {
      const unused = unusedPackCredits(period);
      const draws = await this.repository.periodDraws(tx, context, period.periodStart);
      for (const move of planReturn(draws, unused, now)) {
        must(
          await this.repository.returnToPack(tx, context, move.packId, move.credits, now),
          'pack return',
        );
        await this.repository.insertMove(tx, context, {
          id: this.newId(),
          packId: move.packId,
          periodStart: period.periodStart,
          direction: 'return',
          credits: move.credits,
          now,
        });
        returned += move.credits;
      }
      must(
        await this.repository.markReturned(tx, context, period.periodStart, now),
        'period returned',
      );
    }
    return returned;
  }

  // ── The owner's routes ───────────────────────────────────────────────────────

  async credits(context: TenantContext): Promise<AiCreditsView> {
    const now = this.now();
    return this.database.read(context, async (runner) => {
      const resolved = await this.allowance.resolveWith(runner, context, now);
      if (!resolved.settings.onTestList) throw notFound();
      const openRequest = await this.repository.openRequest(runner, context);
      const period = resolved.period;
      const used = period?.settledCredits ?? 0;
      const held = period?.reservedCredits ?? 0;
      const packCredits = period?.packCredits ?? 0;
      return {
        periodStart: resolved.periodStart,
        resetsOn: nextPeriodOf(resolved.periodStart),
        allowanceCredits: resolved.allowanceCredits,
        limitedBy: resolved.limitedBy,
        raisedBySupport: resolved.raisedBySupport,
        packCreditsThisMonth: packCredits,
        usedCredits: used,
        heldCredits: held,
        remainingCredits: Math.max(0, resolved.allowanceCredits + packCredits - used - held),
        packBalanceCredits: resolved.packBalanceCredits,
        packs: resolved.livePacks.map((pack) => ({
          remainingCredits: pack.remainingCredits,
          grantedAt: pack.grantedAt.toISOString(),
          expiresAt: pack.expiresAt.toISOString(),
        })),
        memberShareCredits: resolved.memberCredits,
        openRequest: openRequest === null ? null : requestView(openRequest),
        canRequestPack:
          openRequest === null &&
          (context.capabilities as readonly string[]).includes(REQUEST_CAPABILITY),
      };
    });
  }

  async requestPack(context: TenantContext): Promise<AiPackRequestView> {
    const now = this.now();
    const id = this.newId();
    try {
      return await this.database.transaction(context, async (tx) => {
        const resolved = await this.allowance.resolveWith(tx, context, now);
        if (!resolved.settings.onTestList) throw notFound();
        if ((await this.repository.openRequest(tx, context)) !== null) throw requestOpen();
        await this.repository.insertRequest(tx, context, {
          id,
          membershipId: context.membershipId,
          now,
        });
        await this.audit.record(tx, context, {
          action: AI_PACK_REQUESTED_AUDIT_ACTION,
          result: 'allowed',
          objectId: id,
          actorUserId: context.userId,
          metadata: {
            pack_balance_credits: resolved.packBalanceCredits,
            allowance_credits: resolved.allowanceCredits,
          },
        });
        return { id, status: 'open' as const, requestedAt: now.toISOString() };
      });
    } catch (error) {
      // Two requests at once: the unique open slot refused the second (DA-1).
      if (isDuplicateKey(error)) throw requestOpen();
      throw error;
    }
  }
}

function requestOpen(): ApiError {
  return new ApiError(
    409,
    'conflict',
    'A request for more credits is already waiting.',
    undefined,
    'ai_pack_request_open',
  );
}
