'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import {
  getMeetingAttendance,
  markMeetingAttendance,
  type MeetingAttendancePerson,
} from '../../lib/api/meeting-join';
import { fillTemplate } from '../../lib/ai-approval-presentation';
import { appDateLocale } from '../../lib/i18n/app-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { attendanceTone, clock } from './meeting-join-model';
import { initialsOf } from './MeetingBits';

/**
 * 53-12 — the attendance card (approved Figma 612:34801 EN / 612:35209 AR): name, joined, left,
 * status (present, late by n min, absent with "Mark present"), then "Start meeting notes". Times
 * come from the Join button; the organizer corrects anyone by hand.
 */
export function AttendanceCard({
  api,
  organizationSlug,
  meetingId,
  notesHref,
}: {
  api: ApiClient;
  organizationSlug: string;
  meetingId: string;
  notesHref: string;
}) {
  const tOr = useTOr();
  const queries = useQueryClient();
  const key = ['meeting-attendance', organizationSlug, meetingId];
  const attendance = useQuery({
    queryKey: key,
    queryFn: () => getMeetingAttendance(api, organizationSlug, meetingId),
    retry: false,
  });
  const mark = useMutation({
    mutationFn: (input: { userId: string; status: 'present' | 'absent' }) =>
      markMeetingAttendance(api, organizationSlug, meetingId, input.userId, input.status),
    onSuccess: (data) => queries.setQueryData(key, data),
  });
  const view = attendance.data;
  // Nothing to show before Join opens: the list starts when the meeting can be joined.
  if (!view || view.joinState === 'not_open') return null;
  const locale = appDateLocale();
  const day = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'short' })
    .format(new Date(view.startsAt))
    .replace(',', '');

  const statusLabel = (person: MeetingAttendancePerson): string => {
    switch (person.status) {
      case 'present':
        return `✓ ${tOr('MeetingJoin.present', 'Present')}`;
      case 'late':
        return fillTemplate(tOr('MeetingJoin.late', '{n} min late'), {
          n: String(person.lateMinutes ?? 0),
        });
      case 'absent':
        return `× ${tOr('MeetingJoin.absent', 'Absent')}`;
      default:
        return tOr('MeetingJoin.expected', 'Not joined yet');
    }
  };

  return (
    <section className="tm-mtg-card tm-mtg-attendance" aria-labelledby="tm-mtg-attendance-title">
      <div className="tm-mtg-card__head">
        <div>
          <h2 id="tm-mtg-attendance-title" className="tm-mtg-card__title">
            {tOr('MeetingJoin.attendance', 'Attendance')}
          </h2>
          <p className="tm-mtg-quiet">
            {view.title} · {day}
          </p>
        </div>
        {view.joinState === 'ended' && view.endsAt ? (
          <span className="tm-mtg-pill" data-rsvp="accepted">
            ✓{' '}
            {fillTemplate(tOr('MeetingJoin.endedAt', 'Ended {time}'), {
              time: clock(view.endsAt, locale),
            })}
          </span>
        ) : null}
      </div>
      <table className="tm-mtg-attendance__table">
        <thead>
          <tr>
            <th scope="col">{tOr('MeetingJoin.colName', 'Name')}</th>
            <th scope="col">{tOr('MeetingJoin.colJoined', 'Joined')}</th>
            <th scope="col">{tOr('MeetingJoin.colLeft', 'Left')}</th>
            <th scope="col">{tOr('MeetingJoin.colStatus', 'Status')}</th>
          </tr>
        </thead>
        <tbody>
          {view.people.map((person) => (
            <tr key={person.userId}>
              <th scope="row">
                <span className="tm-mtg-avatar" data-kind={person.kind} aria-hidden="true">
                  {initialsOf(person.displayName, null)}
                </span>
                {person.displayName ?? ''}
              </th>
              <td className="tm-mtg-mono">{clock(person.joinedAt, locale)}</td>
              {/* Leaving is not reported by Meet/Teams links, so the column stays empty. */}
              <td className="tm-mtg-mono">—</td>
              <td>
                <span className="tm-mtg-pill" data-rsvp={attendanceTone(person.status)}>
                  {statusLabel(person)}
                </span>
                {person.status === 'absent' || person.status === 'expected' ? (
                  <button
                    type="button"
                    className="tm-mtg-linkbtn"
                    onClick={() => mark.mutate({ userId: person.userId, status: 'present' })}
                    disabled={mark.isPending}
                  >
                    {tOr('MeetingJoin.markPresent', 'Mark present')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="tm-mtg-linkbtn"
                    onClick={() => mark.mutate({ userId: person.userId, status: 'absent' })}
                    disabled={mark.isPending}
                  >
                    {tOr('MeetingJoin.markAbsent', 'Mark absent')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tm-mtg-hint">
        {tOr(
          'MeetingJoin.attendanceFoot',
          'Times come from the Join button and the quick room. You can correct anyone by hand.',
        )}
      </p>
      <div className="tm-mtg-card__foot">
        <Link className="tm-mtg-btn tm-mtg-btn--ink" href={notesHref}>
          {tOr('MeetingJoin.startNotes', 'Start meeting notes')}
        </Link>
      </div>
    </section>
  );
}
