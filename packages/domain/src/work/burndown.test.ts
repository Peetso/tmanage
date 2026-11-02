import { describe, expect, it } from 'vitest';
import { defaultWorkingCalendar } from '../calendar/working-calendar.js';
import {
  burndown,
  isFibonacciPoint,
  isFinishedWorkItemState,
  isValidPointValue,
  iterationStatusOn,
  nextFreeSlot,
  workingDaysLeft,
} from './burndown.js';

// UNIT-53-40. Sun–Thu company in Riyadh (UTC+3, no DST).
const riyadh = defaultWorkingCalendar('Asia/Riyadh');

describe('burndown', () => {
  // 2026-11-01 is a Sunday.
  const iteration = { startsOn: '2026-11-01', endsOn: '2026-11-05' };

  it('grows scope on a mid-iteration add and drops at the org-local day of completion', () => {
    const points = burndown({
      iteration,
      calendar: riyadh,
      items: [
        { points: 5, assignedAt: null, completedAt: null },
        // Completed 23:30 Riyadh on Mon 11-02 (= 20:30Z): counts as done on the 2nd, not the 3rd.
        { points: 3, assignedAt: null, completedAt: new Date('2026-11-02T20:30:00Z') },
        // Added Tue 11-03 at 01:00 Riyadh (= Mon 22:00Z): scope grows on the 3rd, not the 2nd.
        { points: 2, assignedAt: new Date('2026-11-02T22:00:00Z'), completedAt: null },
        // No points: one item, zero points.
        { points: null, assignedAt: null, completedAt: null },
      ],
    });
    expect(points.map((p) => p.date)).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
    ]);
    expect(points[0]).toMatchObject({ scope: 8, scopeItems: 3, remainingPoints: 8 });
    expect(points[1]).toMatchObject({ scope: 8, remainingPoints: 5, remainingItems: 2 });
    expect(points[2]).toMatchObject({ scope: 10, scopeItems: 4, remainingPoints: 7 });
    expect(points.every((p) => p.workingDay)).toBe(true);
  });

  it('flags non-working days and refuses an inverted range', () => {
    const week = burndown({
      iteration: { startsOn: '2026-11-05', endsOn: '2026-11-07' },
      calendar: riyadh,
      items: [],
    });
    expect(week.map((p) => p.workingDay)).toEqual([true, false, false]);
    expect(
      burndown({
        iteration: { startsOn: '2026-11-05', endsOn: '2026-11-01' },
        calendar: riyadh,
        items: [],
      }),
    ).toEqual([]);
  });
});

describe('next free slot, status, days left, points', () => {
  it('starts on the first working day after the last end and runs ten working days', () => {
    // Last iteration ends Thu 11-05; Fri/Sat are off, so the next starts Sun 11-08.
    const slot = nextFreeSlot(
      [{ startsOn: '2026-10-25', endsOn: '2026-11-05' }],
      riyadh,
      '2026-11-01',
    );
    expect(slot).toEqual({ startsOn: '2026-11-08', endsOn: '2026-11-19' });
    // None yet, today a Friday: the first working day on or after today.
    expect(nextFreeSlot([], riyadh, '2026-11-06').startsOn).toBe('2026-11-08');
  });

  it('derives status and working days left', () => {
    const it1 = { startsOn: '2026-11-01', endsOn: '2026-11-12' };
    expect(iterationStatusOn(it1, '2026-10-30')).toBe('planned');
    expect(iterationStatusOn(it1, '2026-11-12')).toBe('active');
    expect(iterationStatusOn(it1, '2026-11-13')).toBe('ended');
    expect(iterationStatusOn({ ...it1, status: 'completed' }, '2026-11-02')).toBe('completed');
    expect(workingDaysLeft(it1, riyadh, '2026-11-05')).toBe(6);
    expect(workingDaysLeft(it1, riyadh, '2026-11-20')).toBe(0);
  });

  it('accepts Fibonacci chips and any whole number 0..100', () => {
    expect(isFibonacciPoint(8)).toBe(true);
    expect(isFibonacciPoint(4)).toBe(false);
    expect(isValidPointValue(4)).toBe(true);
    expect(isValidPointValue(101)).toBe(false);
    expect(isValidPointValue(2.5)).toBe(false);
    expect(isFinishedWorkItemState('done')).toBe(true);
    expect(isFinishedWorkItemState('blocked')).toBe(false);
  });
});
