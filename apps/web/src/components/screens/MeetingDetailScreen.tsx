'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { AttendeePicker } from '../calendar/AttendeePicker';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import { getMeeting, updateMeeting } from '../../lib/api/meetings';
import type { MeetingView } from '../../lib/api/meetings';
import {
  inviteClientAttendee,
  inviteMeetingAttendee,
  listMeetingAttendees,
  removeMeetingAttendee,
} from '../../lib/api/meeting-attendees';
import type { AttendeeRsvp } from '../../lib/api/meeting-attendees';
import { listMembers } from '../../lib/api/members';
import { getProject } from '../../lib/api/projects';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { MeetingHeaderActions, clockLabel, initials } from './MeetingsScreen';
import '../../styles/screens/calendar.css';
import './meeting-detail.css';

export interface MeetingDetailScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The meeting to show — carried in the route path. */
  meetingId: string;
  client?: ApiClient;
}

type AttendeeStatus = 'organizer' | AttendeeRsvp;

/** One person on the meeting, member or client, as the card and the chips draw them. */
interface AttendeeRow {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly isClient: boolean;
  readonly status: AttendeeStatus;
}

/** Someone chosen in the picker, invited when the edit is saved. */
interface PendingInvite {
  readonly kind: 'member' | 'client';
  readonly userId: string;
  readonly name: string;
}

interface Draft {
  readonly title: string;
  /** `YYYY-MM-DD`, in the reader's zone. */
  readonly date: string;
  /** `HH:MM`, in the reader's zone. */
  readonly starts: string;
  readonly ends: string;
  readonly note: string;
}

type TOr = (key: string, english: string) => string;

const TOAST_MS = 6000;

/**
 * **A5 — a meeting's detail and its edit (Figma `mt-saved`, `mt-edit`).**
 *
 * The saved view is one card of rows — Date, Time ("10:00 – 11:00"), Attendees (orb, name, a
 * "Client" tag for a client person, and an Organizer / Accepted / Invited pill) and Notes (the
 * agenda note) — under the header's "Add to calendar" (the meeting's `.ics`) and "Edit meeting".
 *
 * "Edit meeting" turns the same card into a form: Title, Date, Starts, Ends, the attendees as
 * chips with × to remove, "+ Add people" (the {@link AttendeePicker}: the team and the client people
 * of this project only) and the notes. "Save changes" sends `PATCH .../meetings/:id` (title, start,
 * end, agenda note — an end that is not after the start is refused here before any request), then
 * removes and invites the attendees that changed, and the green toast says the new attendees get an
 * invitation (the API raises it). Cancel drops the draft without a request.
 *
 * There is no read of one meeting by id, so the meeting is found through its project's list
 * ({@link getMeeting}); an id no readable project holds is the not-found state.
 */
