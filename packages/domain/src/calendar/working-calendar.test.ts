import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOLIDAY_PACKS, holidayPack } from './holiday-packs.js';
import {
  WorkingCalendarRangeError,
  addWorkingDays,
  defaultWorkingCalendar,
  hasWorkingDay,
  isWorkingDay,
  maskOfWeekdays,
  nextWorkingStart,
  nthWorkingDay,
  workingDaysBetween,
} from './working-calendar.js';
import type { WorkingCalendar } from './working-calendar.js';

/** 53-T-03 — working-day arithmetic. 2026-10-21 is a Wednesday. */
const WEDNESDAY = '2026-10-21';
const sunThu = defaultWorkingCalendar('Asia/Riyadh');
const monFri: WorkingCalendar = { ...sunThu, workingDaysMask: maskOfWeekdays([1, 2, 3, 4, 5]) };

describe('working-day arithmetic', () => {
  it('skips the Friday–Saturday weekend of a Sun–Thu company', () => {
    expect(isWorkingDay('2026-10-23', sunThu)).toBe(false); // Friday
    expect(isWorkingDay('2026-10-25', sunThu)).toBe(true); // Sunday
    expect(addWorkingDays(WEDNESDAY, 2, sunThu)).toBe('2026-10-25');
    expect(addWorkingDays('2026-10-25', -1, sunThu)).toBe('2026-10-22');
  });

  it('lands "due in 3 working days" from a Wednesday on Sunday in a Sun–Thu org', () => {
    expect(nthWorkingDay(WEDNESDAY, 3, sunThu)).toBe('2026-10-25');
    expect(nthWorkingDay(WEDNESDAY, 3, monFri)).toBe('2026-10-23');
  });

  it('skips an imported holiday', () => {
    const pack = holidayPack('ksa-2026');
    const calendar = defaultWorkingCalendar(
      'Asia/Riyadh',
      pack?.holidays.map((h) => h.date),
    );
    // Saudi National Day, Wednesday 2026-09-23: from Tuesday, the next working day is Thursday.
    expect(addWorkingDays('2026-09-22', 1, calendar)).toBe('2026-09-24');
    expect(workingDaysBetween('2026-09-20', '2026-09-27', calendar)).toBe(4);
  });

  it('refuses a week with no working day and stays inside the horizon', () => {
    expect(hasWorkingDay(0)).toBe(false);
    expect(hasWorkingDay(maskOfWeekdays([6]))).toBe(true);
    expect(() => addWorkingDays(WEDNESDAY, 1, { ...sunThu, workingDaysMask: 0 })).toThrow(
      WorkingCalendarRangeError,
    );
  });

  it('moves an instant outside working hours to the next working start, in the zone', () => {
    // Thursday 2026-10-22 18:00 Riyadh (15:00Z) → Sunday 09:00 Riyadh (06:00Z).
    const next = nextWorkingStart(new Date('2026-10-22T15:00:00Z'), sunThu);
    expect(next.toISOString()).toBe('2026-10-25T06:00:00.000Z');
  });
});

describe('holiday packs', () => {
  it('mirror the shipped JSON files exactly', () => {
    for (const [key, pack] of Object.entries(HOLIDAY_PACKS)) {
      const file = new URL(`./holiday-packs/${key}.json`, import.meta.url);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(pack);
    }
    expect(Object.keys(HOLIDAY_PACKS)).toHaveLength(6);
  });
});
