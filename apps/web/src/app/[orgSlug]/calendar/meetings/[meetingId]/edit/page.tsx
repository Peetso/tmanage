'use client';

import { use } from 'react';
import { MeetingFormScreen } from '../../../../../../components/meetings/MeetingFormScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../../lib/fixtures';

/** **Edit meeting** — the same form as New meeting, filled from the meeting's overview. */
export default function EditMeetingPage({
  params,
}: {
  params: Promise<{ orgSlug: string; meetingId: string }>;
}) {
  const { orgSlug, meetingId } = use(params);
  return (
    <MeetingFormScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      meetingId={meetingId}
    />
  );
}
