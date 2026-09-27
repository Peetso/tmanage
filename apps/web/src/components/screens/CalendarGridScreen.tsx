'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getCalendarGrid } from '../../lib/api/calendar-grid';
import type { CalendarGridDayRow, CalendarGridRange } from '../../lib/api/calendar-grid';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatDay } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

export interface CalendarGridScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const MS_PER_DAY = 86_400_000;
/** Weekday column headers, Monday-first, matching the server's Monday-based week. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

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
  client,
}: CalendarGridScreenProps) {
  const api = client ?? browserApiClient();
  const [range, setRange] = useState<CalendarGridRange>('month');
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
    : 'Calendar grid';

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title="Calendar"
      description="Your meetings and recurring series laid out on a week or month grid."
    >
      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-grid-controls">
        <h2 id="tm-grid-controls" className="tm-eyebrow">
          View
        </h2>
        <div className="tm-toolbar">
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-grid-range">
              Range
            </label>
            <select
              id="tm-grid-range"
              className="tm-field__control"
              value={range}
              onChange={(event) => setRange(event.target.value as CalendarGridRange)}
            >
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </div>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-grid-anchor">
              Anchor date
            </label>
            <input
              id="tm-grid-anchor"
              className="tm-field__control"
              type="date"
              value={anchor}
              onChange={(event) => setAnchor(event.target.value)}
            />
          </div>
          <div className="tm-button-row">
            <button
              type="button"
              className="tm-button tm-button--ghost"
              onClick={() => setAnchor((current) => shiftAnchor(current, range, -1))}
            >
              Previous {range}
            </button>
            <button
              type="button"
              className="tm-button tm-button--ghost"
              onClick={() => setAnchor((current) => shiftAnchor(current, range, 1))}
            >
              Next {range}
            </button>
          </div>
        </div>
      </section>

      {!anchorValid ? (
        <InlineAlert tone="warning" title="Choose an anchor date">
          Pick a valid date to load the grid.
        </InlineAlert>
      ) : null}

      {grid.isError ? (
        <InlineAlert tone="danger" title="Could not load the calendar" live>
          {describeError(grid.error)}
        </InlineAlert>
      ) : null}

      {anchorValid && grid.isPending ? (
        <LoadingRegion label="Loading the calendar grid.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {weeks.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-grid-heading">
          <h2 id="tm-grid-heading" className="tm-eyebrow">
            {caption}
          </h2>
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable so a keyboard can reach its overflow columns
            // (WCAG 2.2 2.1.1), matching the agenda and work-calendar tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label={`Calendar grid, ${caption}`}
          >
            <table className="tm-table tm-table--grid">
              <caption className="tm-visually-hidden">
                Meetings and recurring series from {caption}, laid out Monday to Sunday.
              </caption>
              <thead>
                <tr>
                  {WEEKDAYS.map((weekday) => (
                    <th key={weekday} scope="col">
                      {weekday}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((week, index) => (
                  <tr key={week[0]?.date ?? `week-${index}`}>
                    {week.map((cell, dayIndex) =>
                      cell === null ? (
                        <td
                          key={`pad-${index}-${dayIndex}`}
                          className="tm-cal-cell tm-cal-cell--empty"
                        />
                      ) : (
                        <td key={cell.date} className="tm-cal-cell">
                          <span className="tm-cal-cell__date">{formatDay(cell.date)}</span>
                          {cell.meetings.length === 0 && cell.occurrences.length === 0 ? (
                            <span className="tm-visually-hidden">Nothing scheduled</span>
                          ) : (
                            <ul className="tm-cal-cell__items">
                              {cell.meetings.map((meeting) => (
                                <li key={meeting.id}>
                                  <Link
                                    href={`/${organizationSlug}/calendar/meetings/${meeting.id}`}
                                  >
                                    {meeting.title}
                                  </Link>
                                </li>
                              ))}
                              {cell.occurrences.map((occurrence) => (
                                <li
                                  key={`${occurrence.seriesId}-${cell.date}`}
                                  className="tm-cal-cell__series"
                                >
                                  {occurrence.title}
                                  <span className="tm-visually-hidden"> (recurring)</span>
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
        </section>
      ) : null}
    </AppShell>
  );
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

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
