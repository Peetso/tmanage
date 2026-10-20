'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { WorkItemState } from '@tmanage/domain';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { getWorkCalendar } from '../../lib/api/work-views';
import type { WorkCalendarDayRow } from '../../lib/api/work-views';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { isOverdue, stateLabel } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import {
  calendarGrid,
  calendarRangeProblem,
  calendarRangeTitle,
  currentMonthRange,
  initialCalendarRange,
  isWholeMonth,
  shiftCalendarMonth,
} from '../../lib/work-calendar-range';
import type { CalendarRange } from '../../lib/work-calendar-range';
import '../../styles/screens/work-planning.css';
import '../../styles/screens/work-calendar.css';

export interface WorkCalendarScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Pre-select a project (deep link `?project=`). Defaults to the first project the caller sees. */
  initialProjectId?: string;
  client?: ApiClient;
  /** A custom range from the URL (`?from=&to=`); both or neither. Defaults to this month. */
  initialFrom?: string;
  initialTo?: string;
  /**
   * Called with every valid range the caller moves to, or `null` when they return to this month,
   * so the page can keep the range in the URL.
   */
  onRangeChange?: (range: CalendarRange | null) => void;
  /** Injected in tests so "today" and "overdue" are measured against a fixed moment. */
  now?: Date;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MAX_ITEMS_PER_DAY = 3;

/**
 * **WK-05 Work calendar** — the month grid from `TManage Screens - Work Extended.dc.html`.
 *
 * A calendar is per project and over a range; the API anchors each item on its due date, or its
 * start date when it has no due date. The range is the month on screen — the previous/next
 * controls move it — or a custom From/To range (at most a year, kept in the URL by the page); an
 * invalid range is explained and never sent. The grid is a real table: weekday column headers,
 * one cell per day, each item a link to its work item whose accessible name carries its state.
 *
 * Item colours follow the artboard: ink for done, lime for what is in progress, an orange
 * outline for anything past due and not finished, a quiet paper chip for backlog.
 */
