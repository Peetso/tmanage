'use client';

import { use } from 'react';
import { BillingInvoicesScreen } from '../../../../components/screens/BillingInvoicesScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Invoices** — the billing invoice history (FEAT module 19, x179).
 *
 * Like the sibling billing route it is not one of the eight internal-rail destinations
 * (`22-SCREEN-BY-SCREEN` §1), so this route names none and adds no nav entry — it is reached
 * directly. The screen reads `GET /v1/organizations/:orgSlug/billing/invoices`, gated on
 * `org.manage`, so a caller without the capability sees the API's refusal rather than a blank page.
 */
export default function BillingInvoicesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <BillingInvoicesScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
