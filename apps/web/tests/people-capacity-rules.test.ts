import { describe, expect, it } from 'vitest';
import {
  teamTotals,
  weekLoad,
} from '../src/components/screens/people-capacity/PeopleCapacityRules';
import type { CapacityRosterEntry } from '../src/components/screens/people-capacity/PeopleOverviewApi';

const member = (patch: Partial<CapacityRosterEntry>): CapacityRosterEntry => ({
  membershipId: 'm',
  userId: 'u',
  displayName: 'A',
  weeklyHours: 40,
  effectiveFrom: '2026-11-02',
  allocatedPercent: 50,
  tentativePercent: 0,
  awayThisWeek: false,
  ...patch,
});

describe('people capacity rules', () => {
  it('reads a week as away, unset, over, busy or room', () => {
    expect(weekLoad(member({ awayThisWeek: true, allocatedPercent: 120 }))).toBe('away');
    expect(weekLoad(member({ weeklyHours: null }))).toBe('unset');
    expect(weekLoad(member({ allocatedPercent: 110 }))).toBe('over');
    expect(weekLoad(member({ allocatedPercent: 80 }))).toBe('busy');
    expect(weekLoad(member({ allocatedPercent: 79 }))).toBe('room');
  });

  it('weights the team allocation by hours', () => {
    const totals = teamTotals([
      member({ weeklyHours: 40, allocatedPercent: 100 }),
      member({ weeklyHours: 20, allocatedPercent: 40, awayThisWeek: true }),
    ]);
    expect(totals).toEqual({ hours: 60, allocatedPercent: 80, away: 1 });
  });
});
