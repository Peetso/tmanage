'use client';

import { use } from 'react';
import { StorageUsageScreen } from '../../../components/screens/StorageUsageScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/**
 * **Storage usage** — the billing screen from `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY` §8.
 *
 * It is not on the internal rail (`22-SCREEN-BY-SCREEN` §1 fixes that at eight destinations and
 * billing is not among them), so this route names none and no nav entry is added — the same
 * choice `work/requests` made. The screen reads `GET /v1/organizations/:orgSlug/usage`, which is
 * gated on `org.manage`, so a member without it sees the API's refusal rather than a blank page.
 */
export default function BillingPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <StorageUsageScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
