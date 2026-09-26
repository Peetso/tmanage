'use client';

import { use } from 'react';
import { RequestAgingScreen } from '../../../../../components/screens/RequestAgingScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Request aging** — module 11 (x154), the studio's overdue-to-triage / long-uncommitted read.
 *
 * Under `[orgSlug]/work/requests/aging`, a static segment beside the sibling `[requestId]` triage
 * detail (Next matches the static path first, so `aging` is never read as a request id). The screen
 * reads `GET …/client-requests/aging`, gated on `client_request.triage`, so a caller without it sees
 * the API's refusal rather than a blank page. Disjoint from the inbox/triage pages.
 */
export default function RequestAgingPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <RequestAgingScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
