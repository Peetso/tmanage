'use client';

import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { createMeeting, listMeetings } from '../../lib/api/meetings';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
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
 * A project must be chosen before anything is fetched or created: meetings are per-project, and
 * there is no all-projects read to make.
 */
export function MeetingsScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
}: MeetingsScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const [title, setTitle] = useState('');
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [agendaNote, setAgendaNote] = useState('');

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const meetings = useQuery({
    queryKey: ['meetings', organizationSlug, projectId],
    queryFn: () => listMeetings(api, organizationSlug, projectId),
    enabled: projectId !== '',
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
      void queries.invalidateQueries({ queryKey: ['meetings', organizationSlug, projectId] });
    },
  });

  // Newest first for reading. The server orders by id ascending (creation order); reversing a copy
  // of that view is presentation, not a competing sort on a field the API did not order by.
  const rows = useMemo(
    () => (meetings.data ? [...meetings.data.meetings].reverse() : []),
    [meetings.data],
  );

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
      title="Calendar"
      eyebrow="Calendar · Meetings"
      actions={<CalendarHeaderActions organizationSlug={organizationSlug} current="meetings" />}
    >
      <div className="tm-cal">
        <CalendarSubnav organizationSlug={organizationSlug} />

        {rows.length > 0 ? (
          <MeetingTrack
            organizationSlug={organizationSlug}
            label="Meeting track"
            meetings={rows}
            nextId={nextId}
            now={now}
          />
        ) : null}

        <div className="tm-cal-body">
          <div className="tm-cal-main">
            {projectId === '' ? (
              <InlineAlert tone="neutral" title="Choose a project">
                Pick a project to see its meetings.
              </InlineAlert>
            ) : null}

            {meetings.isError ? (
              <InlineAlert tone="danger" title="Could not load the meetings" live>
                {describeError(meetings.error)}
              </InlineAlert>
            ) : null}

            {projectId !== '' && meetings.isPending ? (
              <LoadingRegion label="Loading the meetings.">
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {projectId !== '' && !meetings.isPending && !meetings.isError && rows.length === 0 ? (
              <InlineAlert tone="neutral" title="No meetings yet">
                This project has no meetings you can see. Schedule one beside the list.
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
                  aria-label="Project meetings"
                >
                  <table>
                    <caption className="tm-visually-hidden">
                      Meetings in this project, newest first, {rows.length} shown.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Time</th>
                        <th scope="col">What</th>
                        <th scope="col">Kind</th>
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
                                Created {formatInstant(meeting.createdAt)}
                              </span>
                            </th>
                            <td className="tm-cal-sheet__kind">
                              {state === 'next' ? (
                                <span className="tm-cal-pill tm-cal-pill--lime">
                                  Meeting · next
                                </span>
                              ) : state === 'done' ? (
                                'Meeting · done'
                              ) : (
                                'Meeting'
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
                Project
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
                    Show the meetings for
                  </label>
                  <select
                    id="tm-meetings-project"
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
                <span className="tm-field__hint">
                  Meetings belong to a project. Choose one to see its meetings and schedule a new
                  one.
                </span>
              </fieldset>
            </section>

            {projectId !== '' ? (
              <section className="tm-cal-card" aria-labelledby="tm-meetings-create">
                <h2 id="tm-meetings-create" className="tm-cal-eyebrow">
                  Schedule a meeting
                </h2>
                <form className="tm-cal-form" onSubmit={submitCreate}>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-meetings-title">
                      Title
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
                      Starts
                    </label>
                    <input
                      id="tm-meetings-starts"
                      type="datetime-local"
                      className="tm-field__control"
                      value={startsAtLocal}
                      onChange={(event) => setStartsAtLocal(event.target.value)}
                      required
                    />
                    <span className="tm-field__hint">
                      The start time, read in your own time zone.
                    </span>
                  </div>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-meetings-agenda">
                      Agenda note (optional)
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
                    <InlineAlert tone="danger" title="Could not schedule the meeting" live>
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
                    loadingLabel="Scheduling"
                    disabled={!canCreate}
                  >
                    Schedule meeting
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
          {meetings.length} {meetings.length === 1 ? 'meeting' : 'meetings'}
          {next ? ` · next ${whenLabel(next.startsAt)}` : ' · none ahead'}
        </span>
      </p>
      <ol className="tm-cal-track" aria-labelledby="tm-cal-track-label">
        <li className="tm-cal-track__lead">
          <span className="tm-cal-track__day" aria-hidden="true">
            {String(today.getDate()).padStart(2, '0')}
          </span>
          <span>Today</span>
        </li>
        {slots.map((meeting) => {
          const state = meetingState(meeting.startsAt, meeting.id === nextId, now);
          return (
            <li key={meeting.id} className="tm-cal-track__item">
              {/* Not a link: the sheet below links each meeting, and a second link with the same
                  name would make "the link called <title>" ambiguous. */}
              <span className="tm-cal-track__slot" data-state={state}>
                <span className="tm-cal-track__time">
                  {state === 'next' ? 'Next · ' : ''}
                  {whenLabel(meeting.startsAt)}
                </span>
                <span className="tm-cal-track__label">{meeting.title}</span>
                {state === 'done' ? (
                  <>
                    <span className="tm-cal-track__tick" aria-hidden="true">
                      ✓
                    </span>
                    <span className="tm-visually-hidden">, done</span>
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
            aria-label="Open the agenda"
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
  const base = `/${organizationSlug}/calendar`;
  const views: readonly { id: CalendarView; label: string; href: string }[] = [
    { id: 'meetings', label: 'Meetings', href: base },
    { id: 'week', label: 'Week', href: `${base}/grid?range=week` },
    { id: 'month', label: 'Month', href: `${base}/grid?range=month` },
    { id: 'agenda', label: 'Agenda', href: `${base}/agenda` },
  ];
  return (
    <div className="tm-cal-header-actions">
      <nav className="tm-cal-views" aria-label="Calendar views">
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
        Protect focus
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
  const base = `/${organizationSlug}/calendar`;
  const links: readonly { id: string; label: string; href: string }[] = [
    { id: 'series', label: 'Recurring series', href: `${base}/series` },
    { id: 'agenda-templates', label: 'Agenda templates', href: `${base}/agenda-templates` },
    { id: 'focus-blocks', label: 'Focus blocks', href: `${base}/focus-blocks` },
  ];
  return (
    <nav className="tm-cal-subnav" aria-label="More in the calendar">
      <span className="tm-cal-subnav__label">Also on the calendar</span>
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
export type MeetingPage = 'notes' | 'attendees' | 'rsvp' | 'time-poll' | 'action-items';

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
  const base = `/${organizationSlug}/calendar/meetings/${encodeURIComponent(meetingId)}`;
  const views: readonly { id: MeetingPage; label: string; href: string }[] = [
    { id: 'notes', label: 'Notes', href: base },
    { id: 'attendees', label: 'Attendees', href: `${base}/attendees` },
    { id: 'rsvp', label: 'RSVP', href: `${base}/rsvp` },
    { id: 'time-poll', label: 'Time poll', href: `${base}/time-poll` },
    { id: 'action-items', label: 'Actions', href: `${base}/action-items` },
  ];
  return (
    <div className="tm-cal-header-actions">
      {meetingId !== '' ? (
        <nav className="tm-cal-views" aria-label="This meeting">
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
  return (
    <nav className="tm-cal-subnav" aria-label="Back to the calendar">
      <span className="tm-cal-subnav__label">Meeting</span>
      <Link href={`/${organizationSlug}/calendar`}>All meetings</Link>
      <Link href={`/${organizationSlug}/calendar/agenda`}>Agenda</Link>
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

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