export function WorkCalendarScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
  initialFrom,
  initialTo,
  onRangeChange,
  now: nowProp,
}: WorkCalendarScreenProps) {
  const api = client ?? browserApiClient();
  const now = useMemo(() => nowProp ?? new Date(), [nowProp]);
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const [range, setRange] = useState<CalendarRange>(() =>
    initialCalendarRange(initialFrom, initialTo, now),
  );
  const rangeProblem = calendarRangeProblem(range);

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // The calendar is per project: with none chosen, the first project the caller can see.
  const chosenProjectId = projectId !== '' ? projectId : (projects.data?.[0]?.id ?? '');

  const calendar = useQuery({
    queryKey: ['work-calendar', organizationSlug, chosenProjectId, range.from, range.to],
    queryFn: () => getWorkCalendar(api, organizationSlug, chosenProjectId, range),
    // An invalid range is explained on screen and never sent: the API would only refuse it.
    enabled: chosenProjectId !== '' && rangeProblem === null,
  });

  const itemsByDay = useMemo(() => {
    const map = new Map<string, WorkCalendarDayRow['items']>();
    for (const day of calendar.data?.days ?? []) map.set(day.date, day.items);
    return map;
  }, [calendar.data]);

  const weeks = useMemo(() => calendarGrid(range), [range]);
  const todayKey = now.toISOString().slice(0, 10);
  const title = calendarRangeTitle(range);
  const thisMonth = currentMonthRange(now);
  const onThisMonth = range.from === thisMonth.from && range.to === thisMonth.to;
  const noProjects = projects.isSuccess && projects.data.length === 0;
  const empty =
    chosenProjectId !== '' &&
    rangeProblem === null &&
    calendar.isSuccess &&
    (calendar.data.days ?? []).length === 0;

  // Every move goes through here, so the page can mirror a valid range into the URL.
  const moveTo = (next: CalendarRange) => {
    setRange(next);
    if (calendarRangeProblem(next) !== null) return;
    onRangeChange?.(next.from === thisMonth.from && next.to === thisMonth.to ? null : next);
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={title}
      eyebrow="Calendar"
      actions={
        <div className="wp-toolbar">
          {/*
            CQ-07 (WRK-08): the same view switcher the other work views carry, so the calendar is
            not the one view with no way back to the list / timeline / workload. Each link keeps
            the chosen project.
          */}
          <nav className="wp-segmented" aria-label="Work views">
            <Link href={`/${organizationSlug}/work`}>List</Link>
            <Link
              href={`/${organizationSlug}/work/timeline${
                chosenProjectId === '' ? '' : `?project=${encodeURIComponent(chosenProjectId)}`
              }`}
            >
              Timeline
            </Link>
            <span aria-current="page">Calendar</span>
            <Link
              href={`/${organizationSlug}/work/workload${
                chosenProjectId === '' ? '' : `?project=${encodeURIComponent(chosenProjectId)}`
              }`}
            >
              Workload
            </Link>
          </nav>
          <label className="tm-visually-hidden" htmlFor="tm-calendar-project">
            Show the calendar for
          </label>
          <select
            id="tm-calendar-project"
            className="wp-select"
            value={chosenProjectId}
            disabled={projects.isPending || noProjects}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {chosenProjectId === '' ? <option value="">Choose a project…</option> : null}
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <fieldset
            className="wk-cal-range"
            data-custom={isWholeMonth(range) ? undefined : 'true'}
            aria-describedby={rangeProblem ? 'tm-calendar-range-problem' : undefined}
          >
            <legend className="tm-visually-hidden">Date range</legend>
            <label className="wk-cal-range__field" htmlFor="tm-calendar-from">
              <span className="wk-cal-range__label">From</span>
              <input
                id="tm-calendar-from"
                type="date"
                value={range.from}
                max={range.to || undefined}
                aria-invalid={rangeProblem?.includes('From') ? true : undefined}
                onChange={(event) => moveTo({ from: event.target.value, to: range.to })}
              />
            </label>
            <label className="wk-cal-range__field" htmlFor="tm-calendar-to">
              <span className="wk-cal-range__label">To</span>
              <input
                id="tm-calendar-to"
                type="date"
                value={range.to}
                min={range.from || undefined}
                aria-invalid={rangeProblem && !rangeProblem.includes('From') ? true : undefined}
                onChange={(event) => moveTo({ from: range.from, to: event.target.value })}
              />
            </label>
          </fieldset>
          <button
            type="button"
            className="wp-cal__nav"
            aria-label="Previous month"
            onClick={() => moveTo(shiftCalendarMonth(range, -1, now))}
          >
            <span aria-hidden="true">&#8249;</span>
          </button>
          <button
            type="button"
            className="wp-capsule"
            aria-pressed={onThisMonth}
            onClick={() => moveTo(thisMonth)}
          >
            This month
          </button>
          <button
            type="button"
            className="wp-cal__nav"
            aria-label="Next month"
            onClick={() => moveTo(shiftCalendarMonth(range, 1, now))}
          >
            <span aria-hidden="true">&#8250;</span>
          </button>
        </div>
      }
    >
      {rangeProblem !== null ? (
        <div id="tm-calendar-range-problem">
          <InlineAlert tone="warning" title="Check the date range" live>
            {rangeProblem}
          </InlineAlert>
        </div>
      ) : null}

      {projects.isError ? (
        <InlineAlert tone="danger" title="Could not load your projects" live>
          {describeError(projects.error)}
        </InlineAlert>
      ) : null}

      {noProjects ? (
        <div className="wp-empty">
          <h2 className="wp-empty__title">No project to show yet</h2>
          <p className="wp-empty__body">
            A calendar is per project. Once you can see a project, its dated work appears here.
          </p>
        </div>
      ) : null}

      {calendar.isError ? (
        <InlineAlert tone="danger" title="Could not load the calendar" live>
          {describeError(calendar.error)}
        </InlineAlert>
      ) : null}

      {rangeProblem !== null ? null : chosenProjectId !== '' && calendar.isPending ? (
        <LoadingRegion label="Loading the calendar.">
          <Skeleton height="30px" />
          <Skeleton height="480px" />
        </LoadingRegion>
      ) : (
        <div className="wp-cal">
          <table>
            <caption className="tm-visually-hidden">
              Work for {title}, on its due date or, without one, its start date.
            </caption>
            <thead>
              <tr>
                {WEEKDAYS.map((day) => (
                  <th key={day} scope="col">
                    {day}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={week[0]!.key}>
                  {week.map((cell) => {
                    const items = itemsByDay.get(cell.key) ?? [];
                    const isToday = cell.key === todayKey;
                    return (
                      <td
                        key={cell.key}
                        className={[
                          cell.inRange ? '' : 'wp-cal__outside',
                          isToday ? 'wp-cal__today' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        aria-current={isToday ? 'date' : undefined}
                      >
                        <div className="wp-cal__cell">
                          <span className="wp-cal__day">
                            {isToday ? (
                              <>
                                <span className="wp-cal__today-dot">{cell.day}</span>
                                <span className="wp-cal__today-word">today</span>
                              </>
                            ) : (
                              cell.label
                            )}
                          </span>
                          {items.slice(0, MAX_ITEMS_PER_DAY).map((item) => (
                            <Link
                              key={item.id}
                              href={`/${organizationSlug}/work/${item.id}`}
                              className={`wp-cal__item ${itemClass(item, now)}`}
                              title={`${item.title} · ${stateLabel(item.state)}`}
                              aria-label={`${item.title}, ${stateLabel(item.state)}`}
                            >
                              {item.title}
                            </Link>
                          ))}
                          {items.length > MAX_ITEMS_PER_DAY ? (
                            <span className="wp-cal__more">
                              +{items.length - MAX_ITEMS_PER_DAY} more
                            </span>
                          ) : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {empty ? (
        <div className="wp-empty">
          <h2 className="wp-empty__title">Nothing on this calendar yet</h2>
          <p className="wp-empty__body">
            This project has no dated work you can see in {title}. Move to another month or range,
            or add dates from the work item.
          </p>
        </div>
      ) : null}
    </AppShell>
  );
}

function itemClass(
  item: { readonly state: WorkItemState; readonly dueAt: string | null },
  now: Date,
): string {
  if (item.state === 'done') return 'wp-cal__item--done';
  if (isOverdue(item, now)) return 'wp-cal__item--late';
  if (item.state === 'in_progress' || item.state === 'internal_review') {
    return 'wp-cal__item--active';
  }
  if (item.state === 'backlog' || item.state === 'archived') return 'wp-cal__item--quiet';
  return '';
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
