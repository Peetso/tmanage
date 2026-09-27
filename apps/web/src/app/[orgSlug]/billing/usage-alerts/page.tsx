'use client';

import { use } from 'react';
import { UsageAlertsScreen } from '../../../../components/screens/UsageAlertsScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Usage alerts** — Billing & entitlements (module 19, x200).
 *
 * Under `[orgSlug]/billing/usage-alerts` (org-scoped, no project segment): the slug is the claim the
 * API's `TenantContextGuard` resolves against a membership row. The screen reads and writes
 * `…/billing/usage-alerts` (and reads `…/billing/usage-alerts/status`), gated on the server by
 * `org.manage`, so a member without the capability sees the API's refusal rather than a blank page. Not
 * on the internal rail (billing is not among the eight destinations), so this route names none — the
 * same choice the sibling `billing` storage-usage page made. The organization name is a fixture for
 * that page's reason: no endpoint returns the current organization's profile by slug.
 */
export default function UsageAlertsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <UsageAlertsScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
