import { describe, expect, it } from 'vitest';
import { detectSuspicious, parseWindow, windowStart } from './suspicious.js';
import type { FailureEvent } from './suspicious.js';

/** platform-admin v2 · PA-09 — C3 Suspicious: IP bursts, repeated failures, GeoIP placeholder. */

const T0 = new Date('2026-10-28T13:52:00.000Z').getTime();

function failure(overrides: Partial<FailureEvent> & { minute: number }): FailureEvent {
  return {
    ip: '185.220.101.4',
    userId: null,
    email: null,
    outcome: 'failed',
    reason: 'bad_password',
    occurredAt: new Date(T0 + overrides.minute * 60_000),
    ...overrides,
  };
}

describe('detectSuspicious', () => {
  it('flags a burst of failures from one IP across many accounts', () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      failure({ minute: i % 10, userId: `user-${i % 4}`, email: `u${i % 4}@x.co` }),
    );
    const view = detectSuspicious(events, '24h');
    const burst = view.patterns.find((pattern) => pattern.kind === 'ip_burst');
    expect(burst).toMatchObject({
      source: '185.220.101.4',
      failures: 12,
      accountsHit: 4,
      status: 'open',
    });
    expect(burst?.firstAt).toBe(new Date(T0).toISOString());
    expect(burst?.lastAt).toBe(new Date(T0 + 9 * 60_000).toISOString());
  });

  it('ignores an IP under the burst threshold', () => {
    const events = Array.from({ length: 9 }, (_, i) => failure({ minute: i }));
    expect(detectSuspicious(events, '1h').patterns).toEqual([]);
  });

  it('flags failures over N on one account from many addresses, locked when the control refused', () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      failure({
        minute: i,
        ip: `10.0.0.${i}`,
        userId: 'omar',
        email: 'omar@cairobuild.co',
        reason: i === 4 ? 'rate_limited' : 'bad_password',
      }),
    );
    const view = detectSuspicious(events, '24h');
    expect(view.patterns).toEqual([
      expect.objectContaining({
        kind: 'repeated_failures',
        source: 'omar@cairobuild.co',
        userId: 'omar',
        failures: 5,
        accountsHit: 1,
        status: 'locked',
      }),
    ]);
  });

  it('answers the new-country check with the GeoIP placeholder', () => {
    expect(detectSuspicious([], '7d')).toEqual({ window: '7d', patterns: [], geoAvailable: false });
  });

  it('reads the window, defaulting to 24 hours', () => {
    expect(parseWindow('1h')).toBe('1h');
    expect(parseWindow('nope')).toBe('24h');
    const now = new Date('2026-10-29T00:00:00.000Z');
    expect(windowStart('1h', now).toISOString()).toBe('2026-10-28T23:00:00.000Z');
  });
});
