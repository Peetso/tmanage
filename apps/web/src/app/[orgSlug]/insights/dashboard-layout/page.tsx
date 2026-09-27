'use client';

import { use } from 'react';
import { InsightDashboardLayoutScreen } from '../../../../components/screens/InsightDashboardLayoutScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/**
 * **Insight dashboard layout** (module 16 Insights, x302).
 *
 * Under `[orgSlug]/insights/dashboard-layout`, matching the API route shape: the slug in the path is
 * the claim the API's `TenantContextGuard` resolves against a membership row. The screen reads and
 * writes `…/insights/dashboard-layout`, gated on `work.read`, so a caller without it sees the API's
 * refusal rather than a blank page. The organization name is still a fixture, for the sibling
 * insights pages' reason: no endpoint returns the current organization's profile by slug.
 */
export default function InsightDashboardLayoutPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = use(params);

  return (
    <InsightDashboardLayoutScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
    />
  );
}
