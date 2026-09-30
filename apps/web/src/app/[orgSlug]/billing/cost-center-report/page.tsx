'use client';

import { use } from 'react';
import { CostCenterReportView } from '../../../../components/screens/CostCenterReportView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Spend by cost center** — Billing & entitlements (module 19, x331).
 *
 * Under `[orgSlug]/billing/cost-center-report` (org-scoped, no project segment): the slug is the claim
 * the API's `TenantContextGuard` resolves against a membership row. The screen reads
 * `…/billing/cost-center-report`, gated on the server by `org.manage`, so a member without the
 * capability sees the API's refusal rather than a blank page. Not on the internal rail (billing is not
 * among the eight destinations), so this route names none — the same choice the sibling billing pages
 * made. The organization name is a fixture for that page's reason: no endpoint returns the current
 * organization's profile by slug.
 */
export default function CostCenterReportPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <CostCenterReportView organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
