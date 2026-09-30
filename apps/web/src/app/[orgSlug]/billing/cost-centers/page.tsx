'use client';

import { use } from 'react';
import { CostCentersView } from '../../../../components/screens/CostCentersView';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Cost centers** — Billing & entitlements (module 19, x281).
 *
 * Under `[orgSlug]/billing/cost-centers` (org-scoped, no project segment): the slug is the claim the
 * API's `TenantContextGuard` resolves against a membership row. The screen reads and writes
 * `…/billing/cost-centers` (and its `…/:id/projects/:projectId` sub-routes), gated on the server by
 * `org.manage`, so a member without the capability sees the API's refusal rather than a blank page. Not
 * on the internal rail (billing is not among the eight destinations), so this route names none — the
 * same choice the sibling billing pages made. The organization name is a fixture for that page's
 * reason: no endpoint returns the current organization's profile by slug.
 */
export default function CostCentersPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <CostCentersView organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
