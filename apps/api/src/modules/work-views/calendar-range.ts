import { ApiError } from '../../common/http/errors.js';

/** A calendar range is bounded by `YYYY-MM-DD` date-only strings; the day is the calendar bucket. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The widest window one calendar read may ask for, both ends inclusive: a year, leap day
 * included. The screen's custom From/To range lets a caller type any two days; without a bound a
 * single request would walk every dated item the project has ever had.
 */
export const MAX_CALENDAR_RANGE_DAYS = 366;

const MS_PER_DAY = 86_400_000;

/**
 * A real calendar day, or `undefined`. `Date.parse` alone is lenient — it reads `2026-02-31` as
 * 3 March — so the parsed instant must print back as the same string.
 */
function parseDay(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !DATE_ONLY.test(raw)) return undefined;
  const ms = Date.parse(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== raw) return undefined;
  return raw;
}

/**
 * Validate the WK-05 calendar's `from`/`to` query values: both required real `YYYY-MM-DD` days,
 * `to` on or after `from`, and at most {@link MAX_CALENDAR_RANGE_DAYS} days inclusive. Every
 * problem is collected into one 400 `validation_failed` before any read runs.
 */
export function parseCalendarRange(from: unknown, to: unknown): { from: string; to: string } {
  const details: { field: string; message: string }[] = [];
  const parsedFrom = parseDay(from);
  const parsedTo = parseDay(to);
  if (!parsedFrom) details.push({ field: 'from', message: 'must be a YYYY-MM-DD date' });
  if (!parsedTo) details.push({ field: 'to', message: 'must be a YYYY-MM-DD date' });
  if (parsedFrom && parsedTo) {
    const span = (Date.parse(parsedTo) - Date.parse(parsedFrom)) / MS_PER_DAY + 1;
    if (span < 1) {
      details.push({ field: 'to', message: 'must be on or after from' });
    } else if (span > MAX_CALENDAR_RANGE_DAYS) {
      details.push({
        field: 'to',
        message: `must be within ${MAX_CALENDAR_RANGE_DAYS} days of from`,
      });
    }
  }
  if (details.length > 0 || !parsedFrom || !parsedTo) {
    throw new ApiError(400, 'validation_failed', 'The date range is invalid', details);
  }
  return { from: parsedFrom, to: parsedTo };
}
