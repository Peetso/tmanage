import { describe, expect, it } from 'vitest';
import { GROWTH_STALE_MS } from '@tmanage/domain';
import { evaluateDeepHealth } from './deep-health.js';
import { growthCheckOf } from './growth-health.js';

const NOW = new Date('2026-11-20T12:00:00Z');

describe('growth deep-health reading (GROWTH-FIX)', () => {
  it('is stale when the figures were never computed or are past the window', () => {
    expect(growthCheckOf(null, NOW)).toBe('stale');
    expect(growthCheckOf(new Date(NOW.getTime() - GROWTH_STALE_MS - 1), NOW)).toBe('stale');
    expect(growthCheckOf(new Date(NOW.getTime() - 60_000), NOW)).toBe('ok');
  });

  it('reports stale growth figures without turning the answer into a 503', async () => {
    const report = await evaluateDeepHealth(
      { heartbeatMaxAgeSeconds: 900 },
      {
        readLedger: () => Promise.resolve([]),
        shippedVersions: () => Promise.resolve([]),
        readHeartbeat: () => Promise.resolve(null),
      },
      NOW,
      'not_configured',
      'not_configured',
      { state: 'not_configured' },
      'stale',
    );
    expect(report.checks.growth).toBe('stale');
    expect(report.status).toBe('ok');
  });
});
