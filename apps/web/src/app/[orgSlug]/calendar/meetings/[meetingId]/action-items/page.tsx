'use client';

import { use } from 'react';
import { MeetingActionItemsScreen } from '../../../../../../components/screens/MeetingActionItemsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../../lib/fixtures';

/**
 * **CAL / MTG-03 — a meeting's action items (x266).**
 *
 * The meeting is named by the path, so the URL is a link a colleague can be sent. The screen reads
 * and manages that meeting's action items behind `meeting.read`/`meeting.write`; an unknown or
 * cross-tenant id is a 404 from the API, which the screen renders as a not-found state.
 *
 * The organization name is still a fixture, for the same reason as its sibling routes: no endpoint
 * returns the current organization's profile by slug.
 */
export default function MeetingActionItemsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; meetingId: string }>;
}) {
  const { orgSlug, meetingId } = use(params);

  return (
    <MeetingActionItemsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      meetingId={meetingId}
    />
  );
}
