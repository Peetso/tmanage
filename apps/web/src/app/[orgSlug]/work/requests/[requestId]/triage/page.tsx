'use client';

import { use } from 'react';
import { RequestTriagePanelScreen } from '../../../../../../components/screens/RequestTriagePanelScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../../lib/fixtures';

/**
 * **Request triage** — module 11 (x265), the studio's internal triage panel for one request
 * (category + assignee), under `[orgSlug]/work/requests/[requestId]/triage`.
 *
 * Both identifiers come from the path. The request id is not a credential: the API answers 404 for a
 * request in another tenant exactly as it does for one that does not exist, and both routes are gated
 * on `client_request.triage`, so a caller without it sees the API's refusal rather than a blank page.
 */
export default function RequestTriagePanelPage({
  params,
}: {
  params: Promise<{ orgSlug: string; requestId: string }>;
}) {
  const { orgSlug, requestId } = use(params);

  return (
    <RequestTriagePanelScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      clientRequestId={requestId}
    />
  );
}
