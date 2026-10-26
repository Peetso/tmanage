'use client';

import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { createMeeting, listAllMeetings, listAllProjects } from '../../lib/api/meetings';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/calendar.css';

export interface MeetingsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a project — how a project screen could hand off to its meetings. */
  initialProjectId?: string;
  client?: ApiClient;
}

/**
 * **CAL-01 / MTG-01 — the calendar meetings screen (x122).**
 *
 * `22-SCREEN-BY-SCREEN` §1 names Calendar the fifth internal-rail destination, and
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Calendar asks for the meetings a project holds and a way
 * to schedule one. x90 landed the API (`GET`/`POST …/meetings`) and x105/x108 the notes read
 * screen, but the `/calendar` route was still `PlannedInternalScreen` — backend-only, no UI, no
 * journey (audit Top-10 #8). This screen is the missing list/create surface, and the click-through
 * from here into a meeting's notes is what earns module 9 its credit.
 *
 * ## What it draws, and what it cannot
 *
 * - **A project's meetings** — the list is per-project by definition. The API requires a
 *   `projectId` and never lists a whole tenant's meetings, so the screen chooses a project and
 *   shows that project's meetings; the scoping is the server's, carried as a query parameter, not
 *   a client-side filter. Each row links to the existing `calendar/meetings/[meetingId]` notes
 *   page (x108).
 * - **Scheduling a meeting** — a create form in the chosen project (title, a start instant, an
 *   optional agenda note) → `POST /meetings` behind `meeting.write`. On success the new meeting
 *   is listed; a `meeting.write` refusal is shown in the form, the list untouched.
 * - **The calendar grid/agenda, attendees/RSVP, recurrence and ICS export are not here.** They
 *   have no endpoint or table yet and are deferred to NEXT-SCOPES-12; this slice does not fabricate
 *   them, the same honesty the sibling read screens keep.
 *
 * The default is **All meetings**: every readable project's meetings, merged (the API lists per
 * project, so {@link listAllMeetings} reads them all). Choosing a project narrows the list and opens
 * the create form — a new meeting needs a project.
 */
