import { describe, expect, it } from 'vitest';
import { GROWTH_STALE_MS, growthFreshness } from './freshness.js';

describe('growthFreshness', () => {
  const now = new Date('2026-11-20T12:00:00Z');

  it('is none without figures, fresh inside the window and stale past it', () => {
    expect(growthFreshness(null, now)).toBe('none');
    expect(growthFreshness(new Date(now.getTime() - GROWTH_STALE_MS), now)).toBe('fresh');
    expect(growthFreshness(new Date(now.getTime() - GROWTH_STALE_MS - 1), now)).toBe('stale');
  });
});
