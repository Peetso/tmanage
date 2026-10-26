'use client';

import { use } from 'react';
import { CalendarConnectionsScreen } from '../../../../components/meetings/CalendarConnections';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Settings › Calendar connections (approved Figma 419:23295).** Each person connects their own
 * Google or Microsoft calendar; owners also see who on the team is connected.
 */
export default function CalendarConnectionsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);
  return (
    <CalendarConnectionsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
