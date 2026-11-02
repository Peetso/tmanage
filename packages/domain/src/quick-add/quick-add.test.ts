import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isWorkingDay, maskOfWeekdays } from '../calendar/working-calendar.js';
import type { WorkingCalendar } from '../calendar/working-calendar.js';
import { parseQuickAdd } from './parse.js';
import type { QuickAddToken } from './parse.js';

/** 55-25 — the 200-case fixture (EN 100, AR 100). Acceptance: ≥ 95 % of cases parse exactly. */
interface Fixture {
  readonly people: readonly string[];
  readonly projects: readonly string[];
  readonly calendars: Record<string, { workingDays: number[]; holidays: string[] }>;
  readonly cases: readonly {
    id: string;
    text: string;
    today: string;
    calendar: string;
    title: string;
    expect: Partial<Record<QuickAddToken['kind'], string | number>>;
  }[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./cases.json', import.meta.url), 'utf8'),
) as Fixture;

function calendarOf(key: string): WorkingCalendar {
  const spec = fixture.calendars[key];
  if (!spec) throw new Error(`unknown calendar ${key}`);
  return {
    workingDaysMask: maskOfWeekdays(spec.workingDays),
    dayStart: '09:00',
    dayEnd: '17:00',
    timeZone: 'Asia/Riyadh',
    holidays: new Set(spec.holidays),
  };
}

describe('parseQuickAdd — fixture', () => {
  it('parses at least 95 % of the 200 cases exactly, and never dates a non-working day', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(200);
    const failures: string[] = [];
    for (const c of fixture.cases) {
      const calendar = calendarOf(c.calendar);
      const result = parseQuickAdd(c.text, {
        today: c.today,
        calendar,
        people: fixture.people,
        projects: fixture.projects,
      });
      const got: Record<string, string | number> = {};
      for (const token of result.tokens) got[token.kind] = token.value;
      const date = got['date'];
      if (typeof date === 'string') expect(isWorkingDay(date, calendar), c.id).toBe(true);
      const same =
        result.title === c.title &&
        JSON.stringify(sorted(got)) === JSON.stringify(sorted(c.expect));
      if (!same) {
        failures.push(
          `${c.id} ${JSON.stringify(c.text)} → ${JSON.stringify(result.title)} ${JSON.stringify(got)}`,
        );
      }
    }
    const accuracy = 1 - failures.length / fixture.cases.length;
    expect(accuracy, `failures:\n${failures.join('\n')}`).toBeGreaterThanOrEqual(0.95);
  });
});

function sorted(record: Record<string, unknown>): [string, unknown][] {
  return Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
}
