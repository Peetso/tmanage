/**
 * The one versioned price table of the in-app AI (plan 62, slice 62-02, B07).
 *
 * A model that is not in this table cannot be called: the AI client refuses it before any request
 * leaves the process (`ai-client.ts`), so a cost can always be computed. Only the models the plan
 * runs on our budget are listed (Haiku for help, low and medium work; Sonnet for medium-high and
 * high). Opus is never on our budget and is therefore absent on purpose.
 *
 * Rates are integers in micro-USD per million tokens (USD per MTok × 1 000 000), so a cost is exact
 * integer arithmetic: `tokens × rate / 1 000 000` micro-USD. Cache writes are priced per TTL
 * (5 minutes = 1.25 × input, 1 hour = 2 × input); thinking is billed as output.
 *
 * Source: Anthropic first-party API prices, as published on 2026-11-03. A price change is a new
 * table version (new `AI_PRICE_TABLE_VERSION`), never an edit of an old rate in place, so ledger rows
 * that record the version stay explainable.
 */

/** The version every ledger row records next to the cost it computed. */
export const AI_PRICE_TABLE_VERSION = '2026-11-03' as const;

/** Micro-USD per million tokens for each billed usage bucket. */
export interface AiTokenRates {
  readonly inputPerMTok: number;
  readonly cacheWrite5mPerMTok: number;
  readonly cacheWrite1hPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly outputPerMTok: number;
}

/**
 * One price band of a model. A request is priced at the band whose `upToPromptTokens` is the first
 * at or above the prompt size (input + cache writes + cache reads); `null` is the open last band.
 */
export interface AiPriceBand {
  readonly upToPromptTokens: number | null;
  readonly rates: AiTokenRates;
}

export interface AiModelPrice {
  readonly model: AiModelId;
  /** Ordered by `upToPromptTokens`, the open band (`null`) last. */
  readonly bands: readonly [AiPriceBand, ...AiPriceBand[]];
}

/** USD per MTok → micro-USD per MTok, written once so the table reads in published prices. */
const usd = (perMTok: number): number => Math.round(perMTok * 1_000_000);

/** Rates derived from the input and output price by the published cache multipliers. */
function rates(input: number, output: number, cacheRead: number): AiTokenRates {
  return {
    inputPerMTok: usd(input),
    cacheWrite5mPerMTok: usd(input * 1.25),
    cacheWrite1hPerMTok: usd(input * 2),
    cacheReadPerMTok: usd(cacheRead),
    outputPerMTok: usd(output),
  };
}

const PRICES = {
  'claude-haiku-5-5': {
    model: 'claude-haiku-5-5',
    bands: [
      { upToPromptTokens: 100_000, rates: rates(0.1, 0.5, 0.01) },
      { upToPromptTokens: null, rates: rates(0.5, 2.5, 0.05) },
    ],
  },
  'claude-sonnet-5-5': {
    model: 'claude-sonnet-5-5',
    bands: [{ upToPromptTokens: null, rates: rates(2, 10, 0.1) }],
  },
} as const satisfies Record<string, { readonly model: string; readonly bands: unknown }>;

/** A model id the AI may call: exactly the keys of the price table. */
export type AiModelId = keyof typeof PRICES;

/** The priced models, in table order. */
export const AI_PRICED_MODELS: readonly AiModelId[] = Object.keys(PRICES) as AiModelId[];

/** Whether `model` is in the price table (and may therefore be called). */
export function isPricedModel(model: string): model is AiModelId {
  return Object.prototype.hasOwnProperty.call(PRICES, model);
}

/** The price of a model, or `undefined` when it is not in the table. */
export function priceOf(model: string): AiModelPrice | undefined {
  return isPricedModel(model) ? PRICES[model] : undefined;
}

/** The band a prompt of `promptTokens` falls in. */
export function bandFor(price: AiModelPrice, promptTokens: number): AiPriceBand {
  const band = price.bands.find(
    (candidate) =>
      candidate.upToPromptTokens === null || promptTokens <= candidate.upToPromptTokens,
  );
  return band ?? price.bands[price.bands.length - 1] ?? price.bands[0];
}
