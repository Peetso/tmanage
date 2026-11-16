'use client';

import { use } from 'react';
import { PortalMoneyScreen } from '../../../../components/screens/portal-money/PortalMoneyScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/** **Money** — the client's invoices, retainer and budget use (52-13, Figma 627:35481). */
export default function PortalMoneyPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PortalMoneyScreen
      organizationSlug={orgSlug}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
