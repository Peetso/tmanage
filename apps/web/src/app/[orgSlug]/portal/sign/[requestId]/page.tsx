'use client';

import { use } from 'react';
import { PortalSignScreen } from '../../../../../components/screens/esign/PortalSignScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/** **52-26 Sign a document** — the client signs one request addressed to them. */
export default function PortalSignPage({
  params,
}: {
  params: Promise<{ orgSlug: string; requestId: string }>;
}) {
  const { orgSlug, requestId } = use(params);

  return (
    <PortalSignScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
      requestId={requestId}
    />
  );
}
