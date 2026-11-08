'use client';

import { use } from 'react';
import { InvoiceEditorScreen } from '../../../../../components/screens/finance/InvoiceEditorScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../lib/fixtures';

/**
 * **New invoice** — a client invoice draft: client, currency, dates, lines and live totals (52-09).
 * Saves with `POST …/client-invoices` and `PUT …/:id` on `finance.manage`.
 */
export default function FinanceInvoiceNewPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <InvoiceEditorScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      invoiceId={null}
    />
  );
}
