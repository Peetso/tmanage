import { AI_PRICE_TABLE_VERSION, bandFor, priceOf, type AiTokenRates } from './ai-price-table.js';

/**
 * The cost calculator of the in-app AI (plan 62, slice 62-02, B07): the real cost of one model call
 * from the provider's `usage`, in integer micro-USD, over every billed bucket.
 *
 * Rounding is up, once, at the end, so the platform pool is never under-charged. 1 credit is
 * 0.001 USD of real cost (1 000 micro-USD); credits are also rounded up. Tier ceilings are applied
 * by the budget service (62-06), not here.
 */

/** Micro-USD in one credit (1 credit = 0.001 USD). */
export const MICRO_USD_PER_CREDIT = 1_000;

/** The billed token buckets of one call, as normalised from the provider's `usage`. */
export interface AiUsage {
  /** Uncached input after the last cache breakpoint. */
  readonly inputTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
  readonly cacheReadTokens: number;
  /** Output, thinking included. */
  readonly outputTokens: number;
}

export interface AiCost {
  readonly microUsd: number;
  readonly priceTableVersion: typeof AI_PRICE_TABLE_VERSION;
}

/** A usage that cannot be priced: a model outside the table or a bucket that is not a count. */
export class AiCostError extends Error {
  override readonly name = 'AiCostError';
}

const BUCKETS: readonly (readonly [keyof AiUsage, keyof AiTokenRates])[] = [
  ['inputTokens', 'inputPerMTok'],
  ['cacheWrite5mTokens', 'cacheWrite5mPerMTok'],
  ['cacheWrite1hTokens', 'cacheWrite1hPerMTok'],
  ['cacheReadTokens', 'cacheReadPerMTok'],
  ['outputTokens', 'outputPerMTok'],
];

/** Every token of the prompt, cached or not: what selects a model's price band. */
export function promptTokensOf(usage: AiUsage): number {
  return (
    usage.inputTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens + usage.cacheReadTokens
  );
}

/** The real cost of one call of `model` with `usage`, rounded up to a whole micro-USD. */
export function costOfCall(model: string, usage: AiUsage): AiCost {
  const price = priceOf(model);
  if (price === undefined) throw new AiCostError(`model "${model}" is not in the price table`);
  for (const [bucket] of BUCKETS) {
    const tokens = usage[bucket];
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new AiCostError(`usage bucket ${bucket} is not a token count`);
    }
  }
  const { rates } = bandFor(price, promptTokensOf(usage));
  const scaled = BUCKETS.reduce((sum, [bucket, rate]) => sum + usage[bucket] * rates[rate], 0);
  if (!Number.isSafeInteger(scaled)) throw new AiCostError('usage too large to price exactly');
  return { microUsd: Math.ceil(scaled / 1_000_000), priceTableVersion: AI_PRICE_TABLE_VERSION };
}

/** Whole credits for a cost, rounded up (a 1 micro-USD call costs 1 credit). */
export function creditsForMicroUsd(microUsd: number): number {
  if (!Number.isSafeInteger(microUsd) || microUsd < 0) {
    throw new AiCostError('a cost is a non-negative whole number of micro-USD');
  }
  return Math.ceil(microUsd / MICRO_USD_PER_CREDIT);
}
