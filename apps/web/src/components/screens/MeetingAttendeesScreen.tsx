'use client';

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listMembers } from '../../lib/api/members';
import {
  inviteMeetingAttendee,
  listMeetingAttendees,
  setMeetingAttendeeRsvp,
} from '../../lib/api/meeting-attendees';
import type { AttendeeRsvp } from '../../lib/api/meeting-attendees';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MeetingAttendeesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The meeting whose attendees to read and manage — carried in the route path. */
  meetingId: string;
  client?: ApiClient;
}

const RSVP_LABELS: Readonly<Record<AttendeeRsvp, string>> = {
  invited: 'Invited',
  accepted: 'Accepted',
  declined: 'Declined',
};

const RSVP_ORDER: readonly AttendeeRsvp[] = ['invited', 'accepted', 'declined'];

/**
 * **CAL-01 / MTG-01 — a meeting's attendees and their RSVP (x126).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Calendar asks who is invited to a meeting and whether they
 * are coming — the attendees/RSVP half the calendar audit marked Partial and NS-11 deferred. x122
 * shipped the meetings list/create and x108 the notes read; this is the attendees surface for one
 * meeting, reached from its notes page.
 *
 * ## What it draws, and what it cannot
 *
 * - **The attendees, by name.** The API returns each attendee's `userId` and RSVP in the server's
 *   deterministic order; the member directory (`listMembers`) maps a `userId` to a display name, so
 *   the roster's identity is what the screen shows, never an opaque id. RSVP is a {@link StateCapsule}
 *   whose word and colour differ, and it can be changed inline (→ `PATCH …/attendees/:id`).
 * - **Inviting a member.** A member picker (drawn from the directory, minus those already invited)
 *   posts the chosen `userId` behind `meeting.write`. A refusal is shown in the form, the list
 *   untouched.
 * - **Email invites and ICS attachments are not here.** They are deferred to NS-13; this slice does
 *   not fabricate them.
 *
 * A meeting id is required, and the API resolves it tenant-scoped before the relation check, so an
 * unknown or cross-tenant id comes back 404 and the screen shows a not-found state — never an empty
 * list that would confirm the meeting exists.
 */
