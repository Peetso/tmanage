'use client';

import { use } from 'react';
import { ClientRequestDetailScreen } from '../../../../../components/screens/ClientRequestDetailScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **CL-10 Request detail** — the second half of `22-SCREEN-BY-SCREEN` §6's `CL-06`.
 *
 * The request id is in the path and is not a credential: the API answers 404 for a request
 * belonging to another client organization exactly as it does for one that does not exist, which
 * `req-001-client-requests.db.test.ts` proves from Meridian's side.
 */
export default function ClientRequestPage({
  params,
}: {
  params: Promise<{ orgSlug: string; requestId: string }>;
}) {
  const { orgSlug, requestId } = use(params);

  return (
    <ClientRequestDetailScreen
      organizationSlug={orgSlug}
      requestId={requestId}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
