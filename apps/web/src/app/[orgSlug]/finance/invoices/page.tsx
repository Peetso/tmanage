'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { InvoiceListScreen } from '../../../../components/screens/finance/InvoiceListScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Invoices** — the client invoice list with aging (A10b). Not on the internal rail; reached from the finance home and the
 * finance tabs. The API enforces each capability, so a caller without it sees the refusal. `?client=`
 * narrows it to one client company (D6, the client page's Invoices tab).
 */
export default function FinanceInvoicesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);
  const client = useSearchParams().get('client');

  return (
    <InvoiceListScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      {...(client === null ? {} : { clientOrganizationId: client })}
    />
  );
}
