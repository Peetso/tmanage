'use client';

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  MEETING_SERIES_FREQS,
  createMeetingSeries,
  listMeetingSeries,
  listMeetingSeriesOccurrences,
} from '../../lib/api/meeting-series';
import type { MeetingSeriesFreq } from '../../lib/api/meeting-series';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { CalendarHeaderActions, CalendarSubnav } from './MeetingsScreen';
import '../../styles/screens/calendar.css';

export interface MeetingSeriesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** How each frequency reads in the picker and the list. */
const FREQ_LABEL: Record<MeetingSeriesFreq, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

/**
 * **CAL recurrence — the meeting-series screen (x129).**
 *
 * `38-MODULE-MAP` §Calendar carries recurrence as a Partial ("recurrence deferred"). x122 shipped the
 * one-off meetings list/create; this screen adds the recurring *series*: create a rule (a title, a
 * frequency, an every-N interval, an optional end date), list a tenant's series, and preview the
 * dates a chosen series falls on inside a window.
 *
 * ## What it draws, and what it cannot
 *
 * - **A tenant's series** — a series is org-scoped (it names no project), so this reads the whole
 *   tenant's series behind `meeting.read`, no project picker.
 * - **Creating a series** → `POST /meeting-series` behind `meeting.write`. On success the new series
 *   is listed; a refusal is shown in the form, the list untouched.
 * - **An occurrence preview** — pick a series and a `[from, to]` window (the API caps it at 90 days)
 *   → `GET .../:seriesId/occurrences`, which expands the rule read-side. The expansion is the
 *   server's, not the client's.
 * - **Per-occurrence overrides, materialised rows, a calendar grid and attendees are not here.** They
 *   have no endpoint or table yet and are deferred to NEXT-SCOPES-13, the same honesty x122 kept.
 */
