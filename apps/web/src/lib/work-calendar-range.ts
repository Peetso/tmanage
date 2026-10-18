/**
 * WK-05 Work calendar — the window on screen.
 *
 * The calendar shows either a whole month (the default, moved by the previous/next controls) or a
 * custom `From`/`To` range the caller types. Both are the same `{ from, to }` pair of `YYYY-MM-DD`
 * days the API takes, and a custom range lives in the URL (`?from=&to=`) so it can be shared.
 * The rules here mirror the API's `parseCalendarRange`, so a range the screen accepts is one the
 * API accepts and the screen can say what is wrong before any request.
 */

export interface CalendarRange {
  readonly from: string;
  readonly to: string;
}

/** The API's cap: a year, leap day included, both ends inclusive. */
export const MAX_CALENDAR_RANGE_DAYS = 366;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;
/** The artboard's three-letter months ("1 Sep"); ICU's en-GB would print "Sept". */
const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function shortMonth(date: Date): string {
  return SHORT_MONTHS[date.getUTCMonth()] ?? '';
}

/** A real calendar day — `2026-02-31` is refused, although `Date.parse` would roll it over. */
export function isCalendarDay(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parse(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** The first and last day of a month (0-based `month`), as the API's range. */
export function monthRange(year: number, month: number): CalendarRange {
  return { from: day(Date.UTC(year, month, 1)), to: day(Date.UTC(year, month + 1, 0)) };
}

/** The month containing `now`, in UTC. */
export function currentMonthRange(now: Date): CalendarRange {
  return monthRange(now.getUTCFullYear(), now.getUTCMonth());
}

/**
 * The window to open on: the URL's `from`/`to` when both are present (validated separately, so a
 * bad link shows its problem instead of silently becoming this month), otherwise this month.
 */
export function initialCalendarRange(
  from: string | null | undefined,
  to: string | null | undefined,
  now: Date,
): CalendarRange {
  return from && to ? { from, to } : currentMonthRange(now);
}

/** What is wrong with a range, in words for the screen, or `null` when the API will accept it. */
export function calendarRangeProblem(range: CalendarRange): string | null {
  if (!isCalendarDay(range.from)) return 'Choose a valid From date.';
  if (!isCalendarDay(range.to)) return 'Choose a valid To date.';
  const span = (Date.parse(range.to) - Date.parse(range.from)) / MS_PER_DAY + 1;
  if (span < 1) return 'To must be on or after From.';
  if (span > MAX_CALENDAR_RANGE_DAYS) {
    return `A calendar range can cover at most ${MAX_CALENDAR_RANGE_DAYS} days.`;
  }
  return null;
}

/** Whether the range is exactly one calendar month — the month view rather than a custom range. */
export function isWholeMonth(range: CalendarRange): boolean {
  if (!isCalendarDay(range.from)) return false;
  const from = parse(range.from);
  const month = monthRange(from.getUTCFullYear(), from.getUTCMonth());
  return month.from === range.from && month.to === range.to;
}

/** The whole month `delta` months from the one `from` falls in — what previous/next move to. */
export function shiftCalendarMonth(range: CalendarRange, delta: number, now: Date): CalendarRange {
  const anchor = isCalendarDay(range.from) ? parse(range.from) : now;
  return monthRange(anchor.getUTCFullYear(), anchor.getUTCMonth() + delta);
}

/** "August 2026" for a whole month; "12 Aug – 3 Sep 2026" for a custom range. */
export function calendarRangeTitle(range: CalendarRange): string {
  if (!isCalendarDay(range.from) || !isCalendarDay(range.to)) return 'Calendar';
  const from = parse(range.from);
  const to = parse(range.to);
  if (isWholeMonth(range)) {
    return from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  const dayMonth = (date: Date) => `${date.getUTCDate()} ${shortMonth(date)}`;
  const year = to.getUTCFullYear();
  if (from.getUTCFullYear() !== year) {
    return `${dayMonth(from)} ${from.getUTCFullYear()} – ${dayMonth(to)} ${year}`;
  }
  if (range.from === range.to) return `${dayMonth(from)} ${year}`;
  const sameMonth = from.getUTCMonth() === to.getUTCMonth();
  return sameMonth
    ? `${from.getUTCDate()} – ${dayMonth(to)} ${year}`
    : `${dayMonth(from)} – ${dayMonth(to)} ${year}`;
}

export interface CalendarGridCell {
  readonly key: string;
  readonly day: number;
  readonly label: string;
  /** Inside the requested range; days padding the first and last week are drawn quietly. */
  readonly inRange: boolean;
}

/**
 * Whole weeks, Sunday first, covering the range — the artboard's grid. A day outside the range
 * pads its week; the first of a month is labelled "1 Sep" wherever it is not the plain first of
 * the single month on screen, so a range across months stays readable.
 */
export function calendarGrid(range: CalendarRange): CalendarGridCell[][] {
  if (calendarRangeProblem(range) !== null) return [];
  const first = parse(range.from);
  const last = parse(range.to);
  const start = Date.UTC(
    first.getUTCFullYear(),
    first.getUTCMonth(),
    first.getUTCDate() - first.getUTCDay(),
  );
  const end = Date.UTC(
    last.getUTCFullYear(),
    last.getUTCMonth(),
    last.getUTCDate() + 6 - last.getUTCDay(),
  );
  const wholeMonth = isWholeMonth(range);

  const weeks: CalendarGridCell[][] = [];
  let week: CalendarGridCell[] = [];
  for (let ms = start; ms <= end; ms += MS_PER_DAY) {
    const cursor = new Date(ms);
    const key = day(ms);
    const inRange = key >= range.from && key <= range.to;
    const dayOfMonth = cursor.getUTCDate();
    week.push({
      key,
      day: dayOfMonth,
      label:
        dayOfMonth === 1 && !(wholeMonth && inRange)
          ? `1 ${shortMonth(cursor)}`
          : String(dayOfMonth),
      inRange,
    });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  return weeks;
}
