'use client';

import { use } from 'react';
import { MeetingRsvpScreen } from '../../../../../../components/screens/MeetingRsvpScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../../lib/fixtures';

/**
 * **CAL meeting RSVP — a member's own response to a meeting (x240).**
 *
 * The meeting is named by the path, so the URL is a link a colleague can be sent. The screen reads
 * the RSVP summary behind `meeting.read` and sets the caller's own response behind `meeting.write`;
 * an unknown or cross-tenant id is a 404 from the API, which the screen renders as a not-found state.
 *
 * The organization name is still a fixture, for the same reason as its sibling routes: no endpoint
 * returns the current organization's profile by slug.
 */
export default function MeetingRsvpPage({
  params,
}: {
  params: Promise<{ orgSlug: string; meetingId: string }>;
}) {
  const { orgSlug, meetingId } = use(params);

  return (
    <MeetingRsvpScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      meetingId={meetingId}
    />
  );
}
