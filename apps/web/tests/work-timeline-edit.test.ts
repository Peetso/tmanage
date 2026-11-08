import { describe, expect, it } from 'vitest';
import {
  daysForTravel,
  milestoneMove,
  shiftSchedule,
  slipDays,
  stepForKey,
} from '../src/components/screens/work-timeline-edit';

const row = { startAt: '2026-11-03T00:00:00.000Z', dueAt: '2026-11-06T00:00:00.000Z' };

describe('53-03 editable Gantt date rules', () => {
  it('moves both ends and resizes one end without crossing the other', () => {
    expect(shiftSchedule(row, 'move', 2)).toEqual({
      startAt: '2026-11-05T00:00:00.000Z',
      dueAt: '2026-11-08T00:00:00.000Z',
    });
    expect(shiftSchedule(row, 'end', -10).dueAt).toBe(row.startAt);
    expect(shiftSchedule(row, 'start', 10).startAt).toBe(row.dueAt);
    expect(shiftSchedule({ startAt: null, dueAt: null }, 'move', 3)).toEqual({
      startAt: null,
      dueAt: null,
    });
  });

  it('maps keys to steps, a week with Shift, the end with Alt, mirrored right to left', () => {
    expect(stepForKey('ArrowRight', { shift: false, alt: false, rtl: false })).toEqual({
      mode: 'move',
      days: 1,
    });
    expect(stepForKey('ArrowLeft', { shift: true, alt: false, rtl: false })).toEqual({
      mode: 'move',
      days: -7,
    });
    expect(stepForKey('ArrowLeft', { shift: false, alt: true, rtl: true })).toEqual({
      mode: 'end',
      days: 1,
    });
    expect(stepForKey('Enter', { shift: false, alt: false, rtl: false })).toBeNull();
  });

  it('turns pointer travel into whole days on the axis direction', () => {
    expect(daysForTravel(100, 700, 56, false)).toBe(8);
    expect(daysForTravel(100, 700, 56, true)).toBe(-8);
    expect(daysForTravel(1, 700, 56, false)).toBe(0);
  });

  it('writes the field a diamond is drawn from, and measures slip', () => {
    const base = { committedOn: null, forecastOn: '2026-11-10', date: '2026-11-10' };
    expect(milestoneMove(base, 3)).toEqual({ field: 'forecastOn', date: '2026-11-13' });
    expect(milestoneMove({ ...base, committedOn: '2026-11-10' }, -1)?.field).toBe('committedOn');
    expect(milestoneMove({ committedOn: null, forecastOn: null, date: null }, 1)).toBeNull();
    expect(slipDays('2026-11-06', '2026-11-13T00:00:00.000Z')).toBe(7);
  });
});
