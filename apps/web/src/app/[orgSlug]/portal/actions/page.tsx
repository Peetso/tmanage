'use client';

import { use } from 'react';
import { ClientActionsScreen } from '../../../../components/screens/ClientActionsScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **CL-02 My Actions.**
 *
 * The same route shape as the overview, and the same two fixture names for the same reason.
 */
export default function ClientActionsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <ClientActionsScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
