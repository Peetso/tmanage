import { MICRO_USD_PER_CREDIT } from '../copilot/ai-cost.js';

/**
 * 62-07 (plan 62 §5). The monthly AI credit allowance of a workspace: the ONE place it is decided
 * (AR-8). Pure: `ai-allowance.service.ts` reads the inputs, the budget service (62-06) holds
 * against the result.
 *
 * 1 credit = 0.001 USD of real API cost. Three figures decide it, in the storage allowance's order
 * (`storage-allowance.ts`): the plan's `aiCreditsMonthly`, a platform admin's raise for this
 * workspace (`organization_limits.ai_credits_limit`), and the cap — the monthly cap of the pool the
 * workspace draws from, in credits, so one workspace can never be promised more than its pool can
 * pay for. Unlike storage there is always a figure: a plan with none ("by agreement", Enterprise —
 * and every workspace during the free beta, which gets the top plan) falls back to the
 * per-workspace target {@link AI_CREDITS_TARGET_MONTHLY} until a platform admin raises it.
 *
 * Every figure is provisional until the Phase 0 benchmark (plan 62 §6). None of them is a price.
 */

/**
 * Plan 62 §5: "at most 3 USD of real cost per workspace per month = 3,000 credits". The figure a
 * workspace gets when its plan sets none and no platform admin raised it.
 */
export const AI_CREDITS_TARGET_MONTHLY = 3000;

/** The default member share of the workspace allowance, in percent (plan 62 §5). */
export const AI_MEMBER_SHARE_DEFAULT_PERCENT = 50;

/** Which figure the allowance stops at: what a screen names in plain words. */
export type AiAllowanceSource = 'plan' | 'agreement' | 'support' | 'platform';

export interface AiAllowance {
  /** The month's allowance in whole credits, before any pack. */
  readonly allowanceCredits: number;
  readonly limitedBy: AiAllowanceSource;
  /** A platform admin set this workspace's figure above its plan's. */
  readonly raisedBySupport: boolean;
}

/** Whole credits a pool cap pays for (rounded down: never promise a part credit). */
export function creditsOfMicroUsd(microUsd: number): number {
  return Math.max(0, Math.floor(microUsd / MICRO_USD_PER_CREDIT));
}

function wholeCredits(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

/**
 * The allowance from its three inputs. `planCredits` is `null`/absent when the plan sets no figure;
 * `raiseCredits` is `null` when no raise is stored; `capCredits` is the pool cap in credits.
 */
export function aiAllowanceOf(
  planCredits: number | null | undefined,
  raiseCredits: number | null,
  capCredits: number,
): AiAllowance {
  const plan = wholeCredits(planCredits);
  const raise = wholeCredits(raiseCredits);
  const source: AiAllowanceSource =
    raise !== null ? 'support' : plan !== null ? 'plan' : 'agreement';
  const wanted = raise ?? plan ?? AI_CREDITS_TARGET_MONTHLY;
  const cap = Math.max(0, Math.floor(capCredits));
  const capWins = wanted > cap;
  return {
    allowanceCredits: capWins ? cap : wanted,
    limitedBy: capWins ? 'platform' : source,
    raisedBySupport: raise !== null && raise > (plan ?? AI_CREDITS_TARGET_MONTHLY),
  };
}

/**
 * A member's share of what the workspace can spend this month (plan 62 §5: 50 % by default, 100 %
 * for a one-person workspace). `sharePercent` outside 1–100 is clamped; a stored 0 would lock every
 * member out, which only the owner's "members who may not use it" setting may do.
 */
export function memberShareCredits(
  workspaceCredits: number,
  sharePercent: number,
  internalPeople: number,
): number {
  const total = Math.max(0, Math.floor(workspaceCredits));
  if (internalPeople <= 1) return total;
  const percent = Math.min(100, Math.max(1, Math.floor(sharePercent)));
  return Math.floor((total * percent) / 100);
}
