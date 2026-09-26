'use client';

import { use } from 'react';
import { MeetingAttendeesScreen } from '../../../../../../components/screens/MeetingAttendeesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../../lib/fixtures';

/**
 * **CAL-01 / MTG-01 — a meeting's attendees and their RSVP (x126).**
 *
 * The meeting is named by the path, so the URL is a link a colleague can be sent. The screen reads
 * and manages that meeting's attendees behind `meeting.read`/`meeting.write`; an unknown or
 * cross-tenant id is a 404 from the API, which the screen renders as a not-found state.
 *
 * The organization name is still a fixture, for the same reason as its sibling routes: no endpoint
 * returns the current organization's profile by slug.
 */
export default function MeetingAttendeesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; meetingId: string }>;
}) {
  const { orgSlug, meetingId } = use(params);

  return (
    <MeetingAttendeesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      meetingId={meetingId}
    />
  );
}
