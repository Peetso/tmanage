'use client';

import { use } from 'react';
import { PlannedPortalScreen } from '../../../../components/screens/PlannedPortalScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Deliverables** — the third destination on the client portal nav (`22-SCREEN-BY-SCREEN` §1).
 *
 * The client's deliverables are the allowlisted projection `PUB-001` builds from the internal
 * deliverable record; that projection does not exist yet, so this route names `PUB-001` and
 * shows no deliverables rather than reusing the internal work-item list, which would leak the
 * internal view the projection exists to withhold.
 */
export default function PortalDeliverablesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <PlannedPortalScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
      activeNavigationId="deliverables"
      title="Deliverables"
      description={`What ${FIXTURE_ORGANIZATION_NAME} has delivered to you.`}
      ticket="PUB-001"
    >
      Deliverables is the client-safe projection of what has been delivered. It is not built yet;
      until it is, this tab opens here rather than answering with a 404.
    </PlannedPortalScreen>
  );
}
