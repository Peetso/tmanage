import { describe, expect, it } from 'vitest';
import { defaultWorkingCalendar, maskOfWeekdays } from '@tmanage/domain';
import { isCalendarHoldReleased, isHeldByCalendar } from './due-soon-sweeper.js';
import { heldReleaseNote } from './weekend-hold-calendar.js';

/** 53-02 — the weekend hold reads the company calendar; no row keeps the Fri–Sat rule. */

const FRIDAY_NOON = new Date('2026-10-23T09:00:00Z'); // 12:00 Riyadh
const SUNDAY_7 = new Date('2026-10-25T04:00:00Z'); // 07:00 Riyadh
const MONDAY_10 = new Date('2026-10-26T07:00:00Z'); // 10:00 Riyadh

describe('calendar-aware weekend hold', () => {
  it('falls back to Friday–Saturday when the company saved no calendar', () => {
    expect(isHeldByCalendar(null, FRIDAY_NOON, 'Asia/Riyadh')).toBe(true);
    expect(isCalendarHoldReleased(null, SUNDAY_7, 'Asia/Riyadh')).toBe(false);
  });

  it('holds on a Mon–Fri company’s Sunday and a holiday, releases from day start', () => {
    const monFri = {
      ...defaultWorkingCalendar('Asia/Riyadh', ['2026-10-26']),
      workingDaysMask: maskOfWeekdays([1, 2, 3, 4, 5]),
    };
    expect(isHeldByCalendar(monFri, FRIDAY_NOON, 'UTC')).toBe(false);
    expect(isHeldByCalendar(monFri, SUNDAY_7, 'UTC')).toBe(true);
    expect(isHeldByCalendar(monFri, MONDAY_10, 'UTC')).toBe(true); // imported holiday
    const noHoliday = { ...monFri, holidays: new Set<string>() };
    expect(isCalendarHoldReleased(noHoliday, MONDAY_10, 'UTC')).toBe(true);
  });

  it('names the real release day, not always Sunday morning (R15)', () => {
    const monFri = {
      ...defaultWorkingCalendar('Asia/Riyadh'),
      workingDaysMask: maskOfWeekdays([1, 2, 3, 4, 5]),
    };
    expect(heldReleaseNote(monFri, MONDAY_10, 'UTC')).toBe(' on Monday, the next working day');
    expect(heldReleaseNote(null, SUNDAY_7, 'Asia/Riyadh')).toBe(
      ' on Sunday morning, after the weekend',
    );
    expect(heldReleaseNote(null, MONDAY_10, 'Asia/Riyadh')).toBe(' on Monday, after the weekend');
  });
});
