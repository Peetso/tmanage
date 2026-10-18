import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { MAX_CALENDAR_RANGE_DAYS, parseCalendarRange } from './calendar-range.js';

function failure(from: unknown, to: unknown): ApiError {
  try {
    parseCalendarRange(from, to);
  } catch (error) {
    if (error instanceof ApiError) return error;
  }
  throw new Error('expected a 400');
}

describe('parseCalendarRange (WK-05 custom From/To)', () => {
  it('accepts a custom range across months, both ends inclusive', () => {
    expect(parseCalendarRange('2026-08-12', '2026-09-03')).toEqual({
      from: '2026-08-12',
      to: '2026-09-03',
    });
    expect(parseCalendarRange('2026-10-18', '2026-10-18')).toEqual({
      from: '2026-10-18',
      to: '2026-10-18',
    });
  });

  it('refuses a day that does not exist, which Date.parse would roll over', () => {
    const error = failure('2026-02-31', '2026-03-05');
    expect(error.status).toBe(400);
    expect(error.details).toEqual([{ field: 'from', message: 'must be a YYYY-MM-DD date' }]);
  });

  it('refuses missing values, a reversed range and a range wider than the cap', () => {
    expect(failure(undefined, '2026-01-01').details?.[0]?.field).toBe('from');
    expect(failure('2026-09-03', '2026-08-12').details).toEqual([
      { field: 'to', message: 'must be on or after from' },
    ]);
    // 2024 is a leap year: 1 Jan to 31 Dec is exactly the cap; one day more is refused.
    expect(parseCalendarRange('2024-01-01', '2024-12-31').to).toBe('2024-12-31');
    expect(MAX_CALENDAR_RANGE_DAYS).toBe(366);
    expect(failure('2024-01-01', '2025-01-01').details?.[0]?.message).toContain('366 days');
  });
});