export function MeetingAttendeesScreen({
  organizationSlug,
  organizationName,
  meetingId,
  client,
}: MeetingAttendeesScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [inviteUserId, setInviteUserId] = useState('');

  const attendees = useQuery({
    queryKey: ['meeting-attendees', organizationSlug, meetingId],
    queryFn: () => listMeetingAttendees(api, organizationSlug, meetingId),
    enabled: meetingId !== '',
  });

  const members = useQuery({
    queryKey: ['members', organizationSlug],
    queryFn: () => listMembers(api, organizationSlug),
  });

  const nameByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members.data?.members ?? []) map.set(m.userId, m.displayName);
    return map;
  }, [members.data]);

  const rows = useMemo(() => attendees.data?.attendees ?? [], [attendees.data]);
  const invitedUserIds = useMemo(() => new Set(rows.map((r) => r.userId)), [rows]);

  // The members not already invited — the pool the picker offers.
  const invitable = useMemo(
    () => (members.data?.members ?? []).filter((m) => !invitedUserIds.has(m.userId)),
    [members.data, invitedUserIds],
  );

  const invite = useMutation({
    mutationFn: () =>
      inviteMeetingAttendee(api, organizationSlug, meetingId, { userId: inviteUserId }),
    onSuccess: () => {
      setInviteUserId('');
      void queries.invalidateQueries({
        queryKey: ['meeting-attendees', organizationSlug, meetingId],
      });
    },
  });

  const rsvp = useMutation({
    mutationFn: (input: { attendeeId: string; rsvp: AttendeeRsvp }) =>
      setMeetingAttendeeRsvp(api, organizationSlug, meetingId, input.attendeeId, input.rsvp),
    onSuccess: () => {
      void queries.invalidateQueries({
        queryKey: ['meeting-attendees', organizationSlug, meetingId],
      });
    },
  });

  const notFound =
    attendees.isError &&
    attendees.error instanceof ApiRequestError &&
    attendees.error.status === 404;

  function submitInvite(event: FormEvent) {
    event.preventDefault();
    if (inviteUserId === '') return;
    invite.mutate();
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title="Meeting attendees"
      description="Who is invited to this meeting, and whether they are coming."
    >
      {meetingId === '' ? (
        <InlineAlert tone="neutral" title="No meeting chosen">
          Open a meeting to see and manage its attendees.
        </InlineAlert>
      ) : null}

      {notFound ? (
        <InlineAlert tone="neutral" title="Meeting not found" live>
          This meeting does not exist or you do not have access to it.
        </InlineAlert>
      ) : null}

      {attendees.isError && !notFound ? (
        <InlineAlert tone="danger" title="Could not load the attendees" live>
          {describeError(attendees.error)}
        </InlineAlert>
      ) : null}

      {meetingId !== '' && !notFound ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-attendees-invite">
          <h2 id="tm-attendees-invite" className="tm-eyebrow">
            Invite a member
          </h2>
          <form className="tm-stack" onSubmit={submitInvite}>
            <fieldset className="tm-fieldset tm-stack" disabled={members.isPending}>
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-attendees-member">
                  Member
                </label>
                <select
                  id="tm-attendees-member"
                  className="tm-field__control"
                  value={inviteUserId}
                  onChange={(event) => setInviteUserId(event.target.value)}
                >
                  <option value="">Choose a member…</option>
                  {invitable.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>

            {invite.isError ? (
              <InlineAlert tone="danger" title="Could not invite the member" live>
                {invite.error instanceof ApiRequestError
                  ? invite.error.message
                  : 'The API did not answer. Try again.'}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={invite.isPending}
                loadingLabel="Inviting"
                disabled={inviteUserId === ''}
              >
                Invite member
              </Button>
            </div>
          </form>
        </section>
      ) : null}

      {meetingId !== '' && attendees.isPending ? (
        <LoadingRegion label="Loading the attendees.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {rsvp.isError ? (
        <InlineAlert tone="danger" title="Could not update the RSVP" live>
          {describeError(rsvp.error)}
        </InlineAlert>
      ) : null}

      {meetingId !== '' && !attendees.isPending && !attendees.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No attendees yet">
          Nobody has been invited to this meeting yet. Invite a member above.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-stack" aria-label="Meeting attendees">
          <ul className="tm-stack tm-list">
            {rows.map((attendee) => (
              <li key={attendee.id} className="tm-panel tm-panel--quiet tm-row">
                <span className="tm-table__title">
                  {nameByUserId.get(attendee.userId) ?? 'A member'}
                </span>
                <StateCapsule state={rsvpCapsule(attendee.rsvp)}>
                  {RSVP_LABELS[attendee.rsvp]}
                </StateCapsule>
                <div className="tm-field tm-push-end">
                  <label className="tm-visually-hidden" htmlFor={`tm-attendee-rsvp-${attendee.id}`}>
                    RSVP for {nameByUserId.get(attendee.userId) ?? 'this member'}
                  </label>
                  <select
                    id={`tm-attendee-rsvp-${attendee.id}`}
                    className="tm-field__control"
                    value={attendee.rsvp}
                    disabled={rsvp.isPending}
                    onChange={(event) =>
                      rsvp.mutate({
                        attendeeId: attendee.id,
                        rsvp: event.target.value as AttendeeRsvp,
                      })
                    }
                  >
                    {RSVP_ORDER.map((value) => (
                      <option key={value} value={value}>
                        {RSVP_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppShell>
  );
}

/**
 * A distinct word, colour and shape per RSVP so the state never rests on colour alone: accepted is
 * `done` (✓), declined is `blocked` (✕), and an unanswered invite is `waiting` (◷).
 */
function rsvpCapsule(rsvp: AttendeeRsvp): CapsuleState {
  if (rsvp === 'accepted') return 'done';
  if (rsvp === 'declined') return 'blocked';
  return 'waiting';
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
