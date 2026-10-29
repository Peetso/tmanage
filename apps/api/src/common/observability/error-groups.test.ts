import { describe, expect, it } from 'vitest';
import type { AlertFacts } from './alerts.js';
import { GroupedAlertNotifier, routePattern } from './error-groups.js';

function sink(): {
  enabled: boolean;
  calls: [string, AlertFacts][];
  notify: GroupedAlertNotifier['notify'];
} {
  const calls: [string, AlertFacts][] = [];
  return {
    enabled: true,
    calls,
    notify: (kind, facts = {}) => (calls.push([kind, facts]), Promise.resolve('sent')),
  };
}

describe('GroupedAlertNotifier', () => {
  it('mails the first occurrence, counts the rest, and mails one summary when the window closes', async () => {
    let now = 0;
    const inner = sink();
    const grouped = new GroupedAlertNotifier(inner, { now: () => now, windowMs: 1_000 });
    expect(await grouped.notify('http_5xx:x', { route: 'GET /v1/tasks/42?token=s' })).toBe('sent');
    expect(await grouped.notify('http_5xx:x', { route: 'GET /v1/tasks/43' })).toBe('throttled');
    expect(await grouped.flush()).toBe(0);
    now = 1_000;
    expect(await grouped.flush()).toBe(1);
    expect(inner.calls[0]?.[1].route).toBe('GET /v1/tasks/:id');
    expect(inner.calls[1]?.[1].detail).toBe(
      '1 more occurrence(s) since the last alert of this kind. Routes: GET /v1/tasks/:id.',
    );
  });

  it('replaces id-like path segments', () => {
    expect(
      routePattern('/v1/p/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/files/abcdefghijklmnopqrstuvwxyz'),
    ).toBe('/v1/p/:id/files/:id');
  });
});
