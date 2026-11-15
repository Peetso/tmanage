'use client';

import { use } from 'react';
import { PortalMeetingScreen } from '../../../../../components/screens/PortalMeetingScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * 53-12 — a client person's meeting with one-tap Join (approved Figma 612:34741 EN / 612:35149 AR).
 * The meeting is named by the path so a reminder or an invitation can link straight to it.
 */
export default function PortalMeetingPage({
  params,
}: {
  params: Promise<{ orgSlug: string; meetingId: string }>;
}) {
  const { orgSlug, meetingId } = use(params);
  return (
    <PortalMeetingScreen
      organizationSlug={orgSlug}
      meetingId={meetingId}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
