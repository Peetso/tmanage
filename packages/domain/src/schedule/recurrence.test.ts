import { describe, expect, it } from 'vitest';
import { defaultWorkingCalendar } from '../calendar/working-calendar.js';
import {
  occurrencesOf,
  parseRecurrence,
  RecurrenceValidationError,
  toRRule,
} from './recurrence.js';
import type { RecurrenceHolidayPolicy } from './recurrence.js';

// UNIT 53-T-23. Sun–Thu company; 2026-11-04 is a Wednesday.
const cal = defaultWorkingCalendar('Asia/Riyadh', ['2026-11-08']);
const dates = (rrule: string, start: string, n: number, policy: RecurrenceHolidayPolicy = 'keep') =>
  occurrencesOf(parseRecurrence(rrule, start), start, n, cal, policy).map((o) => o.date);

describe('53-09 recurrence', () => {
  it('every Sunday set on Wednesday is next Sunday; month day 31 clamps; 1st Monday', () => {
    expect(dates('FREQ=WEEKLY;BYDAY=SU', '2026-11-04', 1)).toEqual(['2026-11-08']);
    expect(dates('FREQ=MONTHLY;BYMONTHDAY=31', '2027-01-31', 2)).toEqual([
      '2027-02-28',
      '2027-03-31',
    ]);
    expect(dates('FREQ=MONTHLY;BYDAY=1MO', '2026-11-04', 1)).toEqual(['2026-12-07']);
    expect(toRRule(parseRecurrence('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1', '2026-11-04'))).toBe(
      'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1',
    );
  });

  it('holiday: skip drops it, next_working_day moves it; COUNT exhausts', () => {
    expect(dates('FREQ=WEEKLY;BYDAY=SU', '2026-11-04', 1, 'skip')).toEqual(['2026-11-15']);
    expect(dates('FREQ=WEEKLY;BYDAY=SU', '2026-11-04', 1, 'next_working_day')).toEqual([
      '2026-11-09',
    ]);
    expect(dates('FREQ=DAILY;COUNT=3', '2026-11-03', 10)).toEqual(['2026-11-04', '2026-11-05']);
  });

  it('refuses BYSECOND, COUNT 366 and INTERVAL 53', () => {
    for (const bad of ['FREQ=DAILY;BYSECOND=1', 'FREQ=DAILY;COUNT=366', 'FREQ=DAILY;INTERVAL=53']) {
      expect(() => parseRecurrence(bad, '2026-11-04')).toThrow(RecurrenceValidationError);
    }
  });
});
