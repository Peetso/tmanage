'use client';

import { use } from 'react';
import { MeetingDetailScreen } from '../../../../../components/screens/MeetingDetailScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **A5 — a meeting's detail (Figma `mt-saved` / `mt-edit`).**
 *
 * The meeting is named by the path, so the URL is a link a colleague can be sent. The screen reads
 * the meeting (found through its project's list — there is no read by id), its attendees and the
 * people who may be added, and edits it behind `meeting.write`. The notes and decisions that used
 * to live here moved to `[meetingId]/notes`, reached from the meeting's sub-navigation.
 *
 * The organization name is still a fixture, for the same reason as its sibling routes: no
 * endpoint returns the current organization's profile by slug.
 */
export default function MeetingDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; meetingId: string }>;
}) {
  const { orgSlug, meetingId } = use(params);

  return (
    <MeetingDetailScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      meetingId={meetingId}
    />
  );
}
