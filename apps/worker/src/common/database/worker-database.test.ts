import { describe, expect, it } from 'vitest';
import { workerConnectionLimit } from './worker-database.js';

/**
 * The relay's pool size, pinned per mode.
 *
 * Loop mode has three borrowers since x31 — the outbox loop, the notice loop and RT-001's
 * subscription reads — and a cap of two made a subscription check wait behind a batch for no
 * reason. The number is a heuristic, so what this test defends is not the value in itself but
 * that loop mode gets one connection per borrower while batch mode is unchanged, and that
 * `DATABASE_POOL_MAX` still wins whenever it is the smaller of the two.
 */
describe('the relay pool size', () => {
  it('gives loop mode one connection per borrower and leaves batch mode at two', () => {
    expect(workerConnectionLimit(10, 'loop')).toBe(3);
    expect(workerConnectionLimit(10, 'batch')).toBe(2);
  });

  it('never opens more than DATABASE_POOL_MAX allows', () => {
    expect(workerConnectionLimit(2, 'loop')).toBe(2);
    expect(workerConnectionLimit(1, 'batch')).toBe(1);
  });
});
