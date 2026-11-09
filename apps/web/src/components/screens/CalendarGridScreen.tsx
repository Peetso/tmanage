'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getCalendarGrid } from '../../lib/api/calendar-grid';
import type { CalendarGridDayRow, CalendarGridRange } from '../../lib/api/calendar-grid';
import { formatDay } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { appDateLocale } from '../../lib/i18n/app-locale';
import type { MessageKey } from '../../lib/i18n/t';
import { CalendarHeaderActions, CalendarSubnav } from './MeetingsScreen';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../../styles/screens/calendar.css';

export interface CalendarGridScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Week or month — the header switch links to `?range=`, and the page passes it here. */
  initialRange?: CalendarGridRange;
  client?: ApiClient;
}

const MS_PER_DAY = 86_400_000;
/** Weekday column headers, Monday-first, matching the server's Monday-based week. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Message key per weekday column header, so the heads translate with the active locale. */
const WEEKDAY_KEYS: Record<(typeof WEEKDAYS)[number], MessageKey> = {
  Mon: 'CalendarGridScreen.weekdayMon',
  Tue: 'CalendarGridScreen.weekdayTue',
  Wed: 'CalendarGridScreen.weekdayWed',
  Thu: 'CalendarGridScreen.weekdayThu',
  Fri: 'CalendarGridScreen.weekdayFri',
  Sat: 'CalendarGridScreen.weekdaySat',
  Sun: 'CalendarGridScreen.weekdaySun',
};

/**
 * **Calendar week/month grid (x212).**
 *
 * `38-MODULE-MAP` §Calendar (week/month grid, deferred after the x127 agenda). The read-only grid
 * over the tenant's meetings and recurrence series: a fixed week or month window whose every day is
 * a cell — including the empty ones a calendar draws — with the concrete meetings and the recurrence
 * occurrences that fall on each day. It complements `MeetingAgendaScreen` (a flat, day-grouped list)
 * with the two-dimensional grid the audit found missing.
 *
 * ## What it draws, and what it cannot
 *
 * - **The window is the server's.** `range` (week|month) and an `anchor` day are sent; the API
 *   derives the Monday-based week or the calendar month and returns every day as a cell. The screen
 *   only pads the month's leading/trailing days so each row is a full Mon–Sun week.
 * - **Occurrences carry no time.** A recurrence rule falls on a *day*, not an instant (x129), so an
 *   occurrence shows the series title on its day, without a clock time.
 * - It is read-only: scheduling, editing and per-occurrence overrides are other slices (x213).
 */
