'use client';

import { use } from 'react';
import { ClientPortalDeliverablesScreen } from '../../../../components/screens/ClientPortalDeliverablesScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **CL-03 Deliverables** — the third destination on the client portal nav (`22-SCREEN-BY-SCREEN` §1).
 *
 * The client's deliverables are the allowlisted x97 projection each `deliverable.publish` freezes
 * (`12-PERMISSION-MATRIX` §1), read through `client_projection.read` and never the internal
 * record. x114 built that read, so this route now renders it rather than the planned placeholder.
 *
 * Two names are still fixtures — the client organization's own name and the studio's — the same
 * `ON-04` gap `ClientOverviewScreen` records; the deliverables on the screen are real.
 */
export default function PortalDeliverablesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <ClientPortalDeliverablesScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
