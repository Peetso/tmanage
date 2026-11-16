'use client';

import { use } from 'react';
import { PortalInvoiceScreen } from '../../../../../components/screens/portal-money/PortalInvoiceScreen';
import { FIXTURE_CLIENT_NAME, FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/** **Invoice** — one of the client's invoices, opened from Money (52-13, Figma 627:35648). */
export default function PortalInvoicePage({
  params,
}: {
  params: Promise<{ orgSlug: string; invoiceId: string }>;
}) {
  const { orgSlug, invoiceId } = use(params);

  return (
    <PortalInvoiceScreen
      organizationSlug={orgSlug}
      invoiceId={invoiceId}
      clientName={FIXTURE_CLIENT_NAME}
      providerName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
