'use client';

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listMembers } from '../../lib/api/members';
import { inviteMeetingAttendee, listMeetingAttendees } from '../../lib/api/meeting-attendees';
import type { AttendeeAnswer } from '../../lib/api/meeting-attendees';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { MeetingBackLink, MeetingHeaderActions, initials } from './MeetingsScreen';
import '../../styles/screens/calendar.css';

export interface MeetingAttendeesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The meeting whose attendees to read and manage — carried in the route path. */
  meetingId: string;
  client?: ApiClient;
}

const RSVP_LABEL_KEYS: Readonly<Record<AttendeeAnswer, MessageKey>> = {
  invited: 'MeetingAttendeesScreen.rsvpInvited',
  accepted: 'MeetingAttendeesScreen.rsvpAccepted',
  declined: 'MeetingAttendeesScreen.rsvpDeclined',
  // Fix 2026-11-09: a "Maybe" given in Google Calendar / Outlook shows as Maybe, not as no answer.
  tentative: 'MeetingRsvpScreen.responseMaybe',
};

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
 *   the roster's identity is what the screen shows, never an opaque id. RSVP is a read-only
 *   {@link StateCapsule} whose word and colour differ: this roster shows who is coming, and a member
 *   changes **their own** response from the RSVP tab (CQ-15, COL-11 — a response is self-only, and
 *   the API refuses setting another member's with a 403).
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
  const t = useT();

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
      title={t('MeetingAttendeesScreen.title')}
      eyebrow={t('MeetingAttendeesScreen.eyebrow')}
      actions={
        <MeetingHeaderActions
          organizationSlug={organizationSlug}
          meetingId={notFound ? '' : meetingId}
          current="attendees"
        />
      }
    >
      <div className="tm-cal">
        <MeetingBackLink organizationSlug={organizationSlug} />

        {meetingId === '' ? (
          <InlineAlert tone="neutral" title={t('MeetingAttendeesScreen.noMeetingTitle')}>
            {t('MeetingAttendeesScreen.noMeetingBody')}
          </InlineAlert>
        ) : null}

        {notFound ? (
          <InlineAlert tone="neutral" title={t('MeetingAttendeesScreen.notFoundTitle')} live>
            {t('MeetingAttendeesScreen.notFoundBody')}
          </InlineAlert>
        ) : null}

        {attendees.isError && !notFound ? (
          <InlineAlert tone="danger" title={t('MeetingAttendeesScreen.loadErrorTitle')} live>
            {describeError(t, attendees.error)}
          </InlineAlert>
        ) : null}

        {meetingId !== '' && !notFound ? (
          <div className="tm-cal-body">
            <div className="tm-cal-main">
              {attendees.isPending ? (
                <LoadingRegion label={t('MeetingAttendeesScreen.loadingLabel')}>
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : null}

              {!attendees.isPending && !attendees.isError && rows.length === 0 ? (
                <InlineAlert tone="neutral" title={t('MeetingAttendeesScreen.emptyTitle')}>
                  {t('MeetingAttendeesScreen.emptyBody')}
                </InlineAlert>
              ) : null}

              {rows.length > 0 ? (
                <section className="tm-cal-card" aria-label={t('MeetingAttendeesScreen.listAria')}>
                  <p className="tm-cal-eyebrow">
                    {t('MeetingAttendeesScreen.participantsLabel')} · {rows.length} ·{' '}
                    {rows.filter((row) => row.rsvp === 'accepted').length}{' '}
                    {t('MeetingAttendeesScreen.acceptedCountLabel')}
                  </p>
                  <p className="tm-cal-note">{t('MeetingAttendeesScreen.rosterNote')}</p>
                  <ul className="tm-cal-items">
                    {rows.map((attendee) => {
                      const name =
                        nameByUserId.get(attendee.userId) ??
                        t('MeetingAttendeesScreen.fallbackMemberName');
                      return (
                        <li
                          key={attendee.id}
                          className={
                            attendee.rsvp === 'invited'
                              ? 'tm-cal-item tm-cal-item--warn'
                              : 'tm-cal-item'
                          }
                        >
                          <span className="tm-cal-avatar" aria-hidden="true">
                            {initials(name)}
                          </span>
                          <span className="tm-cal-item__body">
                            <span className="tm-cal-item__title">{name}</span>
                          </span>
                          <span className="tm-cal-item__end">
                            <StateCapsule state={rsvpCapsule(attendee.rsvp)}>
                              {t(RSVP_LABEL_KEYS[attendee.rsvp])}
                            </StateCapsule>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}
            </div>

            <div className="tm-cal-side">
              <section className="tm-cal-card" aria-labelledby="tm-attendees-invite">
                <h2 id="tm-attendees-invite" className="tm-cal-eyebrow">
                  {t('MeetingAttendeesScreen.inviteHeading')}
                </h2>
                <form className="tm-cal-form" onSubmit={submitInvite}>
                  <fieldset className="tm-fieldset tm-stack" disabled={members.isPending}>
                    <div className="tm-field">
                      <label className="tm-field__label" htmlFor="tm-attendees-member">
                        {t('MeetingAttendeesScreen.memberLabel')}
                      </label>
                      <select
                        id="tm-attendees-member"
                        className="tm-field__control"
                        value={inviteUserId}
                        onChange={(event) => setInviteUserId(event.target.value)}
                      >
                        <option value="">{t('MeetingAttendeesScreen.memberPlaceholder')}</option>
                        {invitable.map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.displayName}
                          </option>
                        ))}
                      </select>
                    </div>
                  </fieldset>

                  {invite.isError ? (
                    <InlineAlert
                      tone="danger"
                      title={t('MeetingAttendeesScreen.inviteErrorTitle')}
                      live
                    >
                      {invite.error instanceof ApiRequestError
                        ? invite.error.message
                        : t('MeetingAttendeesScreen.apiNoAnswer')}
                    </InlineAlert>
                  ) : null}

                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    loading={invite.isPending}
                    loadingLabel={t('MeetingAttendeesScreen.invitingLabel')}
                    disabled={inviteUserId === ''}
                  >
                    {t('MeetingAttendeesScreen.inviteSubmit')}
                  </Button>
                </form>
              </section>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

function rsvpCapsule(rsvp: AttendeeAnswer): CapsuleState {
  if (rsvp === 'accepted') return 'done';
  if (rsvp === 'declined') return 'blocked';
  return 'waiting';
}

function describeError(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('MeetingAttendeesScreen.errorNetwork');
  return t('MeetingAttendeesScreen.errorGeneric');
}
