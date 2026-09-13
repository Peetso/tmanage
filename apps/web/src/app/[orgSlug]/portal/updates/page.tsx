'use client';

import { use } from 'react';
import { PlannedPortalScreen } from '../../../../components/screens/PlannedPortalScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Updates** — the fifth destination on the client portal nav (`22-SCREEN-BY-SCREEN` §1).
 *
 * The client's updates feed is `NOTIF-001`'s notification record and bundling, which is not
 * built; this route names it. The portal already answers `/portal/inbox` from a separate
 * projection, and this destination is deliberately not made an alias of it — an unbuilt tab
 * that says so is more honest than one quietly pointed at a different screen.
 */
export default function PortalUpdatesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PlannedPortalScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
      activeNavigationId="updates"
      title="Updates"
      description={`Recent activity from ${FIXTURE_ORGANIZATION_NAME}.`}
      ticket="NOTIF-001"
    >
      Updates is the client-facing feed of notifications. It is not built yet; until it is, this tab
      opens here rather than answering with a 404.
    </PlannedPortalScreen>
  );
}
