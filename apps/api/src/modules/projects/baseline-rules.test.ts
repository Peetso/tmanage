import { describe, expect, it } from 'vitest';
import { defaultWorkingCalendar } from '@tmanage/domain';
import { durationWorkingDays, rowStatus, varianceOf } from './baseline-rules.js';

/** UNIT 53-T-11 — working-day variance over the Fri–Sat weekend and a holiday. */
const calendar = defaultWorkingCalendar('UTC', ['2026-11-10']);
const plain = defaultWorkingCalendar('UTC');

describe('baseline-rules (53-T-11)', () => {
  it('counts a 5-day slip over a Fri–Sat weekend as +3 working days, and a holiday as none', () => {
    // Thu 2026-11-05 -> Tue 2026-11-10: Thu, Sun, Mon work; Fri and Sat do not.
    const thuToTue = { startAt: null, dueAt: '2026-11-10' };
    expect(varianceOf({ startAt: null, dueAt: '2026-11-05' }, thuToTue, plain)).toEqual({
      deltaWorkingDays: 3,
      status: 'slipped',
    });
    // Pulled in from Wed 2026-11-11 to Mon 2026-11-09 across the Tue 11-10 holiday: -1.
    expect(
      varianceOf(
        { startAt: null, dueAt: '2026-11-11' },
        { startAt: null, dueAt: '2026-11-09' },
        calendar,
      ),
    ).toEqual({ deltaWorkingDays: -1, status: 'early' });
    expect(durationWorkingDays('2026-11-08', '2026-11-12', calendar)).toBe(4);
  });

  it('marks removed and added items, and falls back to start dates', () => {
    const d = { startAt: '2026-11-08', dueAt: null };
    expect(rowStatus(d, null, plain).status).toBe('removed');
    expect(rowStatus(null, d, plain).status).toBe('added');
    expect(rowStatus(d, d, plain)).toEqual({ deltaWorkingDays: 0, status: 'on_track' });
  });
});
