'use client';

import { useMemo, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { WorkItemState } from '@tmanage/domain';
import { WorkViewsShell } from '../work/WorkViewsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { getWorkCalendar, getWorkCalendarAll } from '../../lib/api/work-views';
import type { WorkCalendarDayRow, WorkCalendarView } from '../../lib/api/work-views';
import { getWorkItem, updateWorkItem } from '../../lib/api/work-items';
import { ApiRequestError } from '../../lib/api/errors';
import { datesForDayDrop, useWorkDragPermissions } from '../../lib/work-drag';
import { useTOr } from '../../lib/i18n/use-t-or';
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
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
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
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const now = useMemo(() => nowProp ?? new Date(), [nowProp]);
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const [range, setRange] = useState<CalendarRange>(() =>
    initialCalendarRange(initialFrom, initialTo, now),
  );
  const rangeProblem = calendarRangeProblem(range);
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const { canUpdate: canDrag } = useWorkDragPermissions(api, organizationSlug);
  // FIX3 item C: drag an item to another day to move its dates.
  const [dragging, setDragging] = useState<{ id: string; fromDay: string } | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<{ title: string; reason: string } | null>(null);

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // FIX3 item 10: no project chosen is "All work" — every project the caller can see — and the
  // view never switches to one project on its own.
  const chosenProjectId = projectId;
  const allProjectIds = useMemo(
    () => (projects.data ?? []).map((project) => project.id),
    [projects.data],
  );
  const scopeReady = chosenProjectId !== '' || allProjectIds.length > 0;

  const calendarKey = [
    'work-calendar',
    organizationSlug,
    chosenProjectId,
    allProjectIds.join(','),
    range.from,
    range.to,
  ];
  const calendar = useQuery({
    queryKey: calendarKey,
    queryFn: () =>
      chosenProjectId === ''
        ? getWorkCalendarAll(api, organizationSlug, allProjectIds, range)
        : getWorkCalendar(api, organizationSlug, chosenProjectId, range),
    // An invalid range is explained on screen and never sent: the API would only refuse it.
    enabled: scopeReady && rangeProblem === null,
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
    scopeReady &&
    rangeProblem === null &&
    calendar.isSuccess &&
    (calendar.data.days ?? []).length === 0;

  // Every move goes through here, so the page can mirror a valid range into the URL.
  /**
   * A drop on another day: shown there at once (the calendar's cached read is rewritten), then
   * saved as a PATCH of the item's dates with its current version. A refusal puts the item back
   * and says why.
   */
  async function dropOnDay(itemId: string, fromDay: string, toDay: string) {
    const previous = queryClient.getQueryData<WorkCalendarView>(calendarKey);
    const moving = previous?.days
      .find((day) => day.date === fromDay)
      ?.items.find((entry) => entry.id === itemId);
    if (!previous || !moving) return;
    const dates = datesForDayDrop(moving, fromDay, toDay);
    if (dates === null) return;
    setMoveError(null);
    const moved = { ...moving, ...dates };
    const days = previous.days
      .map((day) =>
        day.date === fromDay
          ? { ...day, items: day.items.filter((entry) => entry.id !== itemId) }
          : day,
      )
      .filter((day) => day.items.length > 0 || day.date === toDay);
    const target = days.find((day) => day.date === toDay);
    const nextDays = target
      ? days.map((day) => (day.date === toDay ? { ...day, items: [...day.items, moved] } : day))
      : [...days, { date: toDay, items: [moved] }].sort((left, right) =>
          left.date.localeCompare(right.date),
        );
    queryClient.setQueryData<WorkCalendarView>(calendarKey, { ...previous, days: nextDays });
    try {
      const current = await getWorkItem(api, organizationSlug, itemId);
      await updateWorkItem(api, organizationSlug, itemId, {
        version: current.version,
        startAt: dates.startAt,
        dueAt: dates.dueAt,
      });
    } catch (error) {
      queryClient.setQueryData<WorkCalendarView>(calendarKey, previous);
      setMoveError({
        title: moving.title,
        reason:
          error instanceof ApiRequestError
            ? error.message
            : tOr('WorkBoard.moveFailed', 'Check your connection and try again.'),
      });
    } finally {
      void queryClient.invalidateQueries({ queryKey: ['work-calendar', organizationSlug] });
    }
  }

  const moveTo = (next: CalendarRange) => {
    setRange(next);
    if (calendarRangeProblem(next) !== null) return;
    onRangeChange?.(next.from === thisMonth.from && next.to === thisMonth.to ? null : next);
  };

  return (
    <WorkViewsShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      {...(client ? { client } : {})}
      view="calendar"
      projectId={chosenProjectId}
      onChooseProject={setProjectId}
      titleMeta={title}
      toolbar={
        <>
          <label className="tm-visually-hidden" htmlFor="tm-calendar-project">
            {t('WorkCalendarScreen.showCalendarFor')}
          </label>
          <select
            id="tm-calendar-project"
            className="wp-select"
            value={chosenProjectId}
            disabled={projects.isPending || noProjects}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">{t('WorkListScreen.viewAllWork')}</option>
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
            <legend className="tm-visually-hidden">{t('WorkCalendarScreen.dateRange')}</legend>
            <label className="wk-cal-range__field" htmlFor="tm-calendar-from">
              <span className="wk-cal-range__label">{t('WorkCalendarScreen.from')}</span>
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
              <span className="wk-cal-range__label">{t('WorkCalendarScreen.to')}</span>
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
            aria-label={t('WorkCalendarScreen.previousMonth')}
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
            {t('WorkCalendarScreen.thisMonth')}
          </button>
          <button
            type="button"
            className="wp-cal__nav"
            aria-label={t('WorkCalendarScreen.nextMonth')}
            onClick={() => moveTo(shiftCalendarMonth(range, 1, now))}
          >
            <span aria-hidden="true">&#8250;</span>
          </button>
        </>
      }
    >
      {rangeProblem !== null ? (
        <div id="tm-calendar-range-problem">
          <InlineAlert tone="warning" title={t('WorkCalendarScreen.checkRange')} live>
            {rangeProblem}
          </InlineAlert>
        </div>
      ) : null}

      {projects.isError ? (
        <InlineAlert tone="danger" title={t('WorkCalendarScreen.projectsError')} live>
          {describeError(projects.error)}
        </InlineAlert>
      ) : null}

      {noProjects ? (
        <div className="wp-empty">
          <h2 className="wp-empty__title">{t('WorkCalendarScreen.noProjectTitle')}</h2>
          <p className="wp-empty__body">{t('WorkCalendarScreen.noProjectBody')}</p>
        </div>
      ) : null}

      {moveError ? (
        <InlineAlert tone="danger" title={tOr('WorkBoard.moveNotAllowed', 'Move not allowed')} live>
          {tOr('WorkBoard.moveNotAllowedBody', '“{title}” was not moved. {reason}')
            .replace('{title}', moveError.title)
            .replace('{reason}', moveError.reason)}
        </InlineAlert>
      ) : null}

      {calendar.isError ? (
        <InlineAlert tone="danger" title={t('WorkCalendarScreen.calendarError')} live>
          {describeError(calendar.error)}
        </InlineAlert>
      ) : null}

      {rangeProblem !== null ? null : scopeReady && calendar.isPending ? (
        <LoadingRegion label={t('WorkCalendarScreen.loading')}>
          <Skeleton height="30px" />
          <Skeleton height="480px" />
        </LoadingRegion>
      ) : (
        <div className="wp-cal">
          <table>
            <caption className="tm-visually-hidden">
              {t('WorkCalendarScreen.captionPrefix')} {title}
              {t('WorkCalendarScreen.captionSuffix')}
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
                        data-drop-over={(overDay === cell.key && dragging !== null) || undefined}
                        {...(canDrag
                          ? {
                              onDragOver: (event: DragEvent<HTMLTableCellElement>) => {
                                if (dragging === null) return;
                                event.preventDefault();
                                event.dataTransfer.dropEffect = 'move';
                                if (overDay !== cell.key) setOverDay(cell.key);
                              },
                              onDrop: (event: DragEvent<HTMLTableCellElement>) => {
                                event.preventDefault();
                                const from = dragging;
                                setDragging(null);
                                setOverDay(null);
                                if (from) void dropOnDay(from.id, from.fromDay, cell.key);
                              },
                            }
                          : {})}
                      >
                        <div className="wp-cal__cell">
                          <span className="wp-cal__day">
                            {isToday ? (
                              <>
                                <span className="wp-cal__today-dot">{cell.day}</span>
                                <span className="wp-cal__today-word">
                                  {t('WorkCalendarScreen.today')}
                                </span>
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
                              data-dragging={dragging?.id === item.id || undefined}
                              {...(canDrag
                                ? {
                                    draggable: true,
                                    onDragStart: (event: DragEvent<HTMLAnchorElement>) => {
                                      event.dataTransfer.setData('text/plain', item.id);
                                      event.dataTransfer.effectAllowed = 'move';
                                      setDragging({ id: item.id, fromDay: cell.key });
                                      setMoveError(null);
                                    },
                                    onDragEnd: () => {
                                      setDragging(null);
                                      setOverDay(null);
                                    },
                                  }
                                : {})}
                            >
                              {item.title}
                            </Link>
                          ))}
                          {items.length > MAX_ITEMS_PER_DAY ? (
                            <span className="wp-cal__more">
                              +{items.length - MAX_ITEMS_PER_DAY} {t('WorkCalendarScreen.more')}
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
          <h2 className="wp-empty__title">{t('WorkCalendarScreen.emptyTitle')}</h2>
          <p className="wp-empty__body">
            {t('WorkCalendarScreen.emptyBodyPrefix')} {title}
            {t('WorkCalendarScreen.emptyBodySuffix')}
          </p>
        </div>
      ) : null}
    </WorkViewsShell>
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
