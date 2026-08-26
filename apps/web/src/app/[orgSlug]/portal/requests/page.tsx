'use client';

import { use } from 'react';
import { ClientRequestsScreen } from '../../../../components/screens/ClientRequestsScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * The client's own requests.
 *
 * Not a screen either `22-SCREEN-BY-SCREEN` §6 or `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §9
 * gives an ID to; the design artifact's breadcrumb implies it and neither document's navigation
 * lists it. See the note on `ClientRequestsScreen` — the rail was deliberately left alone.
 */
export default function ClientRequestsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <ClientRequestsScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
