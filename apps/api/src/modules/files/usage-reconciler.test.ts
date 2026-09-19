import { describe, expect, it } from 'vitest';
import { reconcileCounter } from './usage-reconciler.js';

/**
 * USAGE-001 slice 3. The one pure piece worth a unit test: the diff between a
 * `usage_counters` row and the per-counter ledger sums. It decides whether the counter
 * drifted and what the corrected value is — the ledger sum, because the ledger is the
 * source of truth (`49-PRICING` §6). The DB suite proves the correction is applied under a
 * row lock and never crosses a tenant; this proves the arithmetic the correction rests on.
 */
describe('reconcileCounter', () => {
  it('reports no drift when the counter already equals the ledger sums', () => {
    const diff = reconcileCounter({ used: 300, reserved: 50 }, { used: 300, reserved: 50 });
    expect(diff.drifted).toBe(false);
    expect(diff.usedDelta).toBe(0);
    expect(diff.reservedDelta).toBe(0);
    expect(diff.expected).toEqual({ used: 300, reserved: 50 });
  });

  it('detects a drifted used counter and targets the ledger sum', () => {
    const diff = reconcileCounter({ used: 250, reserved: 50 }, { used: 300, reserved: 50 });
    expect(diff.drifted).toBe(true);
    expect(diff.usedDelta).toBe(50);
    expect(diff.reservedDelta).toBe(0);
    expect(diff.expected).toEqual({ used: 300, reserved: 50 });
  });

  it('detects a drifted reserved counter in either direction', () => {
    const diff = reconcileCounter({ used: 300, reserved: 80 }, { used: 300, reserved: 50 });
    expect(diff.drifted).toBe(true);
    expect(diff.usedDelta).toBe(0);
    expect(diff.reservedDelta).toBe(-30);
    expect(diff.expected).toEqual({ used: 300, reserved: 50 });
  });

  it('detects drift on both dimensions at once', () => {
    const diff = reconcileCounter({ used: 0, reserved: 0 }, { used: 300, reserved: 50 });
    expect(diff.drifted).toBe(true);
    expect(diff.usedDelta).toBe(300);
    expect(diff.reservedDelta).toBe(50);
    expect(diff.expected).toEqual({ used: 300, reserved: 50 });
  });
});
