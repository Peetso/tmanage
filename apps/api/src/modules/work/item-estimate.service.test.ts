import { describe, expect, it } from 'vitest';
import { effectiveRemaining } from './item-estimate.service.js';

/** 53-08 (R21-b, 0309): the one remaining-estimate rule every reader uses. */
describe('effectiveRemaining', () => {
  it('derives max(0, estimate - logged) without an override', () => {
    expect(
      effectiveRemaining({ estimateMinutes: 600, remainingMinutes: null, loggedMinutes: 90 }),
    ).toEqual({ remainingMinutes: 510, remainingSource: 'derived' });
    expect(
      effectiveRemaining({ estimateMinutes: 600, remainingMinutes: null, loggedMinutes: 700 }),
    ).toEqual({ remainingMinutes: 0, remainingSource: 'derived' });
  });

  it('the override wins even when more was logged than estimated', () => {
    expect(
      effectiveRemaining({ estimateMinutes: 600, remainingMinutes: 100, loggedMinutes: 700 }),
    ).toEqual({ remainingMinutes: 100, remainingSource: 'override' });
  });
});
