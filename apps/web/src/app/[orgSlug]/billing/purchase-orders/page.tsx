'use client';

import { use } from 'react';
import { PurchaseOrdersView } from '../../../../components/screens/PurchaseOrdersView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Purchase orders** — Billing & entitlements (module 19, x282).
 *
 * Under `[orgSlug]/billing/purchase-orders` (org-scoped, no project segment): the slug is the claim the
 * API's `TenantContextGuard` resolves against a membership row. The screen reads and writes
 * `…/billing/purchase-orders`, gated on the server by `org.manage`, so a member without the capability
 * sees the API's refusal rather than a blank page. Not on the internal rail (billing is not among the
 * eight destinations), so this route names none — the same choice the sibling `billing/usage-alerts`
 * page made. The organization name is a fixture for that page's reason: no endpoint returns the current
 * organization's profile by slug.
 */
export default function PurchaseOrdersPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <PurchaseOrdersView organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
