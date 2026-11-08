'use client';

import { use } from 'react';
import { InvoiceEditorScreen } from '../../../../../../components/screens/finance/InvoiceEditorScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../../lib/fixtures';

/**
 * **Edit draft** — one draft client invoice: dates, lines, approved work brought in, live totals
 * (52-09). Saves with `PUT …/client-invoices/:invoiceId` on `finance.manage`; an issued invoice
 * opens read-only.
 */
export default function FinanceInvoiceEditPage({
  params,
}: {
  params: Promise<{ orgSlug: string; invoiceId: string }>;
}) {
  const { orgSlug, invoiceId } = use(params);

  return (
    <InvoiceEditorScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      invoiceId={invoiceId}
    />
  );
}
