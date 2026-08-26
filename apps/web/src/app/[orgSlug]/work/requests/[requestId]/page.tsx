'use client';

import { use } from 'react';
import { RequestTriageScreen } from '../../../../../components/screens/RequestTriageScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **REQ-02 Request detail / triage**, with **REQ-03 Commitment review** as its second step.
 *
 * Both identifiers come from the path. The request id is not a credential: the API answers 404
 * for a request in another tenant exactly as it does for one that does not exist.
 */
export default function RequestTriagePage({
  params,
}: {
  params: Promise<{ orgSlug: string; requestId: string }>;
}) {
  const { orgSlug, requestId } = use(params);

  return (
    <RequestTriageScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      clientRequestId={requestId}
    />
  );
}
