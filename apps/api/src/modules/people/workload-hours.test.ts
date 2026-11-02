import { describe, expect, it } from 'vitest';
import { ALL_DAYS_MASK, defaultWorkingCalendar } from '@tmanage/domain';
import type { WorkingCalendar } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import {
  buildPersonLoad,
  capacityHours,
  roundHalf,
  spreadItemHours,
  weekBuckets,
} from './workload-hours.js';
import type { LoadAllocation, LoadItem } from './workload-hours.js';

/** Mon–Fri calendar (bits 1–5) so the maths reads plainly. 2026-11-02 is a Monday. */
const MON_FRI = 0b0111110;
function calendar(holidays: string[] = []): WorkingCalendar {
  return { ...defaultWorkingCalendar('UTC', holidays), workingDaysMask: MON_FRI };
}
const [W1, W2] = weekBuckets('2026-11-02', '2026-11-15') as [
  ReturnType<typeof weekBuckets>[number],
  ReturnType<typeof weekBuckets>[number],
];

function item(over: Partial<LoadItem> = {}): LoadItem {
  return {
    projectId: 'p1',
    readable: true,
    startOn: null,
    dueOn: null,
    estimateMinutes: 600,
    ...over,
  };
}

describe('workload-hours spread maths', () => {
  it('splits a 10 h item across two weeks by working days', () => {
    // Thu 5, Fri 6 (week 1) + Mon 9, Tue 10, Wed 11 (week 2): 2/5 and 3/5 of 10 h.
    const it10 = item({ startOn: '2026-11-05', dueOn: '2026-11-11' });
    expect(spreadItemHours(it10, W1, calendar())).toBeCloseTo(4);
    expect(spreadItemHours(it10, W2, calendar())).toBeCloseTo(6);
  });

  it('lands a due-only item whole in its due week; no dates or no estimate is 0', () => {
    expect(spreadItemHours(item({ dueOn: '2026-11-12' }), W2, calendar())).toBe(10);
    expect(spreadItemHours(item({ dueOn: '2026-11-12' }), W1, calendar())).toBe(0);
    expect(spreadItemHours(item(), W1, calendar())).toBe(0);
    expect(
      spreadItemHours(item({ dueOn: '2026-11-12', estimateMinutes: null }), W2, calendar()),
    ).toBe(0);
  });

  it('a holiday week shrinks capacity and time off removes its days', () => {
    expect(capacityHours(40, '2026-01-01', W1, calendar(), [])).toBe(40);
    expect(capacityHours(40, '2026-01-01', W1, calendar(['2026-11-04']), [])).toBe(32);
    expect(
      capacityHours(40, '2026-01-01', W1, calendar(), [
        { startsOn: '2026-11-05', endsOn: '2026-11-06' },
      ]),
    ).toBe(24);
    expect(capacityHours(40, '2027-01-01', W1, calendar(), [])).toBe(0);
    expect(
      capacityHours(70, '2026-01-01', W1, { ...calendar(), workingDaysMask: ALL_DAYS_MASK }, []),
    ).toBe(70);
  });
});

describe('buildPersonLoad', () => {
  const alloc = (over: Partial<LoadAllocation>): LoadAllocation => ({
    projectId: 'p1',
    readable: true,
    status: 'confirmed',
    percent: 50,
    hoursPerWeek: null,
    startDate: null,
    endDate: null,
    ...over,
  });

  it('keeps tentative apart from planned, buckets unreadable work without ids, and rounds to 0.5', () => {
    const load = buildPersonLoad({
      weeks: [W1],
      items: [
        item({ dueOn: '2026-11-03', estimateMinutes: 120 }),
        item({ projectId: 'secret', readable: false, dueOn: '2026-11-03', estimateMinutes: 100 }),
      ],
      allocations: [alloc({ percent: 25 }), alloc({ status: 'tentative', hoursPerWeek: 6 })],
      capacity: { weeklyHours: 40, effectiveFrom: '2026-01-01' },
      timeOff: [],
      calendar: calendar(),
    });
    const week = load.weeks[0]!;
    expect(week.capacityHours).toBe(40);
    expect(week.plannedHours).toBe(12); // 2 h item + 25 % of 40 h
    expect(week.tentativeHours).toBe(6);
    expect(week.otherProjectsHours).toBe(1.5); // 100 min = 1.67 h → 1.5
    expect(week.overBy).toBe(0);
    expect(week.projects).toEqual([{ projectId: 'p1', hours: 12 }]);
    expect(JSON.stringify(load)).not.toContain('secret');
  });

  it('reports overBy when planned exceeds capacity', () => {
    const load = buildPersonLoad({
      weeks: [W1],
      items: [],
      allocations: [alloc({ hoursPerWeek: 45 })],
      capacity: { weeklyHours: 40, effectiveFrom: '2026-01-01' },
      timeOff: [],
      calendar: calendar(),
    });
    expect(load.weeks[0]!.overBy).toBe(5);
    expect(roundHalf(1.74)).toBe(1.5);
  });

  it('refuses a 27-week window with 400 window_too_long', () => {
    expect(weekBuckets('2026-11-02', '2027-04-30')).toHaveLength(26);
    try {
      weekBuckets('2026-11-02', '2027-05-03');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(400);
      expect((error as ApiError).auditCode).toBe('window_too_long');
    }
  });
});
