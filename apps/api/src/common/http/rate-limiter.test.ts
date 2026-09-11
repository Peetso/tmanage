import { describe, expect, it } from 'vitest';
import { createFixedWindowLimiter, createTwoPhaseFixedWindowLimiter } from './rate-limiter.js';

describe('the fixed-window limiter', () => {
  it('admits max requests per key per window, refuses the next, and forgets when the window turns', () => {
    let clock = 1_000;
    const admit = createFixedWindowLimiter({ windowMs: 60_000, max: 3, now: () => clock });
    expect([admit('a'), admit('a'), admit('a')]).toEqual([true, true, true]);
    // Reversal: compare with `<` and the third is already refused (proved 2026-09-05).
    expect(admit('a')).toBe(false);
    expect(admit('a')).toBe(false);
    // Another key has its own window.
    expect(admit('b')).toBe(true);
    clock += 60_000;
    expect(admit('a')).toBe(true);
  });

  it('holds memory to maxKeys, dropping the least recently seen key first', () => {
    const admit = createFixedWindowLimiter({ windowMs: 60_000, max: 1, maxKeys: 2, now: () => 5 });
    expect(admit('a')).toBe(true);
    expect(admit('b')).toBe(true);
    expect(admit('b')).toBe(false);
    // 'c' evicts 'a' (the oldest); 'b' was touched more recently and keeps its window.
    expect(admit('c')).toBe(true);
    expect(admit('b')).toBe(false);
    // 'a' returns with a fresh window and evicts 'c', the least recently seen now.
    expect(admit('a')).toBe(true);
    expect(admit('c')).toBe(true);
  });
});

/**
 * `N-1` (re-review of 2026-09-07). The shape `sign-in-abuse-control.ts` needs to hold three
 * budgets and spend none of them until all three have answered. What has to be true of `test`
 * is that it is a *question*: repeating it changes nothing, and the answer it gives is the one
 * `commit` will give at the same instant.
 */
describe('the two-phase fixed-window limiter', () => {
  it('answers without charging, however many times it is asked', () => {
    const limiter = createTwoPhaseFixedWindowLimiter({ windowMs: 60_000, max: 2, now: () => 5 });

    // A hundred questions and no charge: the key is still at a full budget of 2.
    for (let ask = 0; ask < 100; ask += 1) expect(limiter.test('a', 5)).toBe(true);
    expect([limiter.commit('a', 5), limiter.commit('a', 5)]).toEqual([true, true]);

    // Spent. The question now answers the same way the charge would, and still charges nothing.
    expect(limiter.test('a', 5)).toBe(false);
    expect(limiter.test('a', 5)).toBe(false);
    expect(limiter.commit('a', 5)).toBe(false);

    // And a question never starts a window either: `b` is untouched until it is committed.
    expect(limiter.test('b', 5)).toBe(true);
    expect(limiter.test('b', 5)).toBe(true);
    expect([limiter.commit('b', 5), limiter.commit('b', 5)]).toEqual([true, true]);
    expect(limiter.commit('b', 5)).toBe(false);
  });

  it('takes the instant from the caller, so one decision can span several keys', () => {
    let clock = 1_000;
    const limiter = createTwoPhaseFixedWindowLimiter({
      windowMs: 60_000,
      max: 1,
      now: () => clock,
    });
    expect(limiter.now()).toBe(1_000);

    expect(limiter.commit('a', 1_000)).toBe(true);
    expect(limiter.test('a', 1_000)).toBe(false);

    // The clock moving does not decide anything; the instant the caller passes does. That is
    // what keeps a test/commit pair exact across a window boundary the caller never sees.
    clock += 60_000;
    expect(limiter.test('a', 1_000)).toBe(false);
    expect(limiter.test('a', 61_000)).toBe(true);
  });

  it('evicts on a charge and never on a question, so asking cannot cost another key its window', () => {
    const limiter = createTwoPhaseFixedWindowLimiter({
      windowMs: 60_000,
      max: 1,
      maxKeys: 2,
      now: () => 5,
    });
    expect(limiter.commit('a', 5)).toBe(true);
    expect(limiter.commit('b', 5)).toBe(true);

    // Two slots, both taken. Asking about a third key a hundred times evicts nothing.
    for (let ask = 0; ask < 100; ask += 1) expect(limiter.test('c', 5)).toBe(true);
    expect(limiter.test('a', 5)).toBe(false);
    expect(limiter.test('b', 5)).toBe(false);

    // Charging `c` is what evicts, and it drops `a` — the least recently *charged*.
    expect(limiter.commit('c', 5)).toBe(true);
    expect(limiter.test('a', 5)).toBe(true);
    expect(limiter.test('b', 5)).toBe(false);
  });
});
