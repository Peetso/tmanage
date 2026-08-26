'use client';

import { use } from 'react';
import { ClientOverviewScreen } from '../../../components/screens/ClientOverviewScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **CL-01 Client Overview.**
 *
 * Under `[orgSlug]/portal`. The slug names the *service* organization — the studio — and the
 * client organization comes from the session: a client member's `TenantContext` is resolved
 * from `client_memberships`, so the API already knows which client is asking and this route
 * has no need to say.
 *
 * Two names are still fixtures. Nothing returns the client organization's own name to its own
 * members, and nothing returns the service organization's; both are the same gap `ON-04`'s
 * domain fixture records, and both are cosmetic — the data on the screen is real.
 */
export default function ClientPortalPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <ClientOverviewScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
