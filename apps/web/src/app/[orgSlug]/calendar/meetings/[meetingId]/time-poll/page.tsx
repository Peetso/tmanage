'use client';

import { use } from 'react';
import { MeetingTimePollView } from '../../../../../../components/screens/MeetingTimePollView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../../lib/fixtures';

/**
 * **CAL meeting time-option poll — vote on when to hold a meeting (x298).**
 *
 * The meeting is named by the path, so the URL is a link an organiser can send to invitees. The
 * screen reads the candidate slots behind `meeting.read` and records the caller's own vote behind
 * `meeting.read`; an unknown or cross-tenant id is a 404 from the API, which the screen renders as a
 * not-found state.
 *
 * The organization name is still a fixture, for the same reason as its sibling routes: no endpoint
 * returns the current organization's profile by slug.
 */
export default function MeetingTimePollPage({
  params,
}: {
  params: Promise<{ orgSlug: string; meetingId: string }>;
}) {
  const { orgSlug, meetingId } = use(params);

  return (
    <MeetingTimePollView
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      meetingId={meetingId}
    />
  );
}
