import { describe, expect, it } from 'vitest';
import { AiCostError, costOfCall, creditsForMicroUsd, type AiUsage } from './ai-cost.js';
import {
  AI_PRICE_TABLE_VERSION,
  AI_PRICED_MODELS,
  isPricedModel,
  priceOf,
} from './ai-price-table.js';

/** Plan 62, slice 62-02 (B07): the versioned price table and the cost of one call in micro-USD. */

const usage = (buckets: Partial<AiUsage>): AiUsage => ({
  inputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  ...buckets,
});

describe('AI price table', () => {
  it('prices exactly the models the plan runs on our budget, and never Opus', () => {
    expect(AI_PRICED_MODELS).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect([isPricedModel('claude-opus-5-5'), priceOf('claude-opus-5-5')]).toEqual([
      false,
      undefined,
    ]);
    expect(isPricedModel('toString')).toBe(false);
  });

  it('derives cache writes from the input price (5 minutes 1.25 ×, 1 hour 2 ×)', () => {
    const sonnet = priceOf('claude-sonnet-5-5')?.bands[0].rates;
    expect(sonnet).toEqual({
      inputPerMTok: 2_000_000,
      cacheWrite5mPerMTok: 2_500_000,
      cacheWrite1hPerMTok: 4_000_000,
      cacheReadPerMTok: 100_000,
      outputPerMTok: 10_000_000,
    });
  });
});

describe('cost of one call', () => {
  it.each([
    [
      'Haiku, input and output',
      'claude-haiku-5-5',
      usage({ inputTokens: 1_000, outputTokens: 500 }),
      350,
    ],
    [
      'Haiku, every bucket',
      'claude-haiku-5-5',
      usage({
        inputTokens: 2_000,
        cacheWrite5mTokens: 4_000,
        cacheWrite1hTokens: 1_000,
        cacheReadTokens: 50_000,
        outputTokens: 800,
      }),
      1_800,
    ],
    [
      'Haiku, prompt exactly at the 100K band edge',
      'claude-haiku-5-5',
      usage({ inputTokens: 100_000 }),
      10_000,
    ],
    [
      'Haiku, prompt above 100K (cache reads count towards the prompt)',
      'claude-haiku-5-5',
      usage({ inputTokens: 20_000, cacheReadTokens: 100_000, outputTokens: 1_000 }),
      // 20 000 × 0.50 + 100 000 × 0.05 + 1 000 × 2.50 (USD per MTok) = 17 500 micro-USD
      17_500,
    ],
    ['Sonnet, small call', 'claude-sonnet-5-5', usage({ inputTokens: 3, outputTokens: 7 }), 76],
    [
      'one Haiku input token is a whole micro-USD',
      'claude-haiku-5-5',
      usage({ inputTokens: 1 }),
      1,
    ],
    ['nothing used costs nothing', 'claude-sonnet-5-5', usage({}), 0],
  ] as const)('%s', (_name, model, used, microUsd) => {
    expect(costOfCall(model, used)).toEqual({
      microUsd,
      priceTableVersion: AI_PRICE_TABLE_VERSION,
    });
  });

  it.each([
    ['a model outside the table', 'claude-opus-5-5', usage({ inputTokens: 1 })],
    ['a negative bucket', 'claude-haiku-5-5', usage({ outputTokens: -1 })],
    ['a fractional bucket', 'claude-haiku-5-5', usage({ inputTokens: 1.5 })],
    ['a bucket too large to price exactly', 'claude-sonnet-5-5', usage({ outputTokens: 2 ** 52 })],
  ] as const)('refuses %s', (_name, model, used) => {
    expect(() => costOfCall(model, used)).toThrow(AiCostError);
  });

  it.each([
    [0, 0],
    [1, 1],
    [1_000, 1],
    [1_001, 2],
    [17_500, 18],
  ])('%i micro-USD is %i credits, rounded up', (microUsd, credits) => {
    expect(creditsForMicroUsd(microUsd)).toBe(credits);
  });

  it('refuses a cost that is not a whole non-negative number of micro-USD', () => {
    expect(() => creditsForMicroUsd(-1)).toThrow(AiCostError);
    expect(() => creditsForMicroUsd(0.5)).toThrow(AiCostError);
  });
});
