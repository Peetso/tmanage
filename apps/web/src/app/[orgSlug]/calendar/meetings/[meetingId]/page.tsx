'use client';

import { use } from 'react';
import { MeetingPageScreen } from '../../../../../components/meetings/MeetingPage';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **A meeting's page (approved Figma 418:10146 EN / 418:10594 AR).**
 *
 * The meeting is named by the path, so the URL is a link a colleague can be sent. One read by id
 * (`GET …/meetings/:meetingId/overview`) replaces the old scan through every project's list, so a
 * meeting in any project opens (owner bug 2). `?saved=1` says the invitations went out.
 */
export default function MeetingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; meetingId: string }>;
  searchParams: Promise<{ saved?: string | string[] }>;
}) {
  const { orgSlug, meetingId } = use(params);
  const { saved } = use(searchParams);
  return (
    <MeetingPageScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      meetingId={meetingId}
      justSaved={saved === '1'}
    />
  );
}
