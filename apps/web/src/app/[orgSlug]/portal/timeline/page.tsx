'use client';

import { use } from 'react';
import { PortalMilestonesScreen } from '../../../../components/screens/PortalMilestonesScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Timeline** — the fourth destination on the client portal nav (`22-SCREEN-BY-SCREEN` §1).
 *
 * SEC / Portal milestones (x139) fills the milestone half of the timeline: the published
 * milestones for the client's project, in date order, from a projection that carries no staff
 * identity. Risks and a fuller committed/forecast timeline are later slices (NEXT-SCOPES-13).
 */
export default function PortalTimelinePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PortalMilestonesScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
