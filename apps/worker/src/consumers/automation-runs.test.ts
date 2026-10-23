import { describe, expect, it } from 'vitest';
import { isHeldForWeekend } from './automation-runs.js';

/**
 * A14 — "Skip weekends" on the automation rule page. The studio week ends on Friday and Saturday,
 * so a rule with the option on holds its reminder on those two days and sends it on every other.
 */
describe('isHeldForWeekend', () => {
  // 2026-10-19 is a Monday; the next six days run Tuesday … Sunday.
  const week = [19, 20, 21, 22, 23, 24, 25].map((day) => new Date(Date.UTC(2026, 9, day, 9)));

  it('holds only Friday and Saturday when the rule skips weekends', () => {
    expect(week.map((at) => isHeldForWeekend(true, at))).toEqual([
      false, // Monday
      false, // Tuesday
      false, // Wednesday
      false, // Thursday
      true, // Friday
      true, // Saturday
      false, // Sunday
    ]);
  });

  it('never holds a reminder when the option is off', () => {
    expect(week.some((at) => isHeldForWeekend(false, at))).toBe(false);
  });
});