export function MeetingsScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
}: MeetingsScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();

  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const [title, setTitle] = useState('');
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [agendaNote, setAgendaNote] = useState('');

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listAllProjects(api, organizationSlug),
  });

  // `''` is "All meetings": every project the projects query returned. A chosen project reads only
  // its own meetings. Both walk every page, so no meeting is cut off at the API's page size.
  const meetings = useQuery({
    queryKey: ['meetings', organizationSlug, projectId === '' ? 'all' : projectId],
    queryFn: async () => ({
      meetings: await listAllMeetings(
        api,
        organizationSlug,
        projectId === '' ? (projects.data ?? []).map((project) => project.id) : [projectId],
      ),
    }),
    enabled: projectId !== '' || projects.isSuccess,
  });

  const create = useMutation({
    mutationFn: () =>
      createMeeting(api, organizationSlug, {
        projectId,
        title: title.trim(),
        // A `datetime-local` value is a wall-clock string with no zone; `new Date` reads it in the
        // browser's zone and `toISOString` normalises it to the UTC instant the API stores.
        startsAt: new Date(startsAtLocal).toISOString(),
        ...(agendaNote.trim() === '' ? {} : { agendaNote: agendaNote.trim() }),
      }),
    onSuccess: () => {
      setTitle('');
      setStartsAtLocal('');
      setAgendaNote('');
      // Both the chosen project's list and the All view hold the new meeting.
      void queries.invalidateQueries({ queryKey: ['meetings', organizationSlug] });
    },
  });

  // Newest first for reading — `listAllMeetings` already orders by id descending (creation order).
  const rows = useMemo(() => meetings.data?.meetings ?? [], [meetings.data]);

  const canCreate = projectId !== '' && title.trim() !== '' && startsAtLocal !== '';

  function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    create.mutate();
  }

  // The first meeting still ahead gets the lime edge (CAL-02's live/next row); past ones are struck.
  const now = Date.now();
  const nextId = useMemo(() => {
    let best: { id: string; at: number } | null = null;
    for (const meeting of rows) {
      const at = Date.parse(meeting.startsAt);
      if (Number.isNaN(at) || at < now) continue;
      if (best === null || at < best.at) best = { id: meeting.id, at };
    }
    return best?.id ?? null;
  }, [rows, now]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title={t('MeetingsScreen.title')}
      eyebrow={t('MeetingsScreen.eyebrow')}
      actions={<CalendarHeaderActions organizationSlug={organizationSlug} current="meetings" />}
    >
      <div className="tm-cal">
        <CalendarSubnav organizationSlug={organizationSlug} />

        {rows.length > 0 ? (
          <MeetingTrack
            organizationSlug={organizationSlug}
            label={t('MeetingsScreen.trackLabel')}
            meetings={rows}
            nextId={nextId}
            now={now}
          />
        ) : null}

        <div className="tm-cal-body">
          <div className="tm-cal-main">
            {meetings.isError ? (
              <InlineAlert tone="danger" title={t('MeetingsScreen.loadErrorTitle')} live>
                {describeError(t, meetings.error)}
              </InlineAlert>
            ) : null}

            {meetings.isPending && !projects.isError ? (
              <LoadingRegion label={t('MeetingsScreen.loadingLabel')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {!meetings.isPending && !meetings.isError && rows.length === 0 ? (
              <InlineAlert tone="neutral" title={t('MeetingsScreen.emptyTitle')}>
                {/* The body speaks of "this project"; the All view has no single project. */}
                {projectId !== '' ? t('MeetingsScreen.emptyBody') : null}
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
                  aria-label={t('MeetingsScreen.regionAria')}
                >
                  <table>
                    <caption className="tm-visually-hidden">
                      {t('MeetingsScreen.captionBefore')} {rows.length}{' '}
                      {t('MeetingsScreen.captionAfter')}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('MeetingsScreen.colTime')}</th>
                        <th scope="col">{t('MeetingsScreen.colWhat')}</th>
                        <th scope="col">{t('MeetingsScreen.colKind')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((meeting) => {
                        const state = meetingState(meeting.startsAt, meeting.id === nextId, now);
                        return (
                          <tr key={meeting.id} data-state={state}>
                            <td className="tm-cal-sheet__time">
                              <time dateTime={meeting.startsAt}>{whenLabel(meeting.startsAt)}</time>
                            </td>
                            <th scope="row" className="tm-cal-sheet__what">
                              <Link href={`/${organizationSlug}/calendar/meetings/${meeting.id}`}>
                                {meeting.title}
                              </Link>
                              <span className="tm-cal-sheet__sub">
                                {meeting.agendaNote ? `${meeting.agendaNote} · ` : ''}
                                {t('MeetingsScreen.createdPrefix')}{' '}
                                {formatInstant(meeting.createdAt)}
                              </span>
                            </th>
                            <td className="tm-cal-sheet__kind">
                              {state === 'next' ? (
                                <span className="tm-cal-pill tm-cal-pill--lime">
                                  {t('MeetingsScreen.kindNext')}
                                </span>
                              ) : state === 'done' ? (
                                t('MeetingsScreen.kindDone')
                              ) : (
                                t('MeetingsScreen.kindMeeting')
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>

          <div className="tm-cal-side">
            <section className="tm-cal-card" aria-labelledby="tm-meetings-filter">
              <h2 id="tm-meetings-filter" className="tm-cal-eyebrow">
                {t('MeetingsScreen.projectHeading')}
              </h2>
              {/*
                Inert until the projects query has answered — both controlled inputs are rendered in
                the server HTML, so without this a project chosen before React hydrated would be
                re-applied from state (`''`) and silently undone. `isError` means
                `isPending === false`, so a failed project list still leaves the control usable.
              */}
              <fieldset className="tm-fieldset tm-stack" disabled={projects.isPending}>
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-meetings-project">
                    {t('MeetingsScreen.showMeetingsForLabel')}
                  </label>
                  <select
                    id="tm-meetings-project"
                    className="tm-field__control"
                    value={projectId}
                    onChange={(event) => setProjectId(event.target.value)}
                  >
                    <option value="">{t('MeetingsScreen.backAllMeetings')}</option>
                    {(projects.data ?? []).map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="tm-field__hint">{t('MeetingsScreen.projectHint')}</span>
              </fieldset>
            </section>

            {projectId !== '' ? (
              <section className="tm-cal-card" aria-labelledby="tm-meetings-create">
                <h2 id="tm-meetings-create" className="tm-cal-eyebrow">
                  {t('MeetingsScreen.createHeading')}
                </h2>
                <form className="tm-cal-form" onSubmit={submitCreate}>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-meetings-title">
                      {t('MeetingsScreen.titleLabel')}
                    </label>
                    <input
                      id="tm-meetings-title"
                      className="tm-field__control"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      maxLength={300}
                      required
                    />
                  </div>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-meetings-starts">
                      {t('MeetingsScreen.startsLabel')}
                    </label>
                    <input
                      id="tm-meetings-starts"
                      type="datetime-local"
                      className="tm-field__control"
                      value={startsAtLocal}
                      onChange={(event) => setStartsAtLocal(event.target.value)}
                      required
                    />
                    <span className="tm-field__hint">{t('MeetingsScreen.startsHint')}</span>
                  </div>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-meetings-agenda">
                      {t('MeetingsScreen.agendaLabel')}
                    </label>
                    <textarea
                      id="tm-meetings-agenda"
                      className="tm-field__control"
                      value={agendaNote}
                      onChange={(event) => setAgendaNote(event.target.value)}
                      maxLength={8000}
                      rows={3}
                    />
                  </div>

                  {create.isError ? (
                    <InlineAlert tone="danger" title={t('MeetingsScreen.createErrorTitle')} live>
                      {create.error instanceof ApiRequestError
                        ? create.error.message
                        : t('MeetingsScreen.apiNoAnswer')}
                    </InlineAlert>
                  ) : null}

                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    loading={create.isPending}
                    loadingLabel={t('MeetingsScreen.schedulingLabel')}
                    disabled={!canCreate}
                  >
                    {t('MeetingsScreen.createSubmit')}
                  </Button>
                </form>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/** A meeting as the track draws it — the subset of the API row it reads. */
export interface TrackMeeting {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
}

/**
 * CAL-02's track: one black capsule of real meetings in time order — finished ones muted with a
 * tick, the next one in lime, later ones outlined — and an arrow out to the agenda. It shows at
 * most six slots around the next meeting; the sheet below holds the full list and its links.
 */
export function MeetingTrack({
  organizationSlug,
  label,
  meetings,
  nextId,
  now,
}: {
  organizationSlug: string;
  label: string;
  meetings: readonly TrackMeeting[];
  nextId: string | null;
  now: number;
}) {
  const t = useT();
  const ordered = [...meetings].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const nextIndex = nextId === null ? ordered.length : ordered.findIndex((m) => m.id === nextId);
  const start = Math.max(0, Math.min(nextIndex - 2, ordered.length - 6));
  const slots = ordered.slice(start, start + 6);
  const next = ordered.find((m) => m.id === nextId);
  const today = new Date(now);
  return (
    <section className="tm-cal-track-block" aria-labelledby="tm-cal-track-label">
      <p className="tm-cal-subnav">
        <span id="tm-cal-track-label" className="tm-cal-subnav__label">
          {label}
        </span>
        <span>
          {meetings.length}{' '}
          {meetings.length === 1
            ? t('MeetingsScreen.meetingSingular')
            : t('MeetingsScreen.meetingPlural')}
          {next
            ? ` · ${t('MeetingsScreen.nextLabel')} ${whenLabel(next.startsAt)}`
            : ` · ${t('MeetingsScreen.noneAhead')}`}
        </span>
      </p>
      <ol className="tm-cal-track" aria-labelledby="tm-cal-track-label">
        <li className="tm-cal-track__lead">
          <span className="tm-cal-track__day" aria-hidden="true">
            {String(today.getDate()).padStart(2, '0')}
          </span>
          <span>{t('MeetingsScreen.today')}</span>
        </li>
        {slots.map((meeting) => {
          const state = meetingState(meeting.startsAt, meeting.id === nextId, now);
          return (
            <li key={meeting.id} className="tm-cal-track__item">
              {/* Not a link: the sheet below links each meeting, and a second link with the same
                  name would make "the link called <title>" ambiguous. */}
              <span className="tm-cal-track__slot" data-state={state}>
                <span className="tm-cal-track__time">
                  {state === 'next' ? t('MeetingsScreen.nextSlotPrefix') : ''}
                  {whenLabel(meeting.startsAt)}
                </span>
                <span className="tm-cal-track__label">{meeting.title}</span>
                {state === 'done' ? (
                  <>
                    <span className="tm-cal-track__tick" aria-hidden="true">
                      ✓
                    </span>
                    <span className="tm-visually-hidden">{t('MeetingsScreen.doneHidden')}</span>
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
        <li className="tm-cal-track__end">
          <Link
            href={`/${organizationSlug}/calendar/agenda`}
            className="tm-cal-track__out"
            aria-label={t('MeetingsScreen.openAgendaAria')}
          >
            ↗
          </Link>
        </li>
      </ol>
    </section>
  );
}

/** Which calendar view is current — the header switch marks it with `aria-current`. */
export type CalendarView = 'meetings' | 'week' | 'month' | 'agenda' | 'none';

/**
 * CAL-02's header end: the "Meetings · Week · Month · Agenda" switch and the ink "Protect focus"
 * capsule. Each segment is a link to a real route, so the switch is plain navigation.
 */
export function CalendarHeaderActions({
  organizationSlug,
  current,
}: {
  organizationSlug: string;
  current: CalendarView;
}) {
  const t = useT();
  const base = `/${organizationSlug}/calendar`;
  const views: readonly { id: CalendarView; label: string; href: string }[] = [
    { id: 'meetings', label: t('MeetingsScreen.viewMeetings'), href: base },
    { id: 'week', label: t('MeetingsScreen.viewWeek'), href: `${base}/grid?range=week` },
    { id: 'month', label: t('MeetingsScreen.viewMonth'), href: `${base}/grid?range=month` },
    { id: 'agenda', label: t('MeetingsScreen.viewAgenda'), href: `${base}/agenda` },
  ];
  return (
    <div className="tm-cal-header-actions">
      <nav className="tm-cal-views" aria-label={t('MeetingsScreen.viewsAria')}>
        {views.map((view) => (
          <Link
            key={view.id}
            href={view.href}
            className="tm-cal-views__item"
            {...(view.id === current ? { 'aria-current': 'page' as const } : {})}
          >
            {view.label}
          </Link>
        ))}
      </nav>
      <Link href={`${base}/focus-blocks`} className="tm-cal-btn tm-cal-btn--ink tm-cal-btn--header">
        {t('MeetingsScreen.protectFocus')}
      </Link>
    </div>
  );
}

/** The quiet line under the header that reaches the calendar's other surfaces. */
export function CalendarSubnav({
  organizationSlug,
  current,
}: {
  organizationSlug: string;
  current?: 'series' | 'agenda-templates' | 'focus-blocks';
}) {
  const t = useT();
  const base = `/${organizationSlug}/calendar`;
  const links: readonly { id: string; label: string; href: string }[] = [
    { id: 'series', label: t('MeetingsScreen.subRecurring'), href: `${base}/series` },
    {
      id: 'agenda-templates',
      label: t('MeetingsScreen.subAgendaTemplates'),
      href: `${base}/agenda-templates`,
    },
    { id: 'focus-blocks', label: t('MeetingsScreen.subFocusBlocks'), href: `${base}/focus-blocks` },
  ];
  return (
    <nav className="tm-cal-subnav" aria-label={t('MeetingsScreen.subnavAria')}>
      <span className="tm-cal-subnav__label">{t('MeetingsScreen.subnavLabel')}</span>
      {links.map((link) => (
        <Link
          key={link.id}
          href={link.href}
          {...(link.id === current ? { 'aria-current': 'page' as const } : {})}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

/** A meeting's own pages, switched like the calendar views (MTG-01 / MTG-03 / CAL-03). */
export type MeetingPage =
  'overview' | 'notes' | 'attendees' | 'rsvp' | 'time-poll' | 'action-items';

export function MeetingHeaderActions({
  organizationSlug,
  meetingId,
  current,
  children,
}: {
  organizationSlug: string;
  meetingId: string;
  current: MeetingPage;
  /** Trailing controls, e.g. the ICS export capsule. */
  children?: ReactNode;
}) {
  const t = useT();
  const tOr = useTOr();
  const base = `/${organizationSlug}/calendar/meetings/${encodeURIComponent(meetingId)}`;
  const views: readonly { id: MeetingPage; label: string; href: string }[] = [
    // A5: the meeting's detail is its Overview; the notes moved to their own `/notes` page.
    { id: 'overview', label: tOr('MeetingsScreen.mtgOverview', 'Overview'), href: base },
    { id: 'notes', label: t('MeetingsScreen.mtgNotes'), href: `${base}/notes` },
    { id: 'attendees', label: t('MeetingsScreen.mtgAttendees'), href: `${base}/attendees` },
    { id: 'rsvp', label: t('MeetingsScreen.mtgRsvp'), href: `${base}/rsvp` },
    { id: 'time-poll', label: t('MeetingsScreen.mtgTimePoll'), href: `${base}/time-poll` },
    { id: 'action-items', label: t('MeetingsScreen.mtgActions'), href: `${base}/action-items` },
  ];
  return (
    <div className="tm-cal-header-actions">
      {meetingId !== '' ? (
        <nav className="tm-cal-views" aria-label={t('MeetingsScreen.mtgNavAria')}>
          {views.map((view) => (
            <Link
              key={view.id}
              href={view.href}
              className="tm-cal-views__item"
              {...(view.id === current ? { 'aria-current': 'page' as const } : {})}
            >
              {view.label}
            </Link>
          ))}
        </nav>
      ) : null}
      {children}
    </div>
  );
}

/** The line back to the calendar above a meeting's page. */
export function MeetingBackLink({ organizationSlug }: { organizationSlug: string }) {
  const t = useT();
  return (
    <nav className="tm-cal-subnav" aria-label={t('MeetingsScreen.backAria')}>
      <span className="tm-cal-subnav__label">{t('MeetingsScreen.backLabel')}</span>
      <Link href={`/${organizationSlug}/calendar`}>{t('MeetingsScreen.backAllMeetings')}</Link>
      <Link href={`/${organizationSlug}/calendar/agenda`}>{t('MeetingsScreen.backAgenda')}</Link>
    </nav>
  );
}

/** "Ada Lovelace" → "AL": the initials an avatar orb carries. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '·';
}

/** "Tue 20 Oct · 12:00" — the mono time cell, in the reader's zone. */
export function whenLabel(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const day = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(parsed);
  return `${day.replace(',', '')} · ${clockLabel(iso)}`;
}

/** "12:00" — a 24-hour clock time in the reader's zone. */
export function clockLabel(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
}

function meetingState(startsAt: string, isNext: boolean, now: number): 'done' | 'next' | 'later' {
  if (isNext) return 'next';
  const at = Date.parse(startsAt);
  return !Number.isNaN(at) && at < now ? 'done' : 'later';
}

function describeError(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('MeetingsScreen.errorNetwork');
  return t('MeetingsScreen.errorGeneric');
}
