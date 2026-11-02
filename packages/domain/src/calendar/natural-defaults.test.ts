import { describe, expect, it } from 'vitest';
import {
  dateFormatFor,
  isRequiredActionKind,
  kindDeliveryFor,
  medianLeadWorkingDays,
  notificationDefaultsFor,
  suggestDueDate,
  workWeekForTimezone,
} from './natural-defaults.js';
import { defaultWorkingCalendar, isWorkingDay, maskOfWeekdays } from './working-calendar.js';
import type { WorkingCalendar } from './working-calendar.js';

/** 55-07 / 55-18 natural defaults. 2026-10-21 is a Wednesday. */
const sunThu = defaultWorkingCalendar('Asia/Riyadh');
const monFri: WorkingCalendar = { ...sunThu, workingDaysMask: maskOfWeekdays([1, 2, 3, 4, 5]) };

describe('work week from the time zone', () => {
  it.each([
    ['Africa/Cairo', 'sun-thu'],
    ['Asia/Riyadh', 'sun-thu'],
    ['Asia/Dubai', 'sun-thu'],
    ['Europe/Berlin', 'mon-fri'],
    [undefined, 'mon-fri'],
  ])('%s -> %s', (zone, week) => {
    expect(workWeekForTimezone(zone)).toBe(week);
  });
});

describe('date format by locale and country', () => {
  it('long in Arabic, eu for English in the GCC/Egypt, else iso', () => {
    expect(dateFormatFor('ar-SA', 'SA')).toBe('long');
    expect(dateFormatFor('en-US', 'EG')).toBe('eu');
    expect(dateFormatFor('en-US', 'DE')).toBe('iso');
  });
});

describe('due-date suggestion', () => {
  it('is never on a non-working day and is clamped to 1..10 working days', () => {
    for (let m = 0; m <= 30; m += 1) {
      const { date } = suggestDueDate({
        today: '2026-10-21',
        calendar: monFri,
        medianLeadWorkingDays: m,
      });
      expect(isWorkingDay(date, monFri)).toBe(true);
    }
    // 0 clamps to 1: Wed -> Thu; 50 clamps to 10: Wed + 10 Mon–Fri days -> Wed 2026-11-04.
    expect(
      suggestDueDate({ today: '2026-10-21', calendar: monFri, medianLeadWorkingDays: 0 }).date,
    ).toBe('2026-10-22');
    expect(
      suggestDueDate({ today: '2026-10-21', calendar: monFri, medianLeadWorkingDays: 50 }).date,
    ).toBe('2026-11-04');
  });

  it('falls back to the next working day with no pace', () => {
    // Thursday in a Sun–Thu company -> Sunday.
    expect(
      suggestDueDate({ today: '2026-10-22', calendar: sunThu, medianLeadWorkingDays: null }),
    ).toEqual({
      date: '2026-10-25',
      reason: 'next_working_day',
    });
    expect(medianLeadWorkingDays([])).toBeNull();
    expect(medianLeadWorkingDays([5, 1, 3, 9])).toBe(4);
  });
});

describe('notification defaults by profile', () => {
  it('calm digests only non-required kinds; standard digests nothing', () => {
    const calm = notificationDefaultsFor('calm');
    expect(calm.digestFrequency).toBe('daily');
    expect(calm.quietHoursStart).toBe('19:00:00');
    for (const kind of calm.digestKinds) expect(isRequiredActionKind(kind)).toBe(false);
    for (const kind of ['client_request', 'mention', 'work_item']) {
      expect(kindDeliveryFor('calm', kind)).toBe('immediate');
    }
    expect(kindDeliveryFor('calm', 'message')).toBe('digest');
    expect(notificationDefaultsFor('standard').digestKinds).toEqual([]);
    expect(notificationDefaultsFor('standard').digestFrequency).toBe('off');
  });
});
