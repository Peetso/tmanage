import { describe, expect, it } from 'vitest';
import { createSignInAbuseControl } from './sign-in-abuse-control.js';
import type { SignInAbuseOptions } from './sign-in-abuse-control.js';

/**
 * Every case drives an injected clock, so a window turn is an assignment rather than a wait,
 * and the budgets are the smallest numbers that still tell the cases apart — a test that
 * needed the production 30/10/600 would be measuring arithmetic, not the decision.
 */
const control = (overrides: Partial<SignInAbuseOptions> & { now: () => number }) =>
  createSignInAbuseControl({
    windowMs: 300_000,
    maxPerSource: 30,
    maxPerSourceAccount: 10,
    maxGlobal: 600,
    ...overrides,
  });

describe('the sign-in abuse control', () => {
  it('admits maxPerSource attempts from one address, refuses the next, and leaves another address alone', () => {
    const admit = control({ maxPerSource: 3, now: () => 1_000 });

    expect([
      admit.admit({ ip: '198.51.100.7' }).admitted,
      admit.admit({ ip: '198.51.100.7' }).admitted,
      admit.admit({ ip: '198.51.100.7' }).admitted,
    ]).toEqual([true, true, true]);

    const refused = admit.admit({ ip: '198.51.100.7' });
    expect(refused).toEqual({
      admitted: false,
      reason: 'source_throttled',
      firstRefusalInWindow: true,
    });

    // A second address carries its own window: one noisy office does not refuse the world.
    expect(admit.admit({ ip: '203.0.113.9' }).admitted).toBe(true);
  });

  it('self-heals when the window turns rather than locking the address out', () => {
    let clock = 1_000;
    const admit = control({ windowMs: 300_000, maxPerSource: 2, now: () => clock });

    admit.admit({ ip: '198.51.100.7' });
    admit.admit({ ip: '198.51.100.7' });
    expect(admit.admit({ ip: '198.51.100.7' }).admitted).toBe(false);

    clock += 300_000;
    expect(admit.admit({ ip: '198.51.100.7' }).admitted).toBe(true);
  });

  it('refuses on the source+account budget first when one address grinds one account', () => {
    const admit = control({ maxPerSource: 30, maxPerSourceAccount: 3, now: () => 5_000 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(admit.admit({ ip: '198.51.100.7', account: 'ana@example.test' }).admitted).toBe(true);
    }

    // The source budget is nowhere near 30, so the reason names the tightest bound that fired.
    expect(admit.admit({ ip: '198.51.100.7', account: 'ana@example.test' })).toEqual({
      admitted: false,
      reason: 'source_account_throttled',
      firstRefusalInWindow: true,
    });
  });

  it('charges the source budget across accounts, so a spray over rotating accounts is refused by it', () => {
    const admit = control({ maxPerSource: 4, maxPerSourceAccount: 10, now: () => 5_000 });

    // Four attempts over four distinct synthetic accounts: no account key is near its own
    // budget of 10, which is exactly the hole the per-user lockout leaves open.
    for (const account of [
      'a@example.test',
      'b@example.test',
      'c@example.test',
      'd@example.test',
    ]) {
      expect(admit.admit({ ip: '198.51.100.7', account }).admitted).toBe(true);
    }

    expect(admit.admit({ ip: '198.51.100.7', account: 'e@example.test' })).toEqual({
      admitted: false,
      reason: 'source_throttled',
      firstRefusalInWindow: true,
    });
  });

  it('catches a spray from rotating addresses on the global budget, which no address rotation evades', () => {
    const maxGlobal = 5;
    const admit = control({ maxPerSource: 30, maxGlobal, now: () => 5_000 });

    for (let attempt = 0; attempt < maxGlobal; attempt += 1) {
      // A fresh address each time: the source key never comes close to its own budget.
      expect(admit.admit({ ip: `198.51.100.${String(attempt)}` }).admitted).toBe(true);
    }

    expect(admit.admit({ ip: `198.51.100.${String(maxGlobal)}` })).toEqual({
      admitted: false,
      reason: 'global_throttled',
      firstRefusalInWindow: true,
    });
  });

  it('reports firstRefusalInWindow exactly once per key per window — the flag one event row hangs on', () => {
    let clock = 1_000;
    const admit = control({ maxPerSource: 1, now: () => clock });

    expect(admit.admit({ ip: '198.51.100.7' }).admitted).toBe(true);
    expect(admit.admit({ ip: '198.51.100.7' })).toEqual({
      admitted: false,
      reason: 'source_throttled',
      firstRefusalInWindow: true,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(admit.admit({ ip: '198.51.100.7' })).toEqual({
        admitted: false,
        reason: 'source_throttled',
        firstRefusalInWindow: false,
      });
    }

    clock += 300_000;
    expect(admit.admit({ ip: '198.51.100.7' }).admitted).toBe(true);
    expect(admit.admit({ ip: '198.51.100.7' })).toEqual({
      admitted: false,
      reason: 'source_throttled',
      firstRefusalInWindow: true,
    });
  });

  it('buckets a missing address under one key rather than admitting it unbounded', () => {
    const admit = control({ maxPerSource: 2, now: () => 5_000 });

    expect(admit.admit({ ip: null }).admitted).toBe(true);
    expect(admit.admit({ ip: undefined }).admitted).toBe(true);
    expect(admit.admit({ ip: null })).toEqual({
      admitted: false,
      reason: 'source_throttled',
      firstRefusalInWindow: true,
    });
  });

  it('reads one account through casing and surrounding whitespace, the way the lookup does', () => {
    const admit = control({ maxPerSource: 30, maxPerSourceAccount: 2, now: () => 5_000 });

    expect(admit.admit({ ip: '198.51.100.7', account: 'Ana@Example.TEST' }).admitted).toBe(true);
    expect(admit.admit({ ip: '198.51.100.7', account: '  ana@example.test  ' }).admitted).toBe(
      true,
    );
    expect(admit.admit({ ip: '198.51.100.7', account: 'ANA@EXAMPLE.TEST' })).toEqual({
      admitted: false,
      reason: 'source_account_throttled',
      firstRefusalInWindow: true,
    });
  });

  it('keeps distinct accounts in distinct buckets and cannot be made to collide through the key delimiter', () => {
    const admit = control({ maxPerSource: 30, maxPerSourceAccount: 2, now: () => 5_000 });

    // Two different accounts from one address do not share a budget.
    admit.admit({ ip: '198.51.100.7', account: 'ana@example.test' });
    admit.admit({ ip: '198.51.100.7', account: 'ana@example.test' });
    expect(admit.admit({ ip: '198.51.100.7', account: 'bo@example.test' }).admitted).toBe(true);

    // The account reaches the key as a hash, so a caller cannot spend someone else's budget
    // by typing the delimiter: concatenated raw, `198.51.100.4` + `x:ana@…` and
    // `198.51.100.4:x` + `ana@…` would be the same string.
    const ground = control({ maxPerSource: 30, maxPerSourceAccount: 1, now: () => 5_000 });
    expect(ground.admit({ ip: '198.51.100.4:x', account: 'ana@example.test' }).admitted).toBe(true);
    expect(ground.admit({ ip: '198.51.100.4', account: 'x:ana@example.test' }).admitted).toBe(true);
  });
});
