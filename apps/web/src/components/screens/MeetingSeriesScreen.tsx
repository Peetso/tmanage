'use client';

import { useRef, useMemo, useState } from 'react';
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
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { CalendarHeaderActions, CalendarSubnav } from './MeetingsScreen';
import '../../styles/screens/calendar.css';

export interface MeetingSeriesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** How each frequency reads in the picker and the list. */
const FREQ_LABEL_KEYS: Record<MeetingSeriesFreq, MessageKey> = {
  daily: 'MeetingSeriesScreen.freqDaily',
  weekly: 'MeetingSeriesScreen.freqWeekly',
  monthly: 'MeetingSeriesScreen.freqMonthly',
};

/** The unit a frequency counts in, singular, for "Every week". */
const UNIT_SINGULAR_KEYS: Record<MeetingSeriesFreq, MessageKey> = {
  daily: 'MeetingSeriesScreen.unitDay',
  weekly: 'MeetingSeriesScreen.unitWeek',
  monthly: 'MeetingSeriesScreen.unitMonth',
};

/** The unit a frequency counts in, plural, for "Every 2 weeks". */
const UNIT_PLURAL_KEYS: Record<MeetingSeriesFreq, MessageKey> = {
  daily: 'MeetingSeriesScreen.unitDays',
  weekly: 'MeetingSeriesScreen.unitWeeks',
  monthly: 'MeetingSeriesScreen.unitMonths',
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
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);

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
      title={t('MeetingSeriesScreen.title')}
      eyebrow={t('MeetingSeriesScreen.eyebrow')}
      actions={<CalendarHeaderActions organizationSlug={organizationSlug} current="none" />}
    >
      <div className="tm-cal">
        <CalendarSubnav organizationSlug={organizationSlug} current="series" />

        <div className="tm-cal-body">
          <div className="tm-cal-main">
            {series.isError ? (
              <InlineAlert tone="danger" title={t('MeetingSeriesScreen.loadErrorTitle')} live>
                {describeError(t, series.error)}
              </InlineAlert>
            ) : null}

            {series.isPending ? (
              <LoadingRegion label={t('MeetingSeriesScreen.loadingLabel')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {!series.isPending && !series.isError && rows.length === 0 ? (
              <TeachingEmptyState
                title={t('MeetingSeriesScreen.emptyTitle')}
                explanation={t('teachEmpty.meetingSeriesBody')}
                action={
                  canUse('meeting.write') ? (
                    <Button
                      tone="lime"
                      size="accessible"
                      onClick={() => focusFirstField(firstStep.current)}
                    >
                      {t('teachEmpty.meetingSeriesAction')}
                    </Button>
                  ) : undefined
                }
              />
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
                  aria-label={t('MeetingSeriesScreen.regionAria')}
                >
                  <table>
                    <caption className="tm-visually-hidden">
                      {t('MeetingSeriesScreen.captionBefore')} {rows.length}{' '}
                      {t('MeetingSeriesScreen.captionAfter')}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('MeetingSeriesScreen.colTitle')}</th>
                        <th scope="col">{t('MeetingSeriesScreen.colRepeats')}</th>
                        <th scope="col">{t('MeetingSeriesScreen.colEvery')}</th>
                        <th scope="col">{t('MeetingSeriesScreen.colEnds')}</th>
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
                              {t(FREQ_LABEL_KEYS[row.freq])}
                            </span>
                          </td>
                          <td className="tm-cal-sheet__kind">
                            {row.interval === 1
                              ? `${t('MeetingSeriesScreen.everyLabel')} ${t(UNIT_SINGULAR_KEYS[row.freq])}`
                              : `${t('MeetingSeriesScreen.everyLabel')} ${row.interval} ${t(UNIT_PLURAL_KEYS[row.freq])}`}
                          </td>
                          <td>
                            <span className="tm-cal-chip">
                              {row.until
                                ? `${t('MeetingSeriesScreen.untilPrefix')} ${row.until}`
                                : t('MeetingSeriesScreen.openEnded')}
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
                  {t('MeetingSeriesScreen.previewHeading')}
                </h2>
                <div className="tm-cal-form-row">
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-series-preview-series">
                      {t('MeetingSeriesScreen.seriesLabel')}
                    </label>
                    <select
                      id="tm-series-preview-series"
                      className="tm-field__control"
                      value={previewSeriesId}
                      onChange={(event) => setPreviewSeriesId(event.target.value)}
                    >
                      <option value="">{t('MeetingSeriesScreen.seriesPlaceholder')}</option>
                      {rows.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-series-preview-from">
                      {t('MeetingSeriesScreen.fromLabel')}
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
                      {t('MeetingSeriesScreen.toLabel')}
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
                <span className="tm-field__hint">{t('MeetingSeriesScreen.windowHint')}</span>

                {occurrences.isError ? (
                  <InlineAlert tone="danger" title={t('MeetingSeriesScreen.expandErrorTitle')} live>
                    {describeError(t, occurrences.error)}
                  </InlineAlert>
                ) : null}

                {occurrences.data ? (
                  occurrences.data.occurrences.length === 0 ? (
                    <InlineAlert tone="neutral" title={t('MeetingSeriesScreen.noOccurrencesTitle')}>
                      {t('MeetingSeriesScreen.noOccurrencesBody')}
                    </InlineAlert>
                  ) : (
                    <ul
                      className="tm-chip-row"
                      aria-label={t('MeetingSeriesScreen.occurrencesAria')}
                    >
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
                {t('MeetingSeriesScreen.createHeading')}
              </h2>
              <form noValidate ref={firstStep} className="tm-cal-form" onSubmit={submitCreate}>
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-series-title">
                    {t('MeetingSeriesScreen.titleLabel')}
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
                      {t('MeetingSeriesScreen.repeatsLabel')}
                    </label>
                    <select
                      id="tm-series-freq"
                      className="tm-field__control"
                      value={freq}
                      onChange={(event) => setFreq(event.target.value as MeetingSeriesFreq)}
                    >
                      {MEETING_SERIES_FREQS.map((value) => (
                        <option key={value} value={value}>
                          {t(FREQ_LABEL_KEYS[value])}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-series-interval">
                      {t('MeetingSeriesScreen.everyLabel')}
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
                  {t('MeetingSeriesScreen.freqHintBefore')} {t(UNIT_SINGULAR_KEYS[freq])}
                  {t('MeetingSeriesScreen.freqHintAfter')}
                </span>
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-series-until">
                    {t('MeetingSeriesScreen.endsLabel')}
                  </label>
                  <input
                    id="tm-series-until"
                    type="date"
                    className="tm-field__control"
                    value={until}
                    onChange={(event) => setUntil(event.target.value)}
                  />
                  <span className="tm-field__hint">{t('MeetingSeriesScreen.endsHint')}</span>
                </div>

                {create.isError ? (
                  <InlineAlert tone="danger" title={t('MeetingSeriesScreen.createErrorTitle')} live>
                    {create.error instanceof ApiRequestError
                      ? create.error.message
                      : t('MeetingSeriesScreen.apiNoAnswer')}
                  </InlineAlert>
                ) : null}

                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={create.isPending}
                  loadingLabel={t('MeetingSeriesScreen.creatingLabel')}
                  disabled={!canCreate}
                >
                  {t('MeetingSeriesScreen.createSubmit')}
                </Button>
              </form>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function describeError(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('MeetingSeriesScreen.errorNetwork');
  return t('MeetingSeriesScreen.errorGeneric');
}
