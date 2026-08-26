'use client';

import { use } from 'react';
import { RequestInboxScreen } from '../../../../components/screens/RequestInboxScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **REQ-01 Request inbox** — under `Work`, where the design artifact's breadcrumb puts it.
 *
 * `22-SCREEN-BY-SCREEN` §1 fixes the internal rail at eight destinations and Requests is not one
 * of them, so no rail item was added — the same restraint the client side showed.
 */
export default function RequestInboxPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <RequestInboxScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
