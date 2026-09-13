'use client';

import { use } from 'react';
import { PlannedPortalScreen } from '../../../../components/screens/PlannedPortalScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Timeline** — the fourth destination on the client portal nav (`22-SCREEN-BY-SCREEN` §1).
 *
 * No ticket schedules a portal timeline screen, so this route names none. It resolves to the
 * portal shell so the tab stays reachable and named, and says the screen is not built.
 */
export default function PortalTimelinePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PlannedPortalScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
      activeNavigationId="timeline"
      title="Timeline"
      description="When things are committed and forecast."
    >
      Timeline is named in the portal navigation but has no screen and no scheduled backlog ticket
      yet. This page keeps the tab reachable rather than answering it with a 404.
    </PlannedPortalScreen>
  );
}
