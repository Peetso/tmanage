import { describe, expect, it } from 'vitest';
import {
  purgeSecurityReports,
  securityReportCutoff,
  type SecurityReportPurgeStore,
} from './security-report-purge.js';

const now = () => new Date('2026-10-31T12:00:00.000Z');
const report = (i: number, createdAt: string) => ({ id: String(i).padStart(4, '0'), createdAt });

function fake(rows: { id: string; createdAt: string }[]) {
  const audits: number[] = [];
  const batches: number[] = [];
  const store: SecurityReportPurgeStore = {
    listExpired: async (cutoff, after, limit) =>
      rows
        .filter((r) => new Date(r.createdAt) < cutoff && r.id > (after ?? ''))
        .slice(0, limit)
        .map((r) => r.id),
    deleteExpired: async (ids) => (batches.push(ids.length), ids.length),
    audit: async (deleted) => void audits.push(deleted),
  };
  return { store, audits, batches };
}

describe('security report purge (56-17 follow-up)', () => {
  it('deletes only rows older than 24 months, in capped batches, with one count-only audit', async () => {
    const old = Array.from({ length: 7 }, (_, i) => report(i, '2024-10-30T00:00:00Z'));
    const { store, audits, batches } = fake([...old, report(9, '2024-11-01T00:00:00Z')]);
    const result = await purgeSecurityReports({ store, now, batch: 3, maxBatches: 2 });
    expect(securityReportCutoff(now()).toISOString()).toBe('2024-10-31T12:00:00.000Z');
    expect(batches).toEqual([3, 3]);
    expect(result).toMatchObject({ deleted: 6, capped: true });
    expect(audits).toEqual([6]);
  });

  it('writes a zero count and no error when nothing is due', async () => {
    const { store, audits } = fake([report(1, '2026-01-01T00:00:00Z')]);
    expect(await purgeSecurityReports({ store, now })).toMatchObject({ deleted: 0, capped: false });
    expect(audits).toEqual([0]);
  });
});
