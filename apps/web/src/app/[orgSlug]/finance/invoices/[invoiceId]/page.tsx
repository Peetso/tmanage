'use client';

import { use } from 'react';
import { InvoiceDetailScreen } from '../../../../../components/screens/finance/InvoiceDetailScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **Invoice** — one client invoice: lines, totals, payments and credit notes (A10b). Reads
 * `GET …/client-invoices/:invoiceId` on `finance.view`.
 */
export default function FinanceInvoicePage({
  params,
}: {
  params: Promise<{ orgSlug: string; invoiceId: string }>;
}) {
  const { orgSlug, invoiceId } = use(params);

  return (
    <InvoiceDetailScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      invoiceId={invoiceId}
    />
  );
}
