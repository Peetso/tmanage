'use client';

import { use } from 'react';
import { InvoiceLineItemsScreen } from '../../../../../../components/screens/InvoiceLineItemsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../../../lib/fixtures';

/**
 * **Invoice line items** — one invoice's line breakdown (FEAT module 19, x225).
 *
 * Like the sibling billing routes it is not one of the eight internal-rail destinations
 * (`22-SCREEN-BY-SCREEN` §1), so this route names none and adds no nav entry — it is reached from an
 * invoice. The screen reads `GET /v1/organizations/:orgSlug/billing/invoices/:invoiceId/lines`, gated
 * on `org.manage`, so a caller without the capability sees the API's refusal rather than a blank
 * page, and an unknown or cross-tenant invoice id is a 404.
 */
export default function InvoiceLineItemsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; invoiceId: string }>;
}) {
  const { orgSlug, invoiceId } = use(params);

  return (
    <InvoiceLineItemsScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      invoiceId={invoiceId}
    />
  );
}
