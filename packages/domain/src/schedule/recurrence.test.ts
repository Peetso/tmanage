import { describe, expect, it } from 'vitest';
import { defaultWorkingCalendar, localDateOf, zonedInstant } from '../calendar/working-calendar.js';
import {
  occurrencesOf,
  parseRecurrence,
  RecurrenceValidationError,
  ruleForEdit,
  scheduledBefore,
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

  it('month end: day 31 clamps to Feb 29 in a leap year; -1 is the last day; last Friday', () => {
    expect(dates('FREQ=MONTHLY;BYMONTHDAY=31', '2028-01-31', 3)).toEqual([
      '2028-02-29',
      '2028-03-31',
      '2028-04-30',
    ]);
    expect(dates('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-11-04', 2)).toEqual([
      '2026-11-30',
      '2026-12-31',
    ]);
    expect(dates('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1', '2026-11-04', 2)).toEqual([
      '2026-11-27',
      '2026-12-25',
    ]);
  });

  it('every 2 weeks on Sunday and Wednesday', () => {
    expect(dates('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,WE', '2026-11-01', 4)).toEqual([
      '2026-11-04',
      '2026-11-15',
      '2026-11-18',
      '2026-11-29',
    ]);
  });

  it('DST: civil dates keep their weekday and the local time across the clock change', () => {
    const ny = defaultWorkingCalendar('America/New_York');
    const rule = parseRecurrence('FREQ=WEEKLY;BYDAY=SU', '2026-03-01');
    const days = occurrencesOf(rule, '2026-03-01', 2, ny, 'keep').map((o) => o.date);
    expect(days).toEqual(['2026-03-08', '2026-03-15']);
    const at = days.map((d) => zonedInstant(d, 9 * 60, 'America/New_York').toISOString());
    expect(at).toEqual(['2026-03-08T13:00:00.000Z', '2026-03-15T13:00:00.000Z']);
    expect(zonedInstant('2026-03-01', 9 * 60, 'America/New_York').toISOString()).toBe(
      '2026-03-01T14:00:00.000Z',
    );
    expect(localDateOf(new Date('2026-03-08T04:30:00Z'), 'America/New_York')).toBe('2026-03-07');
  });

  it('edit "this and future" re-anchors and keeps what is left of COUNT; "all" keeps the start', () => {
    const before = parseRecurrence('FREQ=DAILY;COUNT=10', '2026-11-01');
    expect(scheduledBefore(before, '2026-11-04')).toBe(3);
    const edited = parseRecurrence('FREQ=DAILY;INTERVAL=2;COUNT=10', '2026-11-04');
    const future = ruleForEdit(edited, before, 'this_and_future', '2026-11-04');
    expect(future.start).toBe('2026-11-04');
    expect(future.count).toBe(7);
    expect(ruleForEdit(edited, before, 'all', '2026-11-04').start).toBe('2026-11-01');
    const late = parseRecurrence('FREQ=DAILY;UNTIL=20261102', '2026-11-01');
    expect(() => ruleForEdit(late, before, 'this_and_future', '2026-11-04')).toThrow(
      RecurrenceValidationError,
    );
  });
});
