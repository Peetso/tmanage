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
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState } from '../help/TeachingEmptyState';
import { CalendarHeaderActions, CalendarSubnav, MeetingTrack, clockLabel } from './MeetingsScreen';
import '../../styles/screens/calendar.css';

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
  const t = useT();
  const defaults = useMemo(currentMonthRange, []);
  const [from, setFrom] = useState<string>(defaults.from);
  const [to, setTo] = useState<string>(defaults.to);

  const rangeValid =
    from !== '' && to !== '' && from <= to && windowDays(from, to) <= MAX_WINDOW_DAYS;

  const agenda = useQuery({
    queryKey: ['meeting-agenda', organizationSlug, from, to],
    queryFn: () => getMeetingAgenda(api, organizationSlug, { from, to }),
    enabled: rangeValid,
  });

  const days = useMemo(() => agenda.data?.days ?? [], [agenda.data]);
  const allMeetings = useMemo(() => days.flatMap((day) => day.meetings), [days]);
  const now = Date.now();
  const nextId = useMemo(() => {
    let best: { id: string; at: number } | null = null;
    for (const meeting of allMeetings) {
      const at = Date.parse(meeting.startsAt);
      if (Number.isNaN(at) || at < now) continue;
      if (best === null || at < best.at) best = { id: meeting.id, at };
    }
    return best?.id ?? null;
  }, [allMeetings, now]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title={t('MeetingAgendaScreen.title')}
      eyebrow={t('MeetingAgendaScreen.eyebrow')}
      actions={<CalendarHeaderActions organizationSlug={organizationSlug} current="agenda" />}
    >
      <div className="tm-cal">
        <CalendarSubnav organizationSlug={organizationSlug} />

        {allMeetings.length > 0 ? (
          <MeetingTrack
            organizationSlug={organizationSlug}
            label={t('MeetingAgendaScreen.trackLabel')}
            meetings={allMeetings}
            nextId={nextId}
            now={now}
          />
        ) : null}

        <div className="tm-cal-body">
          <div className="tm-cal-main">
            {!rangeValid ? (
              <InlineAlert tone="warning" title={t('MeetingAgendaScreen.rangeInvalidTitle')}>
                {t('MeetingAgendaScreen.rangeInvalidBodyBefore')} {MAX_WINDOW_DAYS}{' '}
                {t('MeetingAgendaScreen.rangeInvalidBodyAfter')}
              </InlineAlert>
            ) : null}

            {agenda.isError ? (
              <InlineAlert tone="danger" title={t('MeetingAgendaScreen.loadErrorTitle')} live>
                {describeError(t, agenda.error)}
              </InlineAlert>
            ) : null}

            {rangeValid && agenda.isPending ? (
              <LoadingRegion label={t('MeetingAgendaScreen.loadingLabel')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {rangeValid && !agenda.isPending && !agenda.isError && days.length === 0 ? (
              <TeachingEmptyState
                title={t('MeetingAgendaScreen.emptyTitle')}
                explanation={t('teachEmpty.meetingAgendaBody')}
              />
            ) : null}

            {days.length > 0 ? (
              <div className="tm-cal-sheet">
                <div
                  className="tm-cal-sheet__scroll"
                  // A scrollable region must be focusable or a keyboard cannot reach its overflow
                  // columns (WCAG 2.2 2.1.1), matching WorkCalendarScreen's table.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                  tabIndex={0}
                  role="region"
                  aria-label={t('MeetingAgendaScreen.regionAria')}
                >
                  <table>
                    <caption className="tm-visually-hidden">
                      {t('MeetingAgendaScreen.captionBefore')} {allMeetings.length}{' '}
                      {t('MeetingAgendaScreen.captionAfter')}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('MeetingAgendaScreen.colTime')}</th>
                        <th scope="col">{t('MeetingAgendaScreen.colWhat')}</th>
                        <th scope="col">{t('MeetingAgendaScreen.colKind')}</th>
                      </tr>
                    </thead>
                    {days.map((day) => (
                      <tbody key={day.date} aria-labelledby={`tm-agenda-day-${day.date}`}>
                        <tr className="tm-cal-sheet__day">
                          <th id={`tm-agenda-day-${day.date}`} scope="colgroup" colSpan={3}>
                            {formatDay(day.date)} · {day.meetings.length}{' '}
                            {day.meetings.length === 1
                              ? t('MeetingAgendaScreen.meetingSingular')
                              : t('MeetingAgendaScreen.meetingPlural')}
                          </th>
                        </tr>
                        {day.meetings.map((meeting) => {
                          const at = Date.parse(meeting.startsAt);
                          const state =
                            meeting.id === nextId
                              ? 'next'
                              : !Number.isNaN(at) && at < now
                                ? 'done'
                                : 'later';
                          return (
                            <tr key={meeting.id} data-state={state}>
                              <td className="tm-cal-sheet__time">
                                <time dateTime={meeting.startsAt}>
                                  {clockLabel(meeting.startsAt)}
                                </time>
                              </td>
                              <th scope="row" className="tm-cal-sheet__what">
                                <Link href={`/${organizationSlug}/calendar/meetings/${meeting.id}`}>
                                  {meeting.title}
                                </Link>
                                <span className="tm-cal-sheet__sub">
                                  {formatInstant(meeting.startsAt)}
                                </span>
                              </th>
                              <td className="tm-cal-sheet__kind">
                                {state === 'next' ? (
                                  <span className="tm-cal-pill tm-cal-pill--lime">
                                    {t('MeetingAgendaScreen.kindNext')}
                                  </span>
                                ) : state === 'done' ? (
                                  t('MeetingAgendaScreen.kindDone')
                                ) : (
                                  t('MeetingAgendaScreen.kindMeeting')
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    ))}
                  </table>
                </div>
              </div>
            ) : null}
          </div>

          <div className="tm-cal-side">
            <section className="tm-cal-card" aria-labelledby="tm-agenda-filters">
              <h2 id="tm-agenda-filters" className="tm-cal-eyebrow">
                {t('MeetingAgendaScreen.rangeHeading')}
              </h2>
              <fieldset className="tm-fieldset tm-stack">
                <div className="tm-cal-form-row">
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-agenda-from">
                      {t('MeetingAgendaScreen.fromLabel')}
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
                      {t('MeetingAgendaScreen.toLabel')}
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
                </div>
                <span className="tm-field__hint">
                  {t('MeetingAgendaScreen.hintBefore')} {MAX_WINDOW_DAYS}{' '}
                  {t('MeetingAgendaScreen.hintAfter')}
                </span>
              </fieldset>
            </section>
          </div>
        </div>
      </div>
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

function describeError(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('MeetingAgendaScreen.errorNetwork');
  return t('MeetingAgendaScreen.errorGeneric');
}
