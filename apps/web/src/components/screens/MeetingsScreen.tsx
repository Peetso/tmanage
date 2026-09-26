'use client';

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
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

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title="Calendar"
      description="A project's meetings, and a way to schedule one."
    >
      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-meetings-filter">
        <h2 id="tm-meetings-filter" className="tm-eyebrow">
          Project
        </h2>
        {/*
          Inert until the projects query has answered — both controlled inputs are rendered in the
          server HTML, so without this a project chosen before React hydrated would be re-applied
          from state (`''`) and silently undone. `isError` means `isPending === false`, so a failed
          project list still leaves the control usable.
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
            Meetings belong to a project. Choose one to see its meetings and schedule a new one.
          </span>
        </fieldset>
      </section>

      {projectId === '' ? (
        <InlineAlert tone="neutral" title="Choose a project">
          Pick a project above to see its meetings.
        </InlineAlert>
      ) : null}

      {projectId !== '' ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-meetings-create">
          <h2 id="tm-meetings-create" className="tm-eyebrow">
            Schedule a meeting
          </h2>
          <form className="tm-stack" onSubmit={submitCreate}>
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
              <span className="tm-field__hint">The start time, read in your own time zone.</span>
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

            <div className="tm-row">
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
            </div>
          </form>
        </section>
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
          This project has no meetings you can see. Schedule one above.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <div
          className="tm-table-scroll"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
          // (WCAG 2.2 2.1.1), matching the other list screens' tables.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Project meetings"
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Meetings in this project, newest first, {rows.length} shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Starts</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((meeting) => (
                <tr key={meeting.id}>
                  <th scope="row" className="tm-table__title">
                    <Link href={`/${organizationSlug}/calendar/meetings/${meeting.id}`}>
                      {meeting.title}
                    </Link>
                  </th>
                  <td>{formatInstant(meeting.startsAt)}</td>
                  <td>{formatInstant(meeting.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
