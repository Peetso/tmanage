import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from './backoff.js';

describe('backoffDelayMs', () => {
  it('waits one base interval after the first failure', () => {
    expect(backoffDelayMs(1, 1_000, 900_000)).toBe(1_000);
  });

  it('doubles per failure', () => {
    expect(backoffDelayMs(2, 1_000, 900_000)).toBe(2_000);
    expect(backoffDelayMs(3, 1_000, 900_000)).toBe(4_000);
    expect(backoffDelayMs(4, 1_000, 900_000)).toBe(8_000);
  });

  it('never exceeds the cap', () => {
    expect(backoffDelayMs(10, 1_000, 60_000)).toBe(60_000);
    expect(backoffDelayMs(11, 1_000, 60_000)).toBe(60_000);
  });

  it('stays finite and capped for absurd attempt counts', () => {
    // 2^(attempts-1) would overflow to Infinity without the exponent clamp, and
    // Math.min(cap, Infinity) still behaves — this pins the arithmetic, not the luck.
    expect(backoffDelayMs(1_000, 1_000, 900_000)).toBe(900_000);
    expect(Number.isFinite(backoffDelayMs(1_000, 1_000, Number.MAX_SAFE_INTEGER))).toBe(true);
  });

  it('treats zero and negative attempts as no delay', () => {
    // Attempts below 1 cannot be scheduled — the count is written after a failure — so
    // the function answers the impossible question with the least surprising number.
    expect(backoffDelayMs(0, 1_000, 900_000)).toBe(0);
    expect(backoffDelayMs(-3, 1_000, 900_000)).toBe(0);
  });
});
