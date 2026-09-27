'use client';

import { use } from 'react';
import { BillingProfileScreen } from '../../../../components/screens/BillingProfileScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Billing settings (module 19, x180).**
 *
 * The billing-profile screen for the Billing module. A sibling route to `billing/` (storage usage),
 * so neither slice touches the other's page. Not on the internal rail (`22-SCREEN-BY-SCREEN` §1),
 * so this route names no nav entry. The organization name is still a fixture, for `BillingPage`'s
 * reason: no endpoint returns the current organization's profile by slug. The screen reads
 * `GET /v1/organizations/:orgSlug/billing/profile`, gated on `org.manage`, so a member without it
 * sees the API's refusal rather than a blank page.
 */
export default function BillingSettingsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <BillingProfileScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
