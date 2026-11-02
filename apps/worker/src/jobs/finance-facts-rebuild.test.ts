import { describe, expect, it } from 'vitest';
import {
  financeFactsDue,
  financeFactsWindow,
  runFinanceFactsRebuild,
} from './finance-facts-rebuild.js';

describe('52-14 finance facts loop', () => {
  it('is due on boot, after 26 h, and once past 02:30 UTC; the window is 90 days', () => {
    const now = new Date('2026-11-02T02:45:00Z');
    expect(financeFactsDue(null, now)).toBe(true);
    expect(financeFactsDue(new Date('2026-11-01T02:31:00Z'), now)).toBe(true);
    expect(financeFactsDue(new Date('2026-11-02T02:31:00Z'), now)).toBe(false);
    expect(financeFactsWindow(now)).toEqual({ from: '2026-08-05', to: '2026-11-02' });
  });

  it('rebuilds every organization in its own call; one failure does not stop the rest', async () => {
    const seen: string[] = [];
    const result = await runFinanceFactsRebuild(
      {
        store: {
          lastComputedAt: async () => null,
          organizations: async () => ['o1', 'o2', 'o3'],
          rebuild: async (org) => {
            seen.push(org);
            if (org === 'o2') throw new Error('boom');
            return 4;
          },
        },
        now: () => new Date('2026-11-02T03:00:00Z'),
      },
      () => undefined,
    );
    expect(seen).toEqual(['o1', 'o2', 'o3']);
    expect(result).toEqual({ organizations: 3, rows: 8, failed: 1 });
  });
});
