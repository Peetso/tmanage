'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { getWorkCalendar } from '../../lib/api/work-views';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatDay, formatInstant, stateCapsule, stateLabel } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

export interface WorkCalendarScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a project — how a project screen hands off to its calendar. */
  initialProjectId?: string;
  client?: ApiClient;
}

/**
 * **WK-05 Work calendar (accessible list).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Work WK-05: a calendar of a project's work. This is the
 * accessible form of it — the project's items grouped by the day they fall on, each day a heading
 * with a table beneath it, so a screen-reader user reads the same buckets a month-grid would draw.
 *
 * ## What it draws, and what it cannot
 *
 * - **The buckets are the server's.** An item's day is its due date, or its start date when it has
 *   no due date; the API computes it and orders the days and the items within a day, so the
 *   sequence the reader sees is the sequence the calendar means — no client-side re-bucketing to
 *   drift from it.
 * - **The range is required and bounded.** A calendar is a window in time: `from`/`to` default to
 *   the current month and are the range the API buckets into. Days with nothing on them are simply
 *   absent — the honest thing, matching how `WorkTimelineScreen` shows only the rows there are.
 *
 * A project must be chosen before anything is fetched: the calendar is per-project by definition.
 */
export function WorkCalendarScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
}: WorkCalendarScreenProps) {
  const api = client ?? browserApiClient();
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const defaults = useMemo(currentMonthRange, []);
  const [from, setFrom] = useState<string>(defaults.from);
  const [to, setTo] = useState<string>(defaults.to);

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const rangeValid = from !== '' && to !== '' && from <= to;

  const calendar = useQuery({
    queryKey: ['work-calendar', organizationSlug, projectId, from, to],
    queryFn: () => getWorkCalendar(api, organizationSlug, projectId, { from, to }),
    enabled: projectId !== '' && rangeValid,
  });

  const days = useMemo(() => calendar.data?.days ?? [], [calendar.data]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Work calendar"
      description="A project's work grouped by the day it falls on, across a range you choose."
    >
      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-calendar-filters">
        <h2 id="tm-calendar-filters" className="tm-eyebrow">
          Project and range
        </h2>
        <fieldset className="tm-fieldset tm-stack" disabled={projects.isPending}>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-calendar-project">
              Show the calendar for
            </label>
            <select
              id="tm-calendar-project"
              className="tm-field__control"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Choose a project…</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-calendar-from">
              From
            </label>
            <input
              id="tm-calendar-from"
              className="tm-field__control"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-calendar-to">
              To
            </label>
            <input
              id="tm-calendar-to"
              className="tm-field__control"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
          <span className="tm-field__hint">
            A calendar is per project and over a range. Items appear on their due date, or their
            start date when they have no due date.
          </span>
        </fieldset>
      </section>

      {projectId === '' ? (
        <InlineAlert tone="neutral" title="Choose a project">
          Pick a project above to see its work grouped by day.
        </InlineAlert>
      ) : null}

      {projectId !== '' && !rangeValid ? (
        <InlineAlert tone="warning" title="Choose a valid range">
          Set a start date on or before the end date to load the calendar.
        </InlineAlert>
      ) : null}

      {calendar.isError ? (
        <InlineAlert tone="danger" title="Could not load the calendar" live>
          {describeError(calendar.error)}
        </InlineAlert>
      ) : null}

      {projectId !== '' && rangeValid && calendar.isPending ? (
        <LoadingRegion label="Loading the calendar.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {projectId !== '' && rangeValid && !calendar.isPending && !calendar.isError && days.length === 0 ? (
        <InlineAlert tone="neutral" title="Nothing on this calendar yet">
          This project has no dated work you can see in this range. Widen the range, or add dates
          from the work item.
        </InlineAlert>
      ) : null}

      {days.length > 0
        ? days.map((day) => (
            <section
              key={day.date}
              className="tm-panel tm-stack"
              aria-labelledby={`tm-calendar-day-${day.date}`}
            >
              <h2 id={`tm-calendar-day-${day.date}`} className="tm-eyebrow">
                {formatDay(day.date)}
              </h2>
              <div
                className="tm-table-scroll"
                // A scrollable region must be focusable or a keyboard cannot reach its overflow
                // columns (WCAG 2.2 2.1.1), matching WorkTimelineScreen's table.
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                tabIndex={0}
                role="region"
                aria-label={`Work on ${formatDay(day.date)}`}
              >
                <table className="tm-table">
                  <caption className="tm-visually-hidden">
                    Work on {formatDay(day.date)}, {day.items.length} shown.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Title</th>
                      <th scope="col">State</th>
                      <th scope="col">Start</th>
                      <th scope="col">Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {day.items.map((item) => (
                      <tr key={item.id}>
                        <th scope="row" className="tm-table__title">
                          <Link href={`/${organizationSlug}/work/${item.id}`}>{item.title}</Link>
                        </th>
                        <td>
                          <StateCapsule state={stateCapsule(item.state)}>
                            {stateLabel(item.state)}
                          </StateCapsule>
                        </td>
                        <td>{formatInstant(item.startAt)}</td>
                        <td>{formatInstant(item.dueAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        : null}
    </AppShell>
  );
}

/** The current calendar month in UTC, as the default `from`/`to` days a calendar opens on. */
function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
