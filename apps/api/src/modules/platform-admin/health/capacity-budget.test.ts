import { describe, expect, it } from 'vitest';
import {
  DailyRedAlertGate,
  GAUGE_KEYS,
  PLANNING_PROFILE,
  gauge,
  gaugeColour,
  parseHostProfile,
  redStreakDays,
} from './capacity-budget.js';
import type { CapacityReading, HostProfile } from './capacity-budget.js';

/** A profile with every ceiling 100, so a value is its own percent. */
const HUNDRED: HostProfile = {
  ...PLANNING_PROFILE,
  ramMb: 100,
  loopLagMs: 100,
  sockets: 100,
  inodes: 100,
  diskMb: 100,
  dbConnections: 100,
};

function nightly(day: number, value: number): CapacityReading {
  return {
    takenAt: new Date(Date.UTC(2026, 9, 30 - day, 3, 30)),
    source: 'nightly',
    rssMb: value,
    heapMb: 10,
    loopLagMs: 5,
    sockets: 5,
    inodes: 5,
    diskMb: 5,
    dbMb: 5,
    dbConnections: 5,
  };
}

describe('capacity budget', () => {
  it('colours every one of the six lines green < 60 %, amber < 80 %, red beyond (59/60/79/80)', () => {
    for (const key of GAUGE_KEYS) {
      expect(
        [59, 60, 79, 80].map((v) => gauge(key, v, HUNDRED).colour),
        key,
      ).toEqual(['green', 'amber', 'amber', 'red']);
    }
    expect(gaugeColour(59.9)).toBe('green');
  });

  it('reports each line against its own budget (RAM 60 %, inodes 50 %, DB connections 70 %)', () => {
    expect(gauge('ram', 600, { ...PLANNING_PROFILE, ramMb: 1000 })).toMatchObject({
      percent: 60,
      budgetPercent: 60,
      withinBudget: true,
    });
    expect(gauge('inodes', 51, HUNDRED).withinBudget).toBe(false);
    expect(gauge('db_connections', 70, HUNDRED).withinBudget).toBe(true);
    expect(gauge('loop_lag', 101, PLANNING_PROFILE).withinBudget).toBe(false);
  });

  it('falls back to the planning values field by field, and marks the source', () => {
    expect(parseHostProfile(null)).toBe(PLANNING_PROFILE);
    expect(parseHostProfile('{not json')).toBe(PLANNING_PROFILE);
    const profile = parseHostProfile('{"ramMb":1536,"inodes":0,"plan":"Business"}');
    expect(profile).toMatchObject({
      ramMb: 1536,
      inodes: 400_000,
      plan: 'Business',
      source: 'settings',
    });
  });

  it('counts consecutive red daily readings, newest first, and the trigger needs 7', () => {
    const seven = Array.from({ length: 7 }, (_, d) => nightly(d, 90));
    expect(redStreakDays(HUNDRED, seven)).toBe(7);
    expect(redStreakDays(HUNDRED, [...seven.slice(0, 6), nightly(6, 50)])).toBe(6);
    expect(redStreakDays(HUNDRED, [nightly(0, 50), ...seven.slice(1)])).toBe(0);
  });

  it('alerts once per UTC day per gauge', () => {
    const gate = new DailyRedAlertGate();
    const morning = new Date('2026-10-29T01:00:00Z');
    expect(gate.shouldAlert('ram', morning)).toBe(true);
    expect(gate.shouldAlert('ram', new Date('2026-10-29T23:59:00Z'))).toBe(false);
    expect(gate.shouldAlert('disk', morning)).toBe(true);
    expect(gate.shouldAlert('ram', new Date('2026-10-30T00:00:00Z'))).toBe(true);
  });
});