export function MeetingDetailScreen({
  organizationSlug,
  organizationName,
  meetingId,
  client,
}: MeetingDetailScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const tOr = useTOr();
  const locale = useActiveLocale();

  const meetingKey = ['meeting', organizationSlug, meetingId] as const;
  const attendeesKey = ['meeting-attendees', organizationSlug, meetingId] as const;

  const meeting = useQuery({
    queryKey: meetingKey,
    queryFn: () => getMeeting(api, organizationSlug, meetingId),
    enabled: meetingId !== '',
  });
  const current = meeting.data ?? null;

  const project = useQuery({
    queryKey: ['project', organizationSlug, current?.projectId ?? ''],
    queryFn: () => getProject(api, organizationSlug, current?.projectId ?? ''),
    enabled: current !== null,
  });

  const attendees = useQuery({
    queryKey: attendeesKey,
    queryFn: () => listMeetingAttendees(api, organizationSlug, meetingId),
    enabled: current !== null,
  });

  const directory = useQuery({
    queryKey: ['members', organizationSlug],
    queryFn: () => listMembers(api, organizationSlug),
    enabled: current !== null,
  });

  const rows = useMemo<readonly AttendeeRow[]>(() => {
    if (!current || !attendees.data) return [];
    const names = new Map(
      (directory.data?.members ?? []).map((member) => [member.userId, member.displayName]),
    );
    const members = attendees.data.attendees.map<AttendeeRow>((attendee) => ({
      id: attendee.id,
      userId: attendee.userId,
      name: names.get(attendee.userId) ?? '·',
      isClient: false,
      status: attendee.userId === current.createdByUserId ? 'organizer' : attendee.rsvp,
    }));
    // The organizer leads, then the team in the server's order, then the client people.
    members.sort((a, b) => Number(b.status === 'organizer') - Number(a.status === 'organizer'));
    const clients = (attendees.data.clientAttendees ?? []).map<AttendeeRow>((attendee) => ({
      id: attendee.id,
      userId: attendee.userId,
      name: attendee.displayName,
      isClient: true,
      status: attendee.rsvp,
    }));
    return [...members, ...clients];
  }, [current, attendees.data, directory.data]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [invites, setInvites] = useState<readonly PendingInvite[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(false), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const save = useMutation({
    mutationFn: async (input: {
      title: string;
      startsAt: string;
      endsAt: string | null;
      agendaNote: string | null;
    }) => {
      const updated = await updateMeeting(api, organizationSlug, meetingId, input);
      for (const attendeeId of removed) {
        await removeMeetingAttendee(api, organizationSlug, meetingId, attendeeId);
      }
      for (const invite of invites) {
        if (invite.kind === 'client') {
          await inviteClientAttendee(api, organizationSlug, meetingId, invite.userId);
        } else {
          await inviteMeetingAttendee(api, organizationSlug, meetingId, { userId: invite.userId });
        }
      }
      return updated;
    },
    onSuccess: (updated) => {
      queries.setQueryData<MeetingView | null>(meetingKey, updated);
      setEditing(false);
      setPickerOpen(false);
      setRemoved(new Set());
      setInvites([]);
      setToast(true);
    },
    onError: (error) => setFormError(describeError(tOr, error)),
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: attendeesKey });
    },
  });

  function startEditing() {
    if (!current) return;
    setDraft(draftOf(current));
    setRemoved(new Set());
    setInvites([]);
    setFormError(null);
    setToast(false);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setPickerOpen(false);
    setRemoved(new Set());
    setInvites([]);
    setFormError(null);
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const title = draft.title.trim();
    if (title === '') {
      setFormError(tOr('MeetingDetailScreen.titleRequired', 'Give the meeting a title.'));
      return;
    }
    const startsAt = instantOf(draft.date, draft.starts);
    if (startsAt === null) {
      setFormError(tOr('MeetingDetailScreen.startRequired', 'Choose a date and a start time.'));
      return;
    }
    const endsAt = draft.ends === '' ? null : instantOf(draft.date, draft.ends);
    if (draft.ends !== '' && (endsAt === null || Date.parse(endsAt) <= Date.parse(startsAt))) {
      setFormError(
        tOr('MeetingDetailScreen.endAfterStart', 'The meeting has to end after it starts.'),
      );
      return;
    }
    setFormError(null);
    save.mutate({
      title,
      startsAt,
      endsAt,
      agendaNote: draft.note.trim() === '' ? null : draft.note,
    });
  }

  const projectName = project.data?.name ?? '';
  const meetingsWord = tOr('MeetingDetailScreen.eyebrowMeetings', 'Meetings');
  const eyebrow =
    projectName === ''
      ? meetingsWord
      : tOr('MeetingDetailScreen.eyebrow', '{project} · Meetings').replace(
          '{project}',
          projectName,
        );

  const notFound =
    (meeting.isSuccess && current === null) ||
    (meeting.isError && meeting.error instanceof ApiRequestError && meeting.error.status === 404);

  const excluded = useMemo(
    () =>
      new Set([
        ...rows.filter((row) => !removed.has(row.id)).map((row) => row.userId),
        ...invites.map((invite) => invite.userId),
      ]),
    [rows, removed, invites],
  );

  const icsHref = `${apiBaseUrl()}/v1/organizations/${encodeURIComponent(
    organizationSlug,
  )}/meetings/${encodeURIComponent(meetingId)}/ics`;

  const actions = !current ? null : editing ? (
    <div className="tm-mtd-actions">
      <span className="tm-mtd-editing">{tOr('MeetingDetailScreen.editing', 'Editing')}</span>
      <button
        type="button"
        className="tm-cal-btn tm-mtd-btn"
        onClick={cancelEditing}
        disabled={save.isPending}
      >
        {tOr('MeetingDetailScreen.cancel', 'Cancel')}
      </button>
      <button
        type="button"
        className="tm-cal-btn tm-cal-btn--ink tm-mtd-btn"
        onClick={() => submit()}
        disabled={save.isPending}
      >
        {tOr('MeetingDetailScreen.save', 'Save changes')}
      </button>
    </div>
  ) : (
    <div className="tm-mtd-actions">
      <a className="tm-cal-btn tm-mtd-btn" href={icsHref} download={`meeting-${meetingId}.ics`}>
        {tOr('MeetingDetailScreen.addToCalendar', 'Add to calendar')}
      </a>
      <button
        type="button"
        className="tm-cal-btn tm-cal-btn--ink tm-mtd-btn"
        onClick={startEditing}
      >
        {tOr('MeetingDetailScreen.edit', 'Edit meeting')}
      </button>
    </div>
  );

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title={current?.title ?? tOr('MeetingDetailScreen.titleFallback', 'Meeting')}
      eyebrow={eyebrow}
      actions={actions}
    >
      <div className="tm-mtd">
        {toast ? (
          <div className="tm-mtd-toast" role="status">
            <span className="tm-mtd-toast__dot" aria-hidden="true" />
            <span className="tm-mtd-toast__text">
              <span className="tm-mtd-toast__title">
                {tOr('MeetingDetailScreen.toastTitle', 'Meeting saved')}
              </span>
              <span className="tm-mtd-toast__body">
                {tOr('MeetingDetailScreen.toastBody', 'New attendees get an invitation.')}
              </span>
            </span>
          </div>
        ) : null}

        {notFound ? (
          <InlineAlert
            tone="neutral"
            title={tOr('MeetingDetailScreen.notFoundTitle', 'Meeting not found')}
            live
          >
            {tOr(
              'MeetingDetailScreen.notFoundBody',
              'This meeting does not exist, or you cannot see it.',
            )}
          </InlineAlert>
        ) : null}

        {meeting.isError && !notFound ? (
          <InlineAlert
            tone="danger"
            title={tOr('MeetingDetailScreen.loadErrorTitle', 'The meeting could not be loaded')}
            live
          >
            {describeError(tOr, meeting.error)}
          </InlineAlert>
        ) : null}

        {meetingId !== '' && meeting.isPending ? (
          <LoadingRegion label={tOr('MeetingDetailScreen.loadingLabel', 'Loading the meeting')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {current && !editing ? (
          <>
            <section
              className="tm-mtd-card"
              aria-label={tOr('MeetingDetailScreen.detailsAria', 'Meeting details')}
            >
              <dl className="tm-mtd-rows">
                <div className="tm-mtd-row">
                  <dt>{tOr('MeetingDetailScreen.date', 'Date')}</dt>
                  <dd>{longDate(current.startsAt, locale)}</dd>
                </div>
                <div className="tm-mtd-row">
                  <dt>{tOr('MeetingDetailScreen.time', 'Time')}</dt>
                  <dd>
                    {current.endsAt
                      ? `${clockLabel(current.startsAt)} – ${clockLabel(current.endsAt)}`
                      : clockLabel(current.startsAt)}
                  </dd>
                </div>
                <div className="tm-mtd-row">
                  <dt>{tOr('MeetingDetailScreen.attendees', 'Attendees')}</dt>
                  <dd>
                    <ul className="tm-mtd-people">
                      {rows.map((row) => (
                        <li key={row.id} className="tm-mtd-person">
                          <span
                            className={
                              row.isClient
                                ? 'tm-mtd-orb tm-mtd-orb--lg tm-mtd-orb--client'
                                : 'tm-mtd-orb tm-mtd-orb--lg'
                            }
                            aria-hidden="true"
                          >
                            {initials(row.name)}
                          </span>
                          <span className="tm-mtd-person__name">{row.name}</span>
                          {row.isClient ? (
                            <span className="tm-mtd-tag tm-mtd-tag--client">
                              {tOr('MeetingDetailScreen.client', 'Client')}
                            </span>
                          ) : null}
                          <span className={`tm-mtd-status tm-mtd-status--${row.status}`}>
                            {statusLabel(tOr, row.status)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
                <div className="tm-mtd-row">
                  <dt>{tOr('MeetingDetailScreen.notes', 'Notes')}</dt>
                  <dd className="tm-mtd-notes">
                    {current.agendaNote ?? (
                      <span className="tm-mtd-muted">
                        {tOr('MeetingDetailScreen.noNotes', 'No notes yet.')}
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
            </section>
            <div className="tm-mtd-subnav">
              <MeetingHeaderActions
                organizationSlug={organizationSlug}
                meetingId={meetingId}
                current="overview"
              />
            </div>
          </>
        ) : null}

        {current && editing ? (
          <form
            id="tm-mtd-form"
            className="tm-mtd-card tm-mtd-form"
            aria-label={tOr('MeetingDetailScreen.edit', 'Edit meeting')}
            onSubmit={submit}
            noValidate
          >
            {formError ? (
              <InlineAlert
                tone="danger"
                title={tOr('MeetingDetailScreen.saveErrorTitle', 'The changes were not saved')}
                live
              >
                {formError}
              </InlineAlert>
            ) : null}

            <label className="tm-mtd-field">
              <span className="tm-mtd-label">{tOr('MeetingDetailScreen.fieldTitle', 'Title')}</span>
              <input
                className="tm-mtd-input"
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                maxLength={200}
              />
            </label>

            <div className="tm-mtd-when">
              <label className="tm-mtd-field">
                <span className="tm-mtd-label">{tOr('MeetingDetailScreen.date', 'Date')}</span>
                <input
                  className="tm-mtd-input"
                  type="date"
                  value={draft.date}
                  onChange={(event) => setDraft({ ...draft, date: event.target.value })}
                />
              </label>
              <label className="tm-mtd-field">
                <span className="tm-mtd-label">{tOr('MeetingDetailScreen.starts', 'Starts')}</span>
                <input
                  className="tm-mtd-input"
                  type="time"
                  value={draft.starts}
                  onChange={(event) => setDraft({ ...draft, starts: event.target.value })}
                />
              </label>
              <label className="tm-mtd-field">
                <span className="tm-mtd-label">{tOr('MeetingDetailScreen.ends', 'Ends')}</span>
                <input
                  className="tm-mtd-input"
                  type="time"
                  value={draft.ends}
                  onChange={(event) => setDraft({ ...draft, ends: event.target.value })}
                />
              </label>
            </div>

            <fieldset className="tm-mtd-attendees">
              <legend className="tm-mtd-label tm-mtd-label--section">
                {tOr('MeetingDetailScreen.attendees', 'Attendees')}
              </legend>
              <p className="tm-mtd-hint">
                {tOr(
                  'MeetingDetailScreen.clientsHint',
                  'Clients can be added only from this project.',
                )}
              </p>
              <ul className="tm-mtd-chips">
                {rows
                  .filter((row) => !removed.has(row.id))
                  .map((row) => (
                    <li key={row.id} className="tm-mtd-chip">
                      <span
                        className={row.isClient ? 'tm-mtd-orb tm-mtd-orb--client' : 'tm-mtd-orb'}
                        aria-hidden="true"
                      >
                        {initials(row.name)}
                      </span>
                      <span>{row.name}</span>
                      {row.status === 'organizer' ? (
                        <span className="tm-mtd-status tm-mtd-status--organizer">
                          {statusLabel(tOr, 'organizer')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="tm-mtd-chip__remove"
                          aria-label={removeLabel(tOr, row.name)}
                          onClick={() => setRemoved(new Set([...removed, row.id]))}
                        >
                          ×
                        </button>
                      )}
                    </li>
                  ))}
                {invites.map((invite) => (
                  <li key={invite.userId} className="tm-mtd-chip">
                    <span
                      className={
                        invite.kind === 'client' ? 'tm-mtd-orb tm-mtd-orb--client' : 'tm-mtd-orb'
                      }
                      aria-hidden="true"
                    >
                      {initials(invite.name)}
                    </span>
                    <span>{invite.name}</span>
                    <button
                      type="button"
                      className="tm-mtd-chip__remove"
                      aria-label={removeLabel(tOr, invite.name)}
                      onClick={() =>
                        setInvites(invites.filter((other) => other.userId !== invite.userId))
                      }
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>

              <div className="tm-mtd-add">
                <button
                  type="button"
                  className="tm-mtd-add__button"
                  aria-expanded={pickerOpen}
                  onClick={() => setPickerOpen(!pickerOpen)}
                >
                  {tOr('MeetingDetailScreen.addPeople', '+ Add people')}
                </button>
                {pickerOpen ? (
                  <AttendeePicker
                    api={api}
                    organizationSlug={organizationSlug}
                    organizationName={organizationName}
                    meetingId={meetingId}
                    projectName={projectName}
                    excludedUserIds={excluded}
                    onPickMember={(member) => {
                      setInvites([
                        ...invites,
                        { kind: 'member', userId: member.userId, name: member.displayName },
                      ]);
                      setPickerOpen(false);
                    }}
                    onPickClient={(candidate) => {
                      setInvites([
                        ...invites,
                        { kind: 'client', userId: candidate.userId, name: candidate.displayName },
                      ]);
                      setPickerOpen(false);
                    }}
                    onClose={() => setPickerOpen(false)}
                  />
                ) : null}
              </div>
            </fieldset>

            <label className="tm-mtd-field">
              <span className="tm-mtd-label">{tOr('MeetingDetailScreen.notes', 'Notes')}</span>
              <textarea
                className="tm-mtd-input tm-mtd-textarea"
                value={draft.note}
                onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                rows={4}
              />
            </label>
          </form>
        ) : null}
      </div>
    </AppShell>
  );
}

function emptyDraft(): Draft {
  return { title: '', date: '', starts: '', ends: '', note: '' };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The edit form's starting values: the meeting's start and end in the reader's zone. */
function draftOf(meeting: MeetingView): Draft {
  const start = new Date(meeting.startsAt);
  const end = meeting.endsAt ? new Date(meeting.endsAt) : null;
  return {
    title: meeting.title,
    date: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    starts: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
    ends: end ? `${pad(end.getHours())}:${pad(end.getMinutes())}` : '',
    note: meeting.agendaNote ?? '',
  };
}

/** A local date and wall-clock time as the UTC instant the API stores, or `null` if unreadable. */
export function instantOf(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const parsed = new Date(`${date}T${time}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** "Thursday, 29 October 2026" / "الخميس، 29 أكتوبر 2026" — Latin digits in both. */
function longDate(iso: string, locale: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  if (locale.toLowerCase().startsWith('ar')) {
    return new Intl.DateTimeFormat('ar-u-nu-latn', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(parsed);
  }
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(parsed);
  const day = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(parsed);
  return `${weekday}, ${day}`;
}

function statusLabel(tOr: TOr, status: AttendeeStatus): string {
  switch (status) {
    case 'organizer':
      return tOr('MeetingDetailScreen.organizer', 'Organizer');
    case 'accepted':
      return tOr('MeetingDetailScreen.accepted', 'Accepted');
    case 'declined':
      return tOr('MeetingDetailScreen.declined', 'Declined');
    default:
      return tOr('MeetingDetailScreen.invited', 'Invited');
  }
}

function removeLabel(tOr: TOr, name: string): string {
  return tOr('MeetingDetailScreen.remove', 'Remove {name}').replace('{name}', name);
}

function describeError(tOr: TOr, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) {
    return tOr('MeetingDetailScreen.errorNetwork', 'Check your connection and try again.');
  }
  return tOr('MeetingDetailScreen.errorGeneric', 'Something went wrong. Try again.');
}
