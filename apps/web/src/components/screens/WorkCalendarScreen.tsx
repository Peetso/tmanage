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
import '../../styles/screens/work-planning.css';

export interface WorkCalendarScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Pre-select a project (deep link `?project=`). Defaults to the first project the caller sees. */
  initialProjectId?: string;
  client?: ApiClient;
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
 * controls move it — and the grid is a real table: weekday column headers, one cell per day,
 * each item a link to its work item whose accessible name carries its state.
 *
 * Item colours follow the artboard: ink for done, lime for what is in progress, an orange
 * outline for anything past due and not finished, a quiet paper chip for backlog.
 */
export function WorkCalendarScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
  now: nowProp,
}: WorkCalendarScreenProps) {
  const api = client ?? browserApiClient();
  const now = useMemo(() => nowProp ?? new Date(), [nowProp]);
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const [month, setMonth] = useState(() => ({
    year: now.getUTCFullYear(),
    month: now.getUTCMonth(),
  }));

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // The calendar is per project: with none chosen, the first project the caller can see.
  const chosenProjectId = projectId !== '' ? projectId : (projects.data?.[0]?.id ?? '');
  const range = useMemo(() => monthRange(month.year, month.month), [month]);

  const calendar = useQuery({
    queryKey: ['work-calendar', organizationSlug, chosenProjectId, range.from, range.to],
    queryFn: () => getWorkCalendar(api, organizationSlug, chosenProjectId, range),
    enabled: chosenProjectId !== '',
  });

  const itemsByDay = useMemo(() => {
    const map = new Map<string, WorkCalendarDayRow['items']>();
    for (const day of calendar.data?.days ?? []) map.set(day.date, day.items);
    return map;
  }, [calendar.data]);

  const weeks = useMemo(() => monthGrid(month.year, month.month), [month]);
  const todayKey = now.toISOString().slice(0, 10);
  const title = new Date(Date.UTC(month.year, month.month, 1)).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const noProjects = projects.isSuccess && projects.data.length === 0;
  const empty =
    chosenProjectId !== '' && calendar.isSuccess && (calendar.data.days ?? []).length === 0;

  const shift = (delta: number) =>
    setMonth((current) => {
      const next = new Date(Date.UTC(current.year, current.month + delta, 1));
      return { year: next.getUTCFullYear(), month: next.getUTCMonth() };
    });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={title}
      eyebrow="Calendar"
      actions={
        <div className="wp-toolbar">
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
          <button
            type="button"
            className="wp-cal__nav"
            aria-label="Previous month"
            onClick={() => shift(-1)}
          >
            <span aria-hidden="true">&#8249;</span>
          </button>
          <button
            type="button"
            className="wp-capsule"
            onClick={() => setMonth({ year: now.getUTCFullYear(), month: now.getUTCMonth() })}
          >
            This month
          </button>
          <button
            type="button"
            className="wp-cal__nav"
            aria-label="Next month"
            onClick={() => shift(1)}
          >
            <span aria-hidden="true">&#8250;</span>
          </button>
        </div>
      }
    >
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

      {chosenProjectId !== '' && calendar.isPending ? (
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
                          cell.inMonth ? '' : 'wp-cal__outside',
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
            This project has no dated work you can see in {title}. Move to another month, or add
            dates from the work item.
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

/** The first and last day of a month, as the API's `YYYY-MM-DD` range. */
function monthRange(year: number, month: number): { from: string; to: string } {
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

interface GridCell {
  readonly key: string;
  readonly day: number;
  readonly label: string;
  readonly inMonth: boolean;
}

/** Whole weeks, Sunday first, covering the month — the artboard's grid. */
function monthGrid(year: number, month: number): GridCell[][] {
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());
  const last = new Date(Date.UTC(year, month + 1, 0));
  const end = new Date(last);
  end.setUTCDate(last.getUTCDate() + (6 - last.getUTCDay()));

  const weeks: GridCell[][] = [];
  for (let cursor = new Date(start); cursor <= end;) {
    const week: GridCell[] = [];
    for (let index = 0; index < 7; index += 1) {
      const inMonth = cursor.getUTCMonth() === month;
      const day = cursor.getUTCDate();
      week.push({
        key: cursor.toISOString().slice(0, 10),
        day,
        label:
          day === 1 && !inMonth
            ? `1 ${cursor.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}`
            : String(day),
        inMonth,
      });
      cursor.setUTCDate(day + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
