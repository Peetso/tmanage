import { describe, expect, it } from 'vitest';
import { createFixedWindowLimiter } from './rate-limiter.js';

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
