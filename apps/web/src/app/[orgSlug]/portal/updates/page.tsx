'use client';

import { use } from 'react';
import { PortalUpdatesScreen } from '../../../../components/screens/PortalUpdatesScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **CL-11 Updates** — the fifth destination on the client portal nav (`22-SCREEN-BY-SCREEN` §1).
 *
 * The studio's written updates on the client's project — the published rows `listPortalUpdates`
 * returns (CL-03), drawn as the handoff's CL-11 "written narrative, not an activity log". The
 * notification feed (`NOTIF-001`) is a different projection and stays at `/portal/inbox`.
 */
export default function PortalUpdatesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PortalUpdatesScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
