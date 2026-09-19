import { describe, expect, it } from 'vitest';
import {
  bandFor,
  bandForMove,
  crossedUpInto,
  usagePercent,
  usageThresholdIdempotencyKey,
  type ThresholdBand,
} from './usage-thresholds.js';

/**
 * USAGE-001 slice 4. The band arithmetic is pure and total, so it is proven here rather than
 * through the database: each boundary crossed rising, the hysteresis in both directions, the
 * emit decision, and the idempotency key. The DB test (`usage-001-threshold.db.test.ts`) proves
 * only what the database adds — that the crossing fires once and re-arms after a fall.
 */
describe('usagePercent — used + reserved over quota (Q6)', () => {
  it('sums used and reserved against the quota', () => {
    expect(usagePercent(50, 20, 100)).toBe(70);
    expect(usagePercent(100, 0, 100)).toBe(100);
  });

  it('reads a non-positive quota as full once anything is held, empty otherwise', () => {
    expect(usagePercent(1, 0, 0)).toBe(100);
    expect(usagePercent(0, 0, 0)).toBe(0);
  });
});

describe('bandFor — rising crosses immediately (acceptance §1)', () => {
  const rising: ReadonlyArray<[number, ThresholdBand]> = [
    [69.9, 0],
    [70, 70],
    [84.9, 70],
    [85, 85],
    [94.9, 85],
    [95, 95],
    [99.9, 95],
    [100, 100],
    [120, 100],
  ];
  it.each(rising)('at %d%% from band 0 → %d', (pct, expected) => {
    expect(bandFor(pct, 0)).toBe(expected);
  });

  it('jumps straight to the highest band reached', () => {
    expect(bandFor(96, 0)).toBe(95);
    expect(bandFor(100, 70)).toBe(100);
  });
});

describe('bandFor — falling is sticky within 5 points (Q5 hysteresis)', () => {
  it('holds the band until usage drops to a full 5 points below the boundary', () => {
    expect(bandFor(84, 85)).toBe(85); // 84 > 85 - 5, stays
    expect(bandFor(80.1, 85)).toBe(85); // still above the floor, stays
    expect(bandFor(80, 85)).toBe(70); // at the floor (pct ≤ band - 5), leaves
    expect(bandFor(79.9, 85)).toBe(70); // below the floor, drops
  });

  it('applies each lower band’s own floor when it drops several at once', () => {
    // From 100 down: 84 clears 100’s floor (95) and 95’s floor (90) but sits inside 85’s
    // dead-band (80..85), so it lands on 85, not on 70.
    expect(bandFor(84, 100)).toBe(85);
    // 66 clears 100/95/85’s floors but is above 70’s floor (65), so it holds 70.
    expect(bandFor(66, 100)).toBe(70);
    // 64 clears every floor including 70’s, so it falls all the way to 0.
    expect(bandFor(64, 100)).toBe(0);
  });

  it('re-arms: a fall below the floor then a rise crosses again', () => {
    const dropped = bandFor(60, 85); // → 0
    expect(dropped).toBe(0);
    expect(bandFor(86, dropped)).toBe(85); // crosses 85 again
  });
});

describe('bandForMove — the 100 block band needs usage over the quota (x72)', () => {
  it('caps an accepted fill at 95: exactly 100% is the persistent warning, only over-quota blocks', () => {
    // The reserve guard caps an accepted reservation at exactly the quota, so a move to 100%
    // was accepted, not blocked — the 95 warning, not the 100 block (49 §6).
    expect(bandForMove(100, 85)).toBe(95);
    expect(bandForMove(100, 0)).toBe(95);
    // Already at or past the warning: no new band, so evaluate emits nothing.
    expect(bandForMove(100, 95)).toBe(95);
    // Only usage OVER the quota (a commit over the declaration, reconciler drift) is a block.
    expect(bandForMove(100.01, 95)).toBe(100);
    // Below the warning bands it is identical to bandFor.
    expect(bandForMove(72, 0)).toBe(70);
  });
});

describe('crossedUpInto — emit only when the band rose', () => {
  it('returns the entered band on a rise, null otherwise', () => {
    expect(crossedUpInto(0, 85)).toBe(85);
    expect(crossedUpInto(70, 100)).toBe(100);
    expect(crossedUpInto(95, 95)).toBeNull();
    expect(crossedUpInto(100, 85)).toBeNull(); // a fall never emits
  });
});

describe('usageThresholdIdempotencyKey — distinct per crossing', () => {
  it('joins counter id, band and version so a re-entry gets a fresh key', () => {
    expect(usageThresholdIdempotencyKey('counter-1', 85, 7)).toBe('counter-1:85:7');
    // Same band, later version (usage fell then rose again): a different key, delivered again.
    expect(usageThresholdIdempotencyKey('counter-1', 85, 12)).not.toBe(
      usageThresholdIdempotencyKey('counter-1', 85, 7),
    );
  });
});