export function MeetingSeriesScreen({
  organizationSlug,
  organizationName,
  client,
}: MeetingSeriesScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [title, setTitle] = useState('');
  const [freq, setFreq] = useState<MeetingSeriesFreq>('weekly');
  const [interval, setInterval] = useState('1');
  const [until, setUntil] = useState('');

  const [previewSeriesId, setPreviewSeriesId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const series = useQuery({
    queryKey: ['meeting-series', organizationSlug],
    queryFn: () => listMeetingSeries(api, organizationSlug),
  });

  const create = useMutation({
    mutationFn: () =>
      createMeetingSeries(api, organizationSlug, {
        title: title.trim(),
        freq,
        interval: Number(interval),
        ...(until === '' ? {} : { until }),
      }),
    onSuccess: () => {
      setTitle('');
      setInterval('1');
      setUntil('');
      void queries.invalidateQueries({ queryKey: ['meeting-series', organizationSlug] });
    },
  });

  const occurrences = useQuery({
    queryKey: ['meeting-series-occurrences', organizationSlug, previewSeriesId, from, to],
    queryFn: () => listMeetingSeriesOccurrences(api, organizationSlug, previewSeriesId, from, to),
    enabled: previewSeriesId !== '' && from !== '' && to !== '',
  });

  const rows = useMemo(() => series.data?.series ?? [], [series.data]);

  const intervalValue = Number(interval);
  const canCreate =
    title.trim() !== '' && Number.isSafeInteger(intervalValue) && intervalValue >= 1;

  function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    create.mutate();
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title="Recurring meetings"
      eyebrow="Calendar · Series"
      actions={<CalendarHeaderActions organizationSlug={organizationSlug} current="none" />}
    >
      <div className="tm-cal">
        <CalendarSubnav organizationSlug={organizationSlug} current="series" />

        <div className="tm-cal-body">
          <div className="tm-cal-main">
            {series.isError ? (
              <InlineAlert tone="danger" title="Could not load the series" live>
                {describeError(series.error)}
              </InlineAlert>
            ) : null}

            {series.isPending ? (
              <LoadingRegion label="Loading the series.">
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {!series.isPending && !series.isError && rows.length === 0 ? (
              <InlineAlert tone="neutral" title="No series yet">
                You have no recurring meeting series. Create one beside the list.
              </InlineAlert>
            ) : null}

            {rows.length > 0 ? (
              <div className="tm-cal-sheet">
                <div
                  className="tm-cal-sheet__scroll"
                  // A scrollable region must be focusable or a keyboard cannot reach its overflow
                  // columns (WCAG 2.2 2.1.1), matching the other list screens' tables.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                  tabIndex={0}
                  role="region"
                  aria-label="Meeting series"
                >
                  <table>
                    <caption className="tm-visually-hidden">
                      Recurring meeting series, {rows.length} shown.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Title</th>
                        <th scope="col">Repeats</th>
                        <th scope="col">Every</th>
                        <th scope="col">Ends</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id}>
                          <th scope="row" className="tm-cal-sheet__what">
                            {row.title}
                          </th>
                          <td>
                            <span className="tm-cal-chip tm-cal-chip--ink">
                              {FREQ_LABEL[row.freq]}
                            </span>
                          </td>
                          <td className="tm-cal-sheet__kind">
                            {row.interval === 1
                              ? `Every ${UNIT[row.freq]}`
                              : `Every ${row.interval} ${UNIT[row.freq]}s`}
                          </td>
                          <td>
                            <span className="tm-cal-chip">
                              {row.until ? `Until ${row.until}` : 'Open-ended'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {rows.length > 0 ? (
              <section className="tm-cal-card" aria-labelledby="tm-series-preview">
                <h2 id="tm-series-preview" className="tm-cal-eyebrow">
                  Preview occurrences
                </h2>
                <div className="tm-cal-form-row">
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-series-preview-series">
                      Series
                    </label>
                    <select
                      id="tm-series-preview-series"
                      className="tm-field__control"
                      value={previewSeriesId}
                      onChange={(event) => setPreviewSeriesId(event.target.value)}
                    >
                      <option value="">Choose a series…</option>
                      {rows.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-series-preview-from">
                      From
                    </label>
                    <input
                      id="tm-series-preview-from"
                      type="date"
                      className="tm-field__control"
                      value={from}
                      onChange={(event) => setFrom(event.target.value)}
                    />
                  </div>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-series-preview-to">
                      To
                    </label>
                    <input
                      id="tm-series-preview-to"
                      type="date"
                      className="tm-field__control"
                      value={to}
                      onChange={(event) => setTo(event.target.value)}
                    />
                  </div>
                </div>
                <span className="tm-field__hint">The window is capped at 90 days.</span>

                {occurrences.isError ? (
                  <InlineAlert tone="danger" title="Could not expand the series" live>
                    {describeError(occurrences.error)}
                  </InlineAlert>
                ) : null}

                {occurrences.data ? (
                  occurrences.data.occurrences.length === 0 ? (
                    <InlineAlert tone="neutral" title="No occurrences">
                      This series falls on no dates in that window.
                    </InlineAlert>
                  ) : (
                    <ul className="tm-chip-row" aria-label="Occurrences">
                      {occurrences.data.occurrences.map((date) => (
                        <li key={date} className="tm-cal-chip">
                          {date}
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
              </section>
            ) : null}
          </div>

          <div className="tm-cal-side">
            <section className="tm-cal-card" aria-labelledby="tm-series-create">
              <h2 id="tm-series-create" className="tm-cal-eyebrow">
                Create a series
              </h2>
              <form className="tm-cal-form" onSubmit={submitCreate}>
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-series-title">
                    Title
                  </label>
                  <input
                    id="tm-series-title"
                    className="tm-field__control"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={300}
                    required
                  />
                </div>
                <div className="tm-cal-form-row">
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-series-freq">
                      Repeats
                    </label>
                    <select
                      id="tm-series-freq"
                      className="tm-field__control"
                      value={freq}
                      onChange={(event) => setFreq(event.target.value as MeetingSeriesFreq)}
                    >
                      {MEETING_SERIES_FREQS.map((value) => (
                        <option key={value} value={value}>
                          {FREQ_LABEL[value]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-series-interval">
                      Every
                    </label>
                    <input
                      id="tm-series-interval"
                      type="number"
                      min={1}
                      className="tm-field__control"
                      value={interval}
                      onChange={(event) => setInterval(event.target.value)}
                      required
                    />
                  </div>
                </div>
                <span className="tm-field__hint">
                  1 = every {UNIT[freq]}, 2 = every other, and so on.
                </span>
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-series-until">
                    Ends (optional)
                  </label>
                  <input
                    id="tm-series-until"
                    type="date"
                    className="tm-field__control"
                    value={until}
                    onChange={(event) => setUntil(event.target.value)}
                  />
                  <span className="tm-field__hint">Leave empty for an open-ended series.</span>
                </div>

                {create.isError ? (
                  <InlineAlert tone="danger" title="Could not create the series" live>
                    {create.error instanceof ApiRequestError
                      ? create.error.message
                      : 'The API did not answer. Try again.'}
                  </InlineAlert>
                ) : null}

                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={create.isPending}
                  loadingLabel="Creating"
                  disabled={!canCreate}
                >
                  Create series
                </Button>
              </form>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/** The unit a frequency counts in, for "Every 2 weeks". */
const UNIT: Record<MeetingSeriesFreq, string> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
};

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
