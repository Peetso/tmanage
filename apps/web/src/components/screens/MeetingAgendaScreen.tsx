'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getMeetingAgenda } from '../../lib/api/meeting-agenda';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatDay, formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

export interface MeetingAgendaScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** How wide the agenda window may be — the API refuses a wider one (400). */
const MAX_WINDOW_DAYS = 31;

/**
 * **Calendar agenda / day view (x127).**
 *
 * `38-MODULE-MAP` §Calendar (agenda/day). The read-only agenda over the tenant's meetings: every
 * meeting the caller may read whose start falls in a chosen window, grouped by the day it starts on
 * — each day a heading with a table beneath it, so a screen-reader user reads the same buckets a
 * month grid would draw. It complements `MeetingsScreen` (a project's list) with the cross-project
 * "what is coming up" view the audit found missing (Calendar Partial).
 *
 * ## What it draws, and what it cannot
 *
 * - **The buckets are the server's.** A meeting's day is the day it starts on (UTC); the API groups
 *   and orders them, so the sequence the reader sees is the sequence the agenda means.
 * - **The range is required and bounded.** `from`/`to` default to the current month and may span at
 *   most {@link MAX_WINDOW_DAYS} days — the API refuses a wider window. Days with nothing on them
 *   are simply absent, matching how the sibling screens show only the rows there are.
 *
 * Week/month grids, recurrence expansion and ICS export are deferred (x128/x129, NS-13).
 */
export function MeetingAgendaScreen({
  organizationSlug,
  organizationName,
  client,
}: MeetingAgendaScreenProps) {
  const api = client ?? browserApiClient();
  const defaults = useMemo(currentMonthRange, []);
  const [from, setFrom] = useState<string>(defaults.from);
  const [to, setTo] = useState<string>(defaults.to);

  const rangeValid = from !== '' && to !== '' && from <= to && windowDays(from, to) <= MAX_WINDOW_DAYS;

  const agenda = useQuery({
    queryKey: ['meeting-agenda', organizationSlug, from, to],
    queryFn: () => getMeetingAgenda(api, organizationSlug, { from, to }),
    enabled: rangeValid,
  });

  const days = useMemo(() => agenda.data?.days ?? [], [agenda.data]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title="Agenda"
      description="Your meetings grouped by the day they start on, across a range you choose."
    >
      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-agenda-filters">
        <h2 id="tm-agenda-filters" className="tm-eyebrow">
          Range
        </h2>
        <fieldset className="tm-fieldset tm-stack">
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-agenda-from">
              From
            </label>
            <input
              id="tm-agenda-from"
              className="tm-field__control"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-agenda-to">
              To
            </label>
            <input
              id="tm-agenda-to"
              className="tm-field__control"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
          <span className="tm-field__hint">
            The agenda covers a range of up to {MAX_WINDOW_DAYS} days. Meetings appear on the day
            they start.
          </span>
        </fieldset>
      </section>

      {!rangeValid ? (
        <InlineAlert tone="warning" title="Choose a valid range">
          Set a start date on or before the end date, no more than {MAX_WINDOW_DAYS} days apart, to
          load the agenda.
        </InlineAlert>
      ) : null}

      {agenda.isError ? (
        <InlineAlert tone="danger" title="Could not load the agenda" live>
          {describeError(agenda.error)}
        </InlineAlert>
      ) : null}

      {rangeValid && agenda.isPending ? (
        <LoadingRegion label="Loading the agenda.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {rangeValid && !agenda.isPending && !agenda.isError && days.length === 0 ? (
        <InlineAlert tone="neutral" title="Nothing on the agenda yet">
          No meetings you can see start in this range. Widen the range, or schedule one from the
          calendar.
        </InlineAlert>
      ) : null}

      {days.length > 0
        ? days.map((day) => (
            <section
              key={day.date}
              className="tm-panel tm-stack"
              aria-labelledby={`tm-agenda-day-${day.date}`}
            >
              <h2 id={`tm-agenda-day-${day.date}`} className="tm-eyebrow">
                {formatDay(day.date)}
              </h2>
              <div
                className="tm-table-scroll"
                // A scrollable region must be focusable or a keyboard cannot reach its overflow
                // columns (WCAG 2.2 2.1.1), matching WorkCalendarScreen's table.
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                tabIndex={0}
                role="region"
                aria-label={`Meetings on ${formatDay(day.date)}`}
              >
                <table className="tm-table">
                  <caption className="tm-visually-hidden">
                    Meetings on {formatDay(day.date)}, {day.meetings.length} shown.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Meeting</th>
                      <th scope="col">Starts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {day.meetings.map((meeting) => (
                      <tr key={meeting.id}>
                        <th scope="row" className="tm-table__title">
                          <Link href={`/${organizationSlug}/calendar/meetings/${meeting.id}`}>
                            {meeting.title}
                          </Link>
                        </th>
                        <td>{formatInstant(meeting.startsAt)}</td>
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

/** The current calendar month in UTC, as the default `from`/`to` days the agenda opens on. */
function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** Inclusive day count of a `YYYY-MM-DD` window: `from`..`to` inclusive is `diff + 1` days. */
function windowDays(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return Number.POSITIVE_INFINITY;
  return Math.round((toMs - fromMs) / 86_400_000) + 1;
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
