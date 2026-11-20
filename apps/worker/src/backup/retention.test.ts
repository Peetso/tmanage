import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OFFSITE_MAX_BYTES,
  FREE_TIER_BYTES,
  RETAIN_DAILY,
  RETAIN_WEEKLY,
  isoWeek,
  planRetention,
  stampOf,
} from './retention.js';
import type { OffsiteBackup } from './retention.js';

const NOW = new Date('2026-11-20T03:00:00Z');
const daysAgo = (d: number, hour = 3): string =>
  stampOf(new Date(Date.UTC(2026, 10, 20 - d, hour, 0, 0)));
const backup = (stamp: string, bytes = 1_000, complete = true): OffsiteBackup => ({
  stamp,
  bytes,
  complete,
});

describe('planRetention: 7 daily + 4 weekly, inside the free-tier budget', () => {
  it('keeps 7 dailies and the newest of each of 4 ISO weeks out of 60 days of backups', () => {
    const all = Array.from({ length: 60 }, (_, d) => backup(daysAgo(d)));
    const plan = planRetention(all, NOW);
    const dailies = Array.from({ length: RETAIN_DAILY }, (_, d) => daysAgo(d));
    for (const s of dailies) expect(plan.keep).toContain(s);
    const weeks = new Set(
      plan.keep.map((s) =>
        isoWeek(new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`)),
      ),
    );
    expect(weeks.size).toBe(RETAIN_WEEKLY);
    expect(plan.keep.length).toBeLessThanOrEqual(RETAIN_DAILY + RETAIN_WEEKLY);
    expect(plan.keep.length + plan.remove.length).toBe(60);
  });

  it('keeps only the newest backup of a day', () => {
    const plan = planRetention([backup(daysAgo(0, 3)), backup(daysAgo(0, 9))], NOW);
    expect(plan.keep).toEqual([daysAgo(0, 9)]);
    expect(plan.remove).toEqual([daysAgo(0, 3)]);
  });

  it('drops the oldest kept backups to fit the budget, never the newest', () => {
    const all = Array.from({ length: 7 }, (_, d) => backup(daysAgo(d), 4_000));
    const plan = planRetention(all, NOW, 10_000);
    expect(plan.keep).toEqual([daysAgo(0), daysAgo(1)]);
    expect(plan.keptBytes).toBe(8_000);
    const alone = planRetention([backup(daysAgo(0), 50_000)], NOW, 10_000);
    expect(alone.keep).toEqual([daysAgo(0)]);
  });

  it('removes an incomplete backup once it is a day old, and never counts it as kept', () => {
    const plan = planRetention(
      [backup(daysAgo(0)), backup(daysAgo(0, 1), 500, false), backup(daysAgo(2), 500, false)],
      NOW,
    );
    expect(plan.keep).toEqual([daysAgo(0)]);
    expect(plan.remove).toEqual([daysAgo(2)]);
  });

  it('never touches a key that is not a backup stamp', () => {
    const plan = planRetention([backup('notes'), backup(daysAgo(0))], NOW);
    expect(plan.remove).toEqual([]);
  });

  it('computes ISO weeks across a year boundary (Thursday rule)', () => {
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeek(new Date('2026-11-20T00:00:00Z'))).toBe('2026-W47');
  });

  it('the default budget leaves a quarter of the 20 GB free tier unused', () => {
    expect(DEFAULT_OFFSITE_MAX_BYTES).toBeLessThanOrEqual(FREE_TIER_BYTES * 0.75);
  });
});
