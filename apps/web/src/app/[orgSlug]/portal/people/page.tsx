'use client';

import { use } from 'react';
import { PlannedPortalScreen } from '../../../../components/screens/PlannedPortalScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **People** — the seventh destination on the client portal nav (`22-SCREEN-BY-SCREEN` §1).
 *
 * No ticket schedules a portal people screen and no endpoint returns the client-visible members
 * of a project, so this route names none. It resolves to the portal shell so the tab stays
 * reachable and named, and says the screen is not built.
 */
export default function PortalPeoplePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PlannedPortalScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
      activeNavigationId="people"
      title="People"
      description={`Who you are working with at ${FIXTURE_ORGANIZATION_NAME}.`}
    >
      People is named in the portal navigation but has no screen and no scheduled backlog ticket
      yet. This page keeps the tab reachable rather than answering it with a 404.
    </PlannedPortalScreen>
  );
}