export function CalendarGridScreen({
  organizationSlug,
  organizationName,
  initialRange = 'month',
  client,
}: CalendarGridScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const [range] = useState<CalendarGridRange>(initialRange);
  const [anchor, setAnchor] = useState<string>(() => todayUtc());

  const anchorValid = /^\d{4}-\d{2}-\d{2}$/.test(anchor) && !Number.isNaN(Date.parse(anchor));

  const grid = useQuery({
    queryKey: ['calendar-grid', organizationSlug, range, anchor],
    queryFn: () => getCalendarGrid(api, organizationSlug, { range, anchor }),
    enabled: anchorValid,
  });

  const weeks = useMemo(() => (grid.data ? intoWeeks(grid.data.days) : []), [grid.data]);
  const caption = grid.data
    ? `${formatDay(grid.data.from)} to ${formatDay(grid.data.to)}`
    : t('CalendarGridScreen.captionFallback');
  const heading = grid.data ? rangeHeading(grid.data.from, grid.data.to, range) : '';
  const today = todayUtc();

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title={t('CalendarGridScreen.title')}
      eyebrow={
        range === 'week'
          ? t('CalendarGridScreen.eyebrowWeek')
          : t('CalendarGridScreen.eyebrowMonth')
      }
      actions={<CalendarHeaderActions organizationSlug={organizationSlug} current={range} />}
    >
      <div className="tm-cal">
        <CalendarSubnav organizationSlug={organizationSlug} />

        <section className="tm-cal" aria-labelledby="tm-grid-heading">
          <div className="tm-cal-grid-bar">
            <h2 id="tm-grid-heading" className="tm-cal-grid-bar__range">
              {heading ||
                (range === 'week'
                  ? t('CalendarGridScreen.thisWeek')
                  : t('CalendarGridScreen.thisMonth'))}
            </h2>
            <div
              className="tm-cal-grid-bar__end"
              role="group"
              aria-label={t('CalendarGridScreen.moveGrid')}
            >
              <span className="tm-cal-chip tm-cal-chip--ink">
                {t('CalendarGridScreen.chipMeetings')}
              </span>
              <span className="tm-cal-chip">{t('CalendarGridScreen.chipRecurring')}</span>
              <button
                type="button"
                className="tm-cal-btn"
                onClick={() => setAnchor((current) => shiftAnchor(current, range, -1))}
              >
                {range === 'week'
                  ? t('CalendarGridScreen.previousWeek')
                  : t('CalendarGridScreen.previousMonth')}
              </button>
              <button type="button" className="tm-cal-btn" onClick={() => setAnchor(todayUtc())}>
                {t('CalendarGridScreen.today')}
              </button>
              <button
                type="button"
                className="tm-cal-btn"
                onClick={() => setAnchor((current) => shiftAnchor(current, range, 1))}
              >
                {range === 'week'
                  ? t('CalendarGridScreen.nextWeek')
                  : t('CalendarGridScreen.nextMonth')}
              </button>
              <span className="tm-cal-grid-bar__anchor">
                <label className="tm-visually-hidden" htmlFor="tm-grid-anchor">
                  {t('CalendarGridScreen.anchorDate')}
                </label>
                <input
                  id="tm-grid-anchor"
                  type="date"
                  value={anchor}
                  onChange={(event) => setAnchor(event.target.value)}
                />
              </span>
            </div>
          </div>

          {!anchorValid ? (
            <InlineAlert tone="warning" title={t('CalendarGridScreen.chooseAnchorTitle')}>
              {t('CalendarGridScreen.chooseAnchorBody')}
            </InlineAlert>
          ) : null}

          {grid.isError ? (
            <InlineAlert tone="danger" title={t('CalendarGridScreen.loadErrorTitle')} live>
              {describeError(grid.error)}
            </InlineAlert>
          ) : null}

          {anchorValid && grid.isPending ? (
            <LoadingRegion label={t('CalendarGridScreen.loadingLabel')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {weeks.length > 0 ? (
            <div className="tm-cal-week" data-range={range}>
              <div
                className="tm-cal-week__scroll"
                // A scrollable region must be focusable so a keyboard can reach its overflow
                // columns (WCAG 2.2 2.1.1), matching the agenda and work-calendar tables.
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                tabIndex={0}
                role="region"
                aria-label={`${t('CalendarGridScreen.gridRegionLabelPrefix')}${caption}`}
              >
                <table>
                  <caption className="tm-visually-hidden">
                    {t('CalendarGridScreen.captionTableBefore')}
                    {caption}
                    {t('CalendarGridScreen.captionTableAfter')}
                  </caption>
                  <thead>
                    <tr>
                      {WEEKDAYS.map((weekday, index) => {
                        // A week has one row, so its column heads carry the dates (CAL-01 "TUE 18").
                        const cell = range === 'week' ? weeks[0]?.[index] : null;
                        return (
                          <th
                            key={weekday}
                            scope="col"
                            {...(cell?.date === today ? { 'data-today': 'true' } : {})}
                          >
                            {t(WEEKDAY_KEYS[weekday])}
                            {cell ? ` ${Number(cell.date.slice(8, 10))}` : ''}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {weeks.map((week, index) => (
                      <tr key={week[0]?.date ?? `week-${index}`}>
                        {week.map((cell, dayIndex) =>
                          cell === null ? (
                            <td key={`pad-${index}-${dayIndex}`} className="tm-cal-week__pad" />
                          ) : (
                            <td
                              key={cell.date}
                              {...(cell.date === today ? { 'data-today': 'true' } : {})}
                            >
                              {range === 'month' ? (
                                <span className="tm-cal-week__date" aria-hidden="true">
                                  {dayMark(cell.date)}
                                </span>
                              ) : null}
                              <span className="tm-visually-hidden">{formatDay(cell.date)}</span>
                              {cell.meetings.length === 0 && cell.occurrences.length === 0 ? (
                                <span className="tm-visually-hidden">
                                  {t('CalendarGridScreen.nothingScheduled')}
                                </span>
                              ) : (
                                <ul className="tm-cal-week__items">
                                  {cell.meetings.map((meeting) => (
                                    <li key={meeting.id}>
                                      <Link
                                        href={`/${organizationSlug}/calendar/meetings/${meeting.id}`}
                                        className="tm-cal-evt tm-cal-evt--ink"
                                      >
                                        {meeting.title}
                                      </Link>
                                    </li>
                                  ))}
                                  {cell.occurrences.map((occurrence) => (
                                    <li
                                      key={`${occurrence.seriesId}-${cell.date}`}
                                      className="tm-cal-evt"
                                    >
                                      {occurrence.title}
                                      <span className="tm-visually-hidden">
                                        {t('CalendarGridScreen.recurringSuffix')}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}

/** "14" in a month cell, "1 Oct" on the first of the month. */
function dayMark(date: string): string {
  const day = Number(date.slice(8, 10));
  if (day !== 1) return String(day);
  const month = new Intl.DateTimeFormat(appDateLocale(), {
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
  return `1 ${month}`;
}

/** "12 – 18 October" for a week, "October 2026" for a month — CAL-01's range headline. */
function rangeHeading(from: string, to: string, range: CalendarGridRange): string {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  const month = (date: Date) =>
    new Intl.DateTimeFormat(appDateLocale(), { month: 'long', timeZone: 'UTC' }).format(date);
  if (range === 'month') {
    return new Intl.DateTimeFormat(appDateLocale(), {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(start);
  }
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  return sameMonth
    ? `${start.getUTCDate()} – ${end.getUTCDate()} ${month(end)}`
    : `${start.getUTCDate()} ${month(start)} – ${end.getUTCDate()} ${month(end)}`;
}

/** Today's UTC calendar date, the default anchor. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Shift the anchor by one week (7 days) or one calendar month, in UTC. */
function shiftAnchor(anchor: string, range: CalendarGridRange, direction: 1 | -1): string {
  const ms = Date.parse(`${anchor}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return anchor;
  if (range === 'week') {
    return new Date(ms + direction * 7 * MS_PER_DAY).toISOString().slice(0, 10);
  }
  const date = new Date(ms);
  const shifted = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + direction, date.getUTCDate()),
  );
  return shifted.toISOString().slice(0, 10);
}

/**
 * Group the server's contiguous day cells into Monday–Sunday rows, padding the first and last rows
 * with `null` so each row has seven cells (a month rarely starts on a Monday or ends on a Sunday).
 */
function intoWeeks(days: readonly CalendarGridDayRow[]): (CalendarGridDayRow | null)[][] {
  if (days.length === 0) return [];
  const first = days[0];
  if (!first) return [];
  const leadingBlanks = (new Date(`${first.date}T00:00:00.000Z`).getUTCDay() + 6) % 7;
  const cells: (CalendarGridDayRow | null)[] = [...Array(leadingBlanks).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (CalendarGridDayRow | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }
  return weeks;
}
