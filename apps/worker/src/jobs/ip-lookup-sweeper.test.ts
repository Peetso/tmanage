import { expect, it } from 'vitest';
import { sweepIpLookups, type IpLookupSweepStore } from './ip-lookup-sweeper.js';

it('R12 IP-cache sweep removes only rows unseen past the retention, in batches', async () => {
  const seen = ['2025-09-01', '2025-09-20', '2025-09-27', '2026-10-01'].map((d) => new Date(d));
  const cutoffs: Date[] = [];
  const store: IpLookupSweepStore = {
    deleteUnseenSince: async (cutoff, limit) => {
      cutoffs.push(cutoff);
      const old = seen.filter((at) => at < cutoff).slice(0, limit);
      old.forEach((at) => seen.splice(seen.indexOf(at), 1));
      return old.length;
    },
  };
  const now = () => new Date('2026-10-31T00:00:00Z');
  const result = await sweepIpLookups({ store, now, retentionDays: 400, batch: 2 });
  expect([result.deleted, result.capped, cutoffs.length]).toEqual([2, false, 2]);
  expect(result.cutoff).toBe('2025-09-26T00:00:00.000Z');
  expect(seen.map((at) => at.toISOString().slice(0, 10))).toEqual(['2025-09-27', '2026-10-01']);
});
